const { z } = require("zod");
const mongoose = require("mongoose");
const Order = require("../models/Order");
const Offer = require("../models/Offer");
const Chat = require("../models/Chat");
const Zone = require("../models/Zone");
const City = require("../models/City");
const Membership = require("../models/Membership");
const DriverProfile = require("../models/DriverProfile");
const Message = require("../models/Message");
const User = require("../models/User");
const Rating = require("../models/Rating");
const ApiError = require("../utilities/errors");
const catchAsyncError = require("../utilities/catchAsyncError");
const { validateBody } = require("../utilities/catchAsyncError");
const { regionAdminCityIds } = require("../utilities/rbac");
const { normalizePhone } = require("../utilities/phone");
const { transition, assignAtomically } = require("../services/orderService");
const {
  toPassengerView,
  toDriverView,
  toDispatcherView,
} = require("../utilities/orderViews");
const { emitOrderEvents } = require("../utilities/sockets");
const pushService = require("../utilities/pushService");
const botDispatcher = require("../services/botDispatcher");

const createOrderSchema = z
  .object({
    cityId: z.string().min(1, "Не указан город"),
    // Маршрут одной строкой произвольного ввода (упрощение концепции 1.6)
    route: z
      .string()
      .trim()
      .min(1, "Укажите маршрут")
      .max(300, "Маршрут слишком длинный"),
    pax: z.number().int().min(1, "Минимум 1 пассажир").max(8).default(1),
    notes: z.string().trim().max(500).optional(),
    whenType: z.enum(["now", "scheduled"]).default("now"),
    whenAt: z.string().datetime({ offset: true }).optional(),
    matchMode: z.enum(["offers", "first_take", "dispatcher"]).optional(),
    targetDriverId: z.string().optional(),
    chatId: z.string().optional(),
    // Contact phone for this order; saved to the account so the dispatcher can
    // call the passenger on SOS even when the app is closed
    phone: z.string().trim().max(30).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.whenType === "scheduled" && !data.whenAt)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Укажите время поездки",
        path: ["whenAt"],
      });
  });

const offerSchema = z.object({
  priceText: z.string().trim().min(1, "Укажите цену").max(50, "Слишком длинная цена"),
  etaMin: z
    .number()
    .int()
    .min(1, "Укажите время подачи")
    .max(180, "Время подачи не больше 180 минут"),
});

const acceptSchema = z.object({
  offerId: z.string().optional(),
});

const assignSchema = z.object({
  membershipId: z.string().min(1, "Укажите водителя"),
});

const actionSchema = z.object({
  action: z.enum(["arrive", "wait", "start", "finish", "no_show", "undo_start"]),
});

const cancelSchema = z.object({
  reason: z.string().trim().min(1, "Укажите причину отмены").max(300),
});

const disputeSchema = z.object({
  reason: z.string().trim().min(1, "Опишите проблему").max(300),
});

exports.createOrderSchema = createOrderSchema;
exports.offerSchema = offerSchema;
exports.acceptSchema = acceptSchema;
exports.assignSchema = assignSchema;
exports.actionSchema = actionSchema;
exports.cancelSchema = cancelSchema;
exports.disputeSchema = disputeSchema;

const resolveDisputeSchema = z.object({
  outcome: z.enum(["complete", "cancel"], {
    errorMap: () => ({ message: "Исход спора: complete или cancel" }),
  }),
  reason: z.string().trim().max(300).optional(),
});
exports.resolveDisputeSchema = resolveDisputeSchema;

// A dispatcher of the order city, a region admin of its region or superadmin
const canManageOrderCity = async (req, order) => {
  const isCityDispatcher = (req.memberships ?? []).some(
    (item) =>
      item.role === "dispatcher" &&
      item.status === "ACTIVE" &&
      String(item.cityId?._id ?? item.cityId) === String(order.cityId)
  );
  if (isCityDispatcher) return true;
  const regionCityIds = await regionAdminCityIds(req);
  return regionCityIds === null || regionCityIds.includes(String(order.cityId));
};

// DriverProfile is keyed by membership; resolve it through the membership
const driverProfileForOrder = async (order) => {
  if (!order.driverId) return null;
  const membership = await Membership.findOne({ userId: order.driverId, role: "driver" });
  if (!membership) return null;
  return DriverProfile.findOne({ membershipId: membership._id });
};

// serializeOrderFor(order, req, cache) — cache optionally carries preloaded
// driver profiles and passenger users so list endpoints avoid N+1 queries
const serializeOrderFor = async (order, req, cache = null) => {
  const viewerId = String(req.user._id);
  // Полный «диспетчерский» вид получают диспетчер города и админ региона
  const isDispatcher =
    (req.memberships ?? []).some(
      (item) =>
        item.role === "dispatcher" &&
        item.status === "ACTIVE" &&
        String(item.cityId?._id ?? item.cityId) === String(order.cityId)
    ) ||
    req.user.isSuperadmin === true ||
    (await regionAdminCityIds(req))?.includes(String(order.cityId)) === true;

  const driverProfile = cache
    ? (cache.profileByUser.get(String(order.driverId)) ?? null)
    : await driverProfileForOrder(order);
  const passengerUser = cache
    ? (cache.passengerById.get(String(order.passengerId)) ?? null)
    : await User.findById(order.passengerId).select("name phone");

  if (String(order.passengerId) === viewerId) {
    return toPassengerView(order, { driverProfile });
  }
  if (isDispatcher) {
    return toDispatcherView(order, { driverProfile, passenger: passengerUser });
  }
  return toDriverView(order, { viewerId, passenger: passengerUser });
};

// POST /api/orders
exports.createOrder = [
  validateBody(createOrderSchema),
  catchAsyncError(async (req, res) => {
    const data = req.body;

    const city = await City.findById(data.cityId);
    if (!city) throw new ApiError(404, "Город не найден");
    if (!["PILOT", "ACTIVE"].includes(city.status))
      throw new ApiError(403, "В вашем городе заказы ещё не открыты");

    const passengerMembership = (req.memberships ?? []).find(
      (item) =>
        item.role === "passenger" &&
        item.status === "ACTIVE" &&
        String(item.cityId?._id ?? item.cityId) === String(data.cityId)
    );
    if (!passengerMembership)
      throw new ApiError(403, "Вы не пассажир этого города");

    const matchMode = data.matchMode ?? city.settings?.matchMode ?? "offers";

    // Direct order placed after a call to a free driver (concept 1.6)
    let directContext = null;
    if (data.targetDriverId) {
      if (city.settings?.directCallsEnabled === false)
        throw new ApiError(403, "Прямые вызовы водителей отключены в этом городе");

      const targetMembership = await Membership.findOne({
        userId: data.targetDriverId,
        cityId: data.cityId,
        role: "driver",
        status: "ACTIVE",
      });
      if (!targetMembership)
        throw new ApiError(400, "Целевой водитель не найден в этом городе");

      const targetProfile = await DriverProfile.findOne({
        membershipId: targetMembership._id,
      });
      if (data.whenType === "now" && (!targetProfile || targetProfile.shift !== "online"))
        throw new ApiError(409, "Водитель сейчас не на линии");
      if (data.whenType === "now") {
        const busy = await Order.exists({
          driverId: data.targetDriverId,
          status: { $in: ["ASSIGNED", "ARRIVING", "WAITING", "IN_RIDE"] },
        });
        if (busy) throw new ApiError(409, "У водителя уже есть активный заказ");
      }

      directContext = { targetMembership, targetProfile };
    }

    // Contact phone: save it to the account so the dispatcher can call the
    // passenger on SOS even when the app was closed since
    if (data.phone) {
      const normalizedPhone = normalizePhone(data.phone);
      if (!normalizedPhone)
        throw new ApiError(400, "Телефон укажите в формате +7 902 111-22-33");
      if (req.user.phone !== normalizedPhone) {
        req.user.phone = normalizedPhone;
        await User.findByIdAndUpdate(req.user._id, { phone: normalizedPhone });
      }
    }

    let order = await Order.create({
      passengerId: req.user._id,
      cityId: data.cityId,
      // Маршрут одной строкой; зоны не используются
      from: { text: data.route },
      when: { type: data.whenType, ...(data.whenAt && { at: new Date(data.whenAt) }) },
      pax: data.pax,
      ...(data.notes && { notes: data.notes }),
      matchMode: data.targetDriverId ? "offers" : matchMode,
      ...(data.targetDriverId && {
        mode: "direct",
        targetDriverId: data.targetDriverId,
      }),
    });

    // Direct orders reuse the existing direct chat as the order chat; the
    // previous conversation and call log stay in place (concept 1.6)
    let chat;
    if (directContext && data.chatId) {
      chat = await Chat.findById(data.chatId);
      if (
        !chat ||
        !chat.members.some((member) => String(member) === String(req.user._id)) ||
        !chat.members.some((member) => String(member) === String(data.targetDriverId))
      ) {
        throw new ApiError(400, "Чат не найден между пассажиром и водителем");
      }
      // Only one active order per dialog
      if (chat.orderId) {
        const previous = await Order.findById(chat.orderId).select("status");
        const TERMINAL = ["COMPLETED", "CANCELLED", "NO_SHOW", "EXPIRED"];
        if (previous && !TERMINAL.includes(previous.status)) {
          throw new ApiError(409, "В этом диалоге уже есть активный заказ");
        }
      }
      chat.type = "order";
      chat.orderId = order._id;
      await chat.save();
    } else {
      chat = await Chat.create({
        type: "order",
        cityId: data.cityId,
        orderId: order._id,
        // Direct orders include the target driver from the start
        members: [req.user._id, ...(directContext ? [data.targetDriverId] : [])],
      });
    }
    order.chatId = chat._id;

    const actor = { userId: req.user._id, role: "passenger" };
    // Предзаказы публикуются сразу и видны водителям (можно забронировать);
    // бронь не занимает водителя до наступления времени
    const isDeferredBroadcast = false;

    let events = [];
    if (!isDeferredBroadcast) {
      ({ order, events } = await transition(order, "publish", actor));

      const timeoutSeconds =
        directContext
          ? (city.settings?.directOrderTimeoutMin ?? 10) * 60
          : (city.settings?.cascadeTimeouts?.expire ?? 600);
      // Для заказов «на время» срок публикации не ограничен коротким окном
      order.expiresAt =
        data.whenType === "scheduled"
          ? new Date(new Date(order.when.at).getTime() + 60 * 60 * 1000)
          : new Date(Date.now() + timeoutSeconds * 1000);
    }
    await order.save();
    await botDispatcher.upsertOrderCard(order);

    // Cascade fan-out, expiry and preorder timers (concept 1.6 / 1.14)
    const { scheduleOrderJobs } = require("../jobs/index");
    await scheduleOrderJobs(order);

    // Direct orders go to the target driver only; broadcast orders fan out
    // to the city (zones are no longer used). Scheduled orders are activated
    // by the preorder job before the ride instead.
    if (order.mode !== "direct" && data.whenType !== "scheduled") {
      events.push(
        { room: `city:${data.cityId}`, event: "order:new", payload: { orderId: order._id } }
      );
      // Push to on-the-go drivers (excluding the creator) after the emits
      void pushService
        .notifyNewOrder(order, { excludeUserId: req.user._id })
        .catch(() => undefined);
    }
    emitOrderEvents(events);

    res.status(201).json({
      status: "success",
      data: { order: await serializeOrderFor(order, req) },
    });
  }),
];

// GET /api/orders?cityId=&status=
// Passenger: own orders; driver: cards of his zones; dispatcher: city queue
exports.listOrders = catchAsyncError(async (req, res) => {
  const { cityId, status } = req.query;
  if (!cityId) throw new ApiError(400, "Не указан город");

  const statusFilter = status ? { status } : {};

  const driverMembership = (req.memberships ?? []).find(
    (item) =>
      item.role === "driver" &&
      item.status === "ACTIVE" &&
      String(item.cityId?._id ?? item.cityId) === String(cityId)
  );
  const dispatcherMembership = (req.memberships ?? []).find(
    (item) =>
      item.role === "dispatcher" &&
      item.status === "ACTIVE" &&
      String(item.cityId?._id ?? item.cityId) === String(cityId)
  );

  let orders;

  if (driverMembership) {
    // Лента водителя: заказы его города, доступные для отклика/брони,
    // плюс его собственные заказы и брони
    const zoneIds = driverMembership.zones ?? [];
    const feedClauses = [
      { driverId: req.user._id },
      { targetDriverId: req.user._id },
      { status: "PUBLISHED", mode: "broadcast" },
    ];
    if (zoneIds.length > 0) {
      feedClauses.push({ fromZone: { $in: zoneIds }, status: "PUBLISHED" });
    }
    orders = await Order.find({
      cityId,
      ...statusFilter,
      $or: feedClauses,
    })
      .sort({ createdAt: -1 })
      .limit(100);
  } else if (dispatcherMembership || req.user.isSuperadmin) {
    orders = await Order.find({ cityId, ...statusFilter })
      .sort({ createdAt: -1 })
      .limit(200);
  } else if ((await regionAdminCityIds(req))?.includes(String(cityId))) {
    // Админ региона видит все заказы своего региона
    orders = await Order.find({ cityId, ...statusFilter })
      .sort({ createdAt: -1 })
      .limit(200);
  } else {
    orders = await Order.find({ cityId, passengerId: req.user._id, ...statusFilter })
      .sort({ createdAt: -1 })
      .limit(100);
  }

  // Preload driver profiles and passenger names once for the whole list
  const driverUserIds = [
    ...new Set(
      orders
        .map((order) => order.driverId)
        .filter(Boolean)
        .map(String)
    ),
  ];
  const driverMemberships = await Membership.find({
    userId: { $in: driverUserIds },
    role: "driver",
  }).select("_id userId");
  const driverProfiles = await DriverProfile.find({
    membershipId: { $in: driverMemberships.map((membership) => membership._id) },
  });
  const profileByUser = new Map();
  for (const membership of driverMemberships) {
    const profile = driverProfiles.find(
      (item) => String(item.membershipId) === String(membership._id)
    );
    if (profile) profileByUser.set(String(membership.userId), profile);
  }
  const passengerUsers = await User.find({
    _id: { $in: [...new Set(orders.map((order) => String(order.passengerId)))] },
  }).select("_id name phone");
  const passengerById = new Map(
    passengerUsers.map((user) => [String(user._id), user])
  );
  const cache = { profileByUser, passengerById };

  const serialized = [];
  for (const order of orders) {
    serialized.push(await serializeOrderFor(order, req, cache));
  }

  // The viewer's own offer per order: the driver UI shows "Отклик отправлен"
  // and blocks a second offer until the passenger answers
  const ownOffers = await Offer.find({
    orderId: { $in: orders.map((order) => order._id) },
    driverId: req.user._id,
  }).select("orderId priceText etaMin status");
  const offerByOrder = new Map(
    ownOffers.map((offer) => [
      String(offer.orderId),
      { id: String(offer._id), priceText: offer.priceText, etaMin: offer.etaMin, status: offer.status },
    ])
  );
  for (const view of serialized) {
    view.myOffer = offerByOrder.get(String(view._id)) ?? null;
  }

  // Unread human messages per order chat for the current viewer
  const chatIdList = orders
    .filter((order) => order.chatId)
    .map((order) => order.chatId);
  if (chatIdList.length > 0) {
    const unreadAgg = await Message.aggregate([
      {
        $match: {
          chatId: { $in: chatIdList },
          senderType: "user",
          senderId: { $ne: req.user._id },
          readBy: { $ne: req.user._id },
        },
      },
      { $group: { _id: "$chatId", count: { $sum: 1 } } },
    ]);
    const unreadByChat = new Map(
      unreadAgg.map((entry) => [String(entry._id), entry.count])
    );
    for (const view of serialized) {
      view.unreadCount = unreadByChat.get(String(view.chatId)) ?? 0;
    }
  }

  res.json({ status: "success", data: { orders: serialized } });
});

// POST /api/orders/:id/read — mark all messages of the order chat as read
exports.markOrderRead = catchAsyncError(async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) throw new ApiError(404, "Заказ не найден");

  const isParticipant =
    String(order.passengerId) === String(req.user._id) ||
    (order.driverId && String(order.driverId) === String(req.user._id));
  if (!isParticipant) throw new ApiError(403, "Вы не участник заказа");

  const result = await Message.updateMany(
    {
      chatId: order.chatId,
      senderType: "user",
      senderId: { $ne: req.user._id },
      readBy: { $ne: req.user._id },
    },
    { $addToSet: { readBy: req.user._id } }
  );

  res.json({
    status: "success",
    data: { marked: result.modifiedCount ?? 0 },
  });
});

// GET /api/orders/:id — participant views only, serialized per role
exports.getOrder = catchAsyncError(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) throw new ApiError(400, "Некорректный идентификатор заказа");

  const order = await Order.findById(id);
  if (!order) throw new ApiError(404, "Заказ не найден");

  const viewerId = String(req.user._id);
  const isParticipant =
    String(order.passengerId) === viewerId || String(order.driverId) === viewerId;
  const isDispatcher =
    (req.memberships ?? []).some(
      (item) =>
        item.role === "dispatcher" &&
        item.status === "ACTIVE" &&
        String(item.cityId?._id ?? item.cityId) === String(order.cityId)
    ) || req.user.isSuperadmin === true;
  const isPotentialDriver = (req.memberships ?? []).some(
    (item) =>
      item.role === "driver" &&
      item.status === "ACTIVE" &&
      String(item.cityId?._id ?? item.cityId) === String(order.cityId)
  );
  const isRegionAdmin = (await regionAdminCityIds(req))?.includes(String(order.cityId));

  if (!isParticipant && !isDispatcher && !isPotentialDriver && !isRegionAdmin)
    throw new ApiError(403, "Нет доступа к этому заказу");

  const orderView = await serializeOrderFor(order, req);

  if (isParticipant && order.chatId) {
    const unreadAgg = await Message.aggregate([
      {
        $match: {
          chatId: order.chatId,
          senderType: "user",
          senderId: { $ne: req.user._id },
          readBy: { $ne: req.user._id },
        },
      },
      { $group: { _id: "$chatId", count: { $sum: 1 } } },
    ]);
    orderView.unreadCount = unreadAgg[0]?.count ?? 0;
  }

  // Lets the client hide the stars once this participant has rated the trip
  // (otherwise reopening the chat offers a second rating that fails with 409)
  if (isParticipant && order.status === "COMPLETED") {
    const mine = await Rating.findOne({ orderId: order._id, fromUserId: req.user._id }).select("stars");
    orderView.myRating = mine ? mine.stars : null;
  }

  res.json({
    status: "success",
    data: { order: orderView },
  });
});

// POST /api/orders/:id/action — driver lifecycle buttons
exports.orderAction = [
  validateBody(actionSchema),
  catchAsyncError(async (req, res) => {
    const order = await Order.findById(req.params.id);
    if (!order) throw new ApiError(404, "Заказ не найден");

    const actor = { userId: req.user._id, role: "driver" };
    const { order: updatedOrder, events } = await transition(order, req.body.action, actor);
    emitOrderEvents(events);

    res.json({
      status: "success",
      data: { order: await serializeOrderFor(updatedOrder, req) },
    });
  }),
];

// POST /api/orders/:id/cancel — any participant with a mandatory reason
exports.cancelOrder = [
  validateBody(cancelSchema),
  catchAsyncError(async (req, res) => {
    const order = await Order.findById(req.params.id);
    if (!order) throw new ApiError(404, "Заказ не найден");

    // Роль отменяющего: пассажир/водитель заказа, либо диспетчер города /
    // админ региона — у них полный доступ к заказам своего города и региона
    const viewerId = String(req.user._id);
    const isDispatcher =
      (req.memberships ?? []).some(
        (item) =>
          item.role === "dispatcher" &&
          item.status === "ACTIVE" &&
          String(item.cityId?._id ?? item.cityId) === String(order.cityId)
      );
    const isRegionAdmin = (await regionAdminCityIds(req))?.includes(String(order.cityId));
    const role =
      String(order.passengerId) === viewerId
        ? "passenger"
        : String(order.driverId) === viewerId
          ? "driver"
          : isDispatcher || isRegionAdmin
            ? "dispatcher"
            : "passenger";
    const actor = { userId: req.user._id, role };
    const { order: updatedOrder, events } = await transition(order, "cancel", actor, { reason: req.body.reason });
    emitOrderEvents(events);

    res.json({
      status: "success",
      data: { order: await serializeOrderFor(updatedOrder, req) },
    });
  }),
];

// POST /api/orders/:id/dispute — dispatcher joins the chat
exports.openDispute = [
  validateBody(disputeSchema),
  catchAsyncError(async (req, res) => {
    const order = await Order.findById(req.params.id);
    if (!order) throw new ApiError(404, "Заказ не найден");

    const role = String(order.passengerId) === String(req.user._id) ? "passenger" : "driver";
    const actor = { userId: req.user._id, role };
    const { order: updatedOrder, events } = await transition(order, "dispute", actor, { reason: req.body.reason });
    emitOrderEvents(events);

    res.json({
      status: "success",
      data: { order: await serializeOrderFor(updatedOrder, req) },
    });
  }),
];

// POST /api/orders/:id/resolve — a dispatcher closes a dispute
exports.resolveDispute = [
  validateBody(resolveDisputeSchema),
  catchAsyncError(async (req, res) => {
    const order = await Order.findById(req.params.id);
    if (!order) throw new ApiError(404, "Заказ не найден");
    if (!(await canManageOrderCity(req, order)))
      throw new ApiError(403, "Закрыть спор может только диспетчер города");

    const event = req.body.outcome === "complete" ? "resolve_complete" : "resolve_cancel";
    const actor = { userId: req.user._id, role: "dispatcher" };
    const { order: updatedOrder, events } = await transition(order, event, actor, { reason: req.body.reason });
    emitOrderEvents(events);

    res.json({
      status: "success",
      data: { order: await serializeOrderFor(updatedOrder, req) },
    });
  }),
];

// POST /api/orders/:id/offers — driver sends price and ETA
exports.createOffer = [
  validateBody(offerSchema),
  catchAsyncError(async (req, res) => {
    const order = await Order.findById(req.params.id);
    if (!order) throw new ApiError(404, "Заказ не найден");
    if (order.status !== "PUBLISHED")
      throw new ApiError(409, "Заказ больше не принимает отклики");
    if (order.mode === "direct" && String(order.targetDriverId) !== String(req.user._id))
      throw new ApiError(403, "Этот заказ оформлен другому водителю");

    const driverMembership = (req.memberships ?? []).find(
      (item) =>
        item.role === "driver" &&
        item.status === "ACTIVE" &&
        String(item.cityId?._id ?? item.cityId) === String(order.cityId)
    );
    if (!driverMembership)
      throw new ApiError(403, "Вы не водитель этого города");

    const existing = await Offer.findOne({
      orderId: order._id,
      driverId: req.user._id,
    });
    if (existing) {
      // One offer per driver per order: the passenger answers it, the driver
      // cannot spam updated prices while the answer is pending
      if (existing.status === "PENDING")
        throw new ApiError(409, "Отклик уже отправлен — ждём ответа пассажира");
      existing.priceText = req.body.priceText;
      existing.etaMin = req.body.etaMin;
      existing.status = "PENDING";
      await existing.save();
    }
    const offer =
      existing ??
      (await Offer.create({
        orderId: order._id,
        driverId: req.user._id,
        priceText: req.body.priceText,
        etaMin: req.body.etaMin,
      }));

    // DriverProfile is keyed by membership, not by user
    const profile = await DriverProfile.findOne({ membershipId: driverMembership._id });

    // The passenger gets the offer on any page (personal room). Open order
    // chats listen to order:offersChanged to refresh the offers list. The
    // offer is NOT sent into the order room, so a passenger who has the order
    // open does not receive two copies (and two notices) of the same offer.
    const offerPayload = {
      orderId: order._id,
      offerId: offer._id,
      driverId: req.user._id,
      driverName: profile?.displayName,
      priceText: offer.priceText,
      etaMin: offer.etaMin,
      carCaption: profile
        ? [profile.car?.color, profile.car?.plate, profile.car?.brand]
            .filter(Boolean)
            .join(" ")
        : undefined,
    };
    emitOrderEvents([
      { room: `user:${order.passengerId}`, event: "order:offer", payload: offerPayload },
      { room: `order:${order._id}`, event: "order:offersChanged", payload: { orderId: order._id } },
    ]);
    // Fire-and-forget push: passenger reads it with the screen locked
    void pushService
      .notifyNewOffer(order, offer, {
        driverName: offerPayload.driverName,
        priceText: offerPayload.priceText,
        etaMin: offerPayload.etaMin,
      })
      .catch(() => undefined);

    res.status(201).json({ status: "success", data: { offer } });
  }),
];

// GET /api/orders/:id/offers — passenger and dispatcher see all, driver his own
exports.listOffers = catchAsyncError(async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) throw new ApiError(404, "Заказ не найден");

  const isPassenger = String(order.passengerId) === String(req.user._id);
  const isDispatcher =
    (req.memberships ?? []).some(
      (item) =>
        item.role === "dispatcher" &&
        item.status === "ACTIVE" &&
        String(item.cityId?._id ?? item.cityId) === String(order.cityId)
    ) || req.user.isSuperadmin === true;

  const filter = { orderId: order._id };
  if (!isPassenger && !isDispatcher) filter.driverId = req.user._id;

  const offers = await Offer.find(filter)
    .populate("driverId", "username name")
    .sort({ createdAt: 1 });

  const driverUserIds = [...new Set(offers.map((offer) => String(offer.driverId._id)))];
  const driverMemberships = await Membership.find({
    userId: { $in: driverUserIds },
    role: "driver",
  }).select("userId _id");
  const profiles = await DriverProfile.find({
    membershipId: { $in: driverMemberships.map((membership) => membership._id) },
  });
  const profileByUser = new Map();
  for (const membership of driverMemberships) {
    const profile = profiles.find(
      (item) => String(item.membershipId) === String(membership._id)
    );
    if (profile) profileByUser.set(String(membership.userId), profile);
  }

  res.json({
    status: "success",
    data: {
      offers: offers.map((offer) => {
        const profile = profileByUser.get(String(offer.driverId._id));
        return {
          _id: offer._id,
          orderId: offer.orderId,
          priceText: offer.priceText,
          etaMin: offer.etaMin,
          status: offer.status,
          driverName: profile?.displayName ?? offer.driverId.name,
          carCaption: profile
            ? [profile.car?.color, profile.car?.plate, profile.car?.brand]
                .filter(Boolean)
                .join(" ")
            : undefined,
        };
      }),
    },
  });
});

// POST /api/orders/:id/accept
// - passenger with offerId picks a driver among the offers
// - driver without offerId takes the order in first_take mode (atomic)
// - direct orders: only the target driver, atomically
exports.acceptOrder = [
  validateBody(acceptSchema),
  catchAsyncError(async (req, res) => {
    const order = await Order.findById(req.params.id);
    if (!order) throw new ApiError(404, "Заказ не найден");

    if (req.body.offerId) {
      // Passenger picks an offer
      if (String(order.passengerId) !== String(req.user._id))
        throw new ApiError(403, "Выбрать водителя может только пассажир");

      const offer = await Offer.findById(req.body.offerId);
      if (!offer || String(offer.orderId) !== String(order._id))
        throw new ApiError(404, "Отклик не найден");
      if (offer.status === "ACCEPTED")
        throw new ApiError(409, "Отклик уже принят");
      if (offer.status === "DECLINED")
        throw new ApiError(409, "Отклик больше недоступен");

      // The driver must still work in the city and, for "now" orders, be free
      const offerDriverActive = await Membership.exists({
        userId: offer.driverId,
        cityId: order.cityId,
        role: "driver",
        status: "ACTIVE",
      });
      if (!offerDriverActive)
        throw new ApiError(409, "Водитель больше не работает в этом городе");
      if (order.when?.type !== "scheduled") {
        const driverBusy = await Order.exists({
          driverId: offer.driverId,
          status: { $in: ["ASSIGNED", "ARRIVING", "WAITING", "IN_RIDE"] },
        });
        if (driverBusy)
          throw new ApiError(409, "Водитель уже выполняет другой заказ");
      }

      const { order: assignedOrder, events } = await assignAtomically(
        order._id,
        offer.driverId,
        { userId: req.user._id, role: "passenger" },
        { priceAgreed: offer.priceText }
      );

      offer.status = "ACCEPTED";
      await offer.save();
      await Offer.updateMany(
        { orderId: order._id, _id: { $ne: offer._id } },
        { $set: { status: "DECLINED" } }
      );

      emitOrderEvents(events);
      return res.json({
        status: "success",
        data: { order: await serializeOrderFor(assignedOrder, req) },
      });
    }

    // Driver takes the order
    const driverMembership = (req.memberships ?? []).find(
      (item) =>
        item.role === "driver" &&
        item.status === "ACTIVE" &&
        String(item.cityId?._id ?? item.cityId) === String(order.cityId)
    );
    if (!driverMembership) throw new ApiError(403, "Вы не водитель этого города");

    if (order.mode === "direct") {
      if (String(order.targetDriverId) !== String(req.user._id))
        throw new ApiError(403, "Этот прямой заказ оформлен другому водителю");

      // For "now" orders the driver must still be online and free
      if (order.when?.type !== "scheduled") {
        const targetProfile = await driverProfileForOrder({ driverId: req.user._id });
        if (!targetProfile || targetProfile.shift === "offline")
          throw new ApiError(409, "Вы не на линии: сначала выйдите на смену");

        const busy = await Order.exists({
          driverId: req.user._id,
          status: { $in: ["ASSIGNED", "ARRIVING", "WAITING", "IN_RIDE"] },
        });
        if (busy) throw new ApiError(409, "У вас уже есть активный заказ");
      }
    } else if (order.matchMode !== "first_take") {
      throw new ApiError(409, "В этом режиме нужно прислать отклик");
    }

    const { order: assignedOrder, events } = await assignAtomically(order._id, req.user._id, {
      userId: req.user._id,
      role: "driver",
    });
    await Offer.updateMany(
      { orderId: order._id, driverId: { $ne: req.user._id } },
      { $set: { status: "DECLINED" } }
    );

    // Remove the card from other drivers' feeds
    events.push(
      { room: `city:${order.cityId}`, event: "order:taken", payload: { orderId: order._id } }
    );
    emitOrderEvents(events);

    res.json({
      status: "success",
      data: { order: await serializeOrderFor(assignedOrder, req) },
    });
  }),
];

// POST /api/orders/:id/assign — dispatcher assigns a driver manually
exports.assignByDispatcher = [
  validateBody(assignSchema),
  catchAsyncError(async (req, res) => {
    const order = await Order.findById(req.params.id);
    if (!order) throw new ApiError(404, "Заказ не найден");

    // Only a dispatcher of the order city, a region admin of its region or
    // the superadmin may assign a driver manually
    if (!(await canManageOrderCity(req, order)))
      throw new ApiError(403, "Назначать водителя может только диспетчер города");

    if (!mongoose.isValidObjectId(req.body.membershipId))
      throw new ApiError(400, "Водитель не найден в этом городе");
    const driverMembership = await Membership.findOne({
      _id: req.body.membershipId,
      cityId: order.cityId,
      role: "driver",
      status: "ACTIVE",
    });
    if (!driverMembership)
      throw new ApiError(400, "Водитель не найден в этом городе");

    const { order: assignedOrder, events } = await assignAtomically(
      order._id,
      driverMembership.userId,
      { userId: req.user._id, role: "dispatcher" }
    );

    events.push(
      { room: `city:${order.cityId}`, event: "order:taken", payload: { orderId: order._id } }
    );
    emitOrderEvents(events);

    res.json({
      status: "success",
      data: { order: await serializeOrderFor(assignedOrder, req) },
    });
  }),
];

// POST /api/orders/:id/decline — the target driver declines a direct order;
// the passenger is then offered to publish it for everyone (concept 1.6)
exports.declineDirectOrder = catchAsyncError(async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) throw new ApiError(404, "Заказ не найден");
  if (order.mode !== "direct")
    throw new ApiError(400, "Отклонить можно только прямой заказ");

  const actor = { userId: req.user._id, role: "driver" };
  const { order: updatedOrder, events } = await transition(order, "cancel", actor, {
    reason: req.body?.reason ?? "Водитель отклонил заказ",
  });

  await botDispatcher.postSystemMessage(
    updatedOrder.chatId,
    "Вы можете опубликовать заказ для всех водителей города"
  );

  emitOrderEvents(events);

  res.json({
    status: "success",
    data: { order: await serializeOrderFor(updatedOrder, req) },
  });
});

// POST /api/orders/:id/republish — the passenger publishes a declined or
// timed-out direct order as a regular city order (concept 1.6)
exports.republishOrder = catchAsyncError(async (req, res) => {
  const original = await Order.findById(req.params.id);
  if (!original) throw new ApiError(404, "Заказ не найден");
  if (String(original.passengerId) !== String(req.user._id))
    throw new ApiError(403, "Это не ваш заказ");
  if (original.mode !== "direct")
    throw new ApiError(400, "Опубликовать заново можно только прямой заказ");
  if (original.status !== "CANCELLED")
    throw new ApiError(409, "Заказ ещё не отклонён и не истёк");

  const city = await City.findById(original.cityId);
  if (!city) throw new ApiError(404, "Город не найден");
  if (!["PILOT", "ACTIVE"].includes(city.status))
    throw new ApiError(403, "В вашем городе заказы ещё не открыты");

  let order = await Order.create({
    passengerId: original.passengerId,
    cityId: original.cityId,
    fromZone: original.fromZone,
    toZone: original.toZone,
    from: original.from,
    to: original.to,
    exactFrom: original.exactFrom,
    exactTo: original.exactTo,
    when: original.when,
    pax: original.pax,
    notes: original.notes,
    matchMode: city.settings?.matchMode ?? "offers",
    mode: "broadcast",
  });

  const chat = await Chat.create({
    type: "order",
    cityId: order.cityId,
    orderId: order._id,
    members: [req.user._id],
  });
  order.chatId = chat._id;

  const actor = { userId: req.user._id, role: "passenger" };
  let events;
  ({ order, events } = await transition(order, "publish", actor));

  order.expiresAt = new Date(
    Date.now() + (city.settings?.cascadeTimeouts?.expire ?? 600) * 1000
  );
  await order.save();
  await botDispatcher.upsertOrderCard(order);

  // Republished scheduled orders are activated by the preorder job instead
  if (order.when?.type !== "scheduled") {
    events.push(
      { room: `city:${order.cityId}`, event: "order:new", payload: { orderId: order._id } }
    );
  }
  emitOrderEvents(events);

  const { scheduleOrderJobs } = require("../jobs/index");
  await scheduleOrderJobs(order);

  res.status(201).json({
    status: "success",
    data: { order: await serializeOrderFor(order, req) },
  });
});

// POST /api/orders/:id/book — водитель бронирует заказ «на время»,
// оставаясь свободным для текущих заказов
exports.bookOrder = catchAsyncError(async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) throw new ApiError(404, "Заказ не найден");
  if (order.mode === "direct" && String(order.targetDriverId) !== String(req.user._id))
    throw new ApiError(403, "Этот заказ оформлен другому водителю");

  const driverMembership = (req.memberships ?? []).find(
    (item) =>
      item.role === "driver" &&
      item.status === "ACTIVE" &&
      String(item.cityId?._id ?? item.cityId) === String(order.cityId)
  );
  if (!driverMembership) throw new ApiError(403, "Вы не водитель этого города");

  const actor = { userId: req.user._id, role: "driver" };
  const { order: bookedOrder, events } = await transition(order, "book", actor);
  const { scheduleBookingActivation } = require("../jobs/index");
  await scheduleBookingActivation(bookedOrder);
  events.push(
    { room: `city:${order.cityId}`, event: "order:taken", payload: { orderId: order._id } }
  );
  emitOrderEvents(events);

  res.json({
    status: "success",
    data: { order: await serializeOrderFor(bookedOrder, req) },
  });
});

// POST /api/orders/:id/activate — водитель приступает к своей брони
exports.activateBooking = catchAsyncError(async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) throw new ApiError(404, "Заказ не найден");
  if (order.status !== "BOOKED")
    throw new ApiError(409, "Заказ не находится в брони");
  if (String(order.driverId) !== String(req.user._id))
    throw new ApiError(403, "Это не ваша бронь");

  const actor = { userId: req.user._id, role: "driver" };
  const { order: activatedOrder, events } = await transition(order, "activate", actor);
  emitOrderEvents(events);

  res.json({
    status: "success",
    data: { order: await serializeOrderFor(activatedOrder, req) },
  });
});

// GET /api/orders/:id/messages — order chat history (bot + participants)
exports.listMessages = catchAsyncError(async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) throw new ApiError(404, "Заказ не найден");

  const isParticipant =
    String(order.passengerId) === String(req.user._id) ||
    String(order.driverId) === String(req.user._id);
  const isDispatcher =
    (req.memberships ?? []).some(
      (item) =>
        item.role === "dispatcher" &&
        item.status === "ACTIVE" &&
        String(item.cityId?._id ?? item.cityId) === String(order.cityId)
    ) || req.user.isSuperadmin === true;
  const isRegionAdmin = (await regionAdminCityIds(req))?.includes(String(order.cityId));

  if (!isParticipant && !isDispatcher && !isRegionAdmin)
    throw new ApiError(403, "Нет доступа к чату этого заказа");

  const before = req.query.before ? new Date(req.query.before) : null;
  const filter = { chatId: order.chatId };
  if (before) filter.createdAt = { $lt: before };

  const messages = await Message.find(filter)
    .sort({ createdAt: -1 })
    .limit(50)
    .populate("senderId", "username name");

  res.json({
    status: "success",
    data: {
      messages: messages.reverse().map((message) => ({
        _id: message._id,
        kind: message.kind,
        body: message.body,
        meta: message.meta,
        senderType: message.senderType,
        senderId: message.senderId?._id ?? message.senderId,
        senderName: message.senderId?.name,
        mine: message.senderId
          ? String(message.senderId._id ?? message.senderId) === String(req.user._id)
          : false,
        createdAt: message.createdAt,
      })),
    },
  });
});

// POST /api/orders/:id/messages — text, photo and voice messages
const sendOrderMessageSchema = z.union([
  z.object({
    body: z.string().trim().min(1, "Введите сообщение").max(2000, "Сообщение слишком длинное"),
  }),
  z.object({
    kind: z.literal("photo"),
    imageUrl: z.string().min(1, "Не передано фото"),
  }),
  z.object({
    kind: z.literal("voice"),
    voiceNoteUrl: z.string().min(1, "Не передана голосовая запись"),
    voiceNoteDuration: z
      .number()
      .int()
      .min(1, "Длительность от 1 секунды")
      .max(600, "Голосовое не длиннее 10 минут"),
  }),
]);
exports.sendOrderMessageSchema = sendOrderMessageSchema;

const PHONE_PATTERN = /(\+?7|8)[\s\-()]?\d{3}[\s\-()]?\d{3}[\s\-()]?\d{2}[\s\-()]?\d{2}/;
const URL_PATTERN = /(https?:\/\/|www\.)\S+|\b[\w-]+\.(?:ru|рф|com|net|org)\b/i;

exports.sendOrderMessage = [
  validateBody(sendOrderMessageSchema),
  catchAsyncError(async (req, res) => {
    const order = await Order.findById(req.params.id);
    if (!order) throw new ApiError(404, "Заказ не найден");

    const isPassenger = String(order.passengerId) === String(req.user._id);
    const isAssignedDriver = String(order.driverId) === String(req.user._id);
    const isDispatcher =
      (req.memberships ?? []).some(
        (item) =>
          item.role === "dispatcher" &&
          item.status === "ACTIVE" &&
          String(item.cityId?._id ?? item.cityId) === String(order.cityId)
      ) || req.user.isSuperadmin === true;
    const isRegionAdmin = (await regionAdminCityIds(req))?.includes(String(order.cityId));

    if (!isPassenger && !isAssignedDriver && !isDispatcher && !isRegionAdmin)
      throw new ApiError(403, "Нет доступа к чату этого заказа");

    // Optional city-level filter for phone numbers and links (concept 1.7)
    const city = await City.findById(order.cityId).select("settings.filterContacts");
    if (city?.settings?.filterContacts && req.body.body) {
      if (PHONE_PATTERN.test(req.body.body) || URL_PATTERN.test(req.body.body)) {
        throw new ApiError(
          400,
          "Отправка телефонных номеров и ссылок запрещена настройками города"
        );
      }
    }

    const message = await Message.create({
      chatId: order.chatId,
      senderId: req.user._id,
      senderType: "user",
      ...(req.body.body
        ? { kind: "text", body: req.body.body }
        : req.body.kind === "photo"
          ? { kind: "photo", body: "Фото", meta: { imageUrl: req.body.imageUrl } }
          : {
              kind: "voice",
              body: "Голосовое сообщение",
              meta: {
                voiceNoteUrl: req.body.voiceNoteUrl,
                voiceNoteDuration: req.body.voiceNoteDuration,
              },
            }),
    });

    const messagePayload = {
      chatId: String(order.chatId),
      orderId: String(order._id),
      messageId: message._id,
      senderId: req.user._id,
      senderName: req.user.name,
      kind: message.kind,
      body: message.body,
      meta: message.meta,
      createdAt: message.createdAt,
    };
    // Open chat gets it in the order room; each participant except the author
    // also gets it in his personal room, so a notice appears on any page
    const recipients = [order.passengerId, order.driverId]
      .filter(Boolean)
      .map(String)
      .filter((id) => id !== String(req.user._id));
    emitOrderEvents([
      { room: `order:${order._id}`, event: "chat:message", payload: messagePayload },
      ...recipients.map((id) => ({
        room: `user:${id}`,
        event: "order:message",
        payload: messagePayload,
      })),
    ]);
    res.status(201).json({
      status: "success",
      data: {
        message: {
          _id: message._id,
          kind: message.kind,
          body: message.body,
          senderId: message.senderId,
          createdAt: message.createdAt,
        },
      },
    });
  }),
];
