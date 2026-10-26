const { z } = require("zod");
const mongoose = require("mongoose");
const Order = require("../../models/Order");
const Offer = require("../../models/Offer");
const Membership = require("../../models/Membership");
const DriverProfile = require("../../models/DriverProfile");
const User = require("../../models/User");
const ApiError = require("../../utilities/errors");
const { logAudit } = require("../../utilities/audit");
const { emitOrderEvents } = require("../../utilities/sockets");
const { transition, assignAtomically } = require("../orderService");
const { createOrderForPassenger } = require("../orderFlow");
const { applyShiftChange } = require("../driverShiftService");
const botDispatcher = require("../botDispatcher");
const pushService = require("../../utilities/pushService");
const {
  statusText,
  whenText,
  routeText,
  ACTIVE_STATUSES,
} = require("./labels");
const { cleanBookingRoute } = require("./router");
const { parseCityDateTime } = require("../time");
const { waitingView } = require("../../utilities/waiting");
const { listDrivers, findDriverByMembership, carCaption } = require("./matching");

// Tools are the only way the model touches the database. Each one validates
// arguments with zod, re-checks the role in the session city and goes through
// the same state machine as the REST API. Destructive tools are marked with
// `confirm: true` and are executed only after the user presses "Подтвердить".

const shortId = (id) => String(id ?? "").slice(-6);
const orderTag = (order) => `#${shortId(order._id)} ${routeText(order)}`;
const isObjectId = (value) => mongoose.isValidObjectId(value);

const loadDriverContext = async (ctx) => {
  const membership = await Membership.findOne({
    userId: ctx.user._id,
    cityId: ctx.cityId,
    role: "driver",
    status: "ACTIVE",
  }).select("_id userId cityId");
  if (!membership) throw new ApiError(403, "Вы не водитель этого города");
  const profile = await DriverProfile.findOne({ membershipId: membership._id });
  if (!profile) throw new ApiError(404, "Анкета водителя не найдена");
  return { membership, profile };
};

// Verifies that the session role really owns the order. A driver may see a
// published city order (that is his feed), but nothing else of other people.
const assertOrderAccess = (ctx, order) => {
  if (ctx.role === "passenger") {
    if (String(order.passengerId) !== String(ctx.user._id))
      throw new ApiError(403, "Это не ваш заказ");
    return;
  }
  if (ctx.role === "driver") {
    const mine = order.driverId && String(order.driverId) === String(ctx.user._id);
    const feed = order.status === "PUBLISHED" && order.mode !== "direct";
    const target =
      order.mode === "direct" && String(order.targetDriverId) === String(ctx.user._id);
    if (!mine && !feed && !target) throw new ApiError(403, "Этот заказ не для вас");
  }
  // dispatcher: the controller already verified an ACTIVE membership in cityId
};

const loadOrder = async (ctx, orderId, { required = true } = {}) => {
  let order = null;
  if (orderId) {
    const raw = String(orderId).replace(/^#/, "").trim();
    if (isObjectId(raw)) {
      order = await Order.findOne({ _id: raw, cityId: ctx.cityId });
    } else if (/^[0-9a-f]{4,23}$/i.test(raw)) {
      // People read the short tail of an id in the chat ("#a1b2c3")
      const candidates = await Order.find({ cityId: ctx.cityId })
        .sort({ createdAt: -1 })
        .limit(200)
        .select("_id");
      const match = candidates.find((item) =>
        String(item._id).toLowerCase().endsWith(raw.toLowerCase())
      );
      if (match) order = await Order.findOne({ _id: match._id, cityId: ctx.cityId });
    }
    // Anything else is free text the model mistook for an id ("Пушкина 8"):
    // fall back to the session's order or the caller's active order instead of
    // failing the whole turn.
  } else if (ctx.session?.lastOrderId) {
    order = await Order.findOne({ _id: ctx.session.lastOrderId, cityId: ctx.cityId });
  }

  if (!order) {
    const filter = { cityId: ctx.cityId, status: { $in: ACTIVE_STATUSES } };
    if (ctx.role === "passenger") filter.passengerId = ctx.user._id;
    if (ctx.role === "driver") {
      filter.$or = [
        { driverId: ctx.user._id },
        { targetDriverId: ctx.user._id, status: "PUBLISHED" },
      ];
    }
    order = await Order.findOne(filter).sort({ createdAt: -1 });
  }

  if (!order) {
    if (!required) return null;
    throw new ApiError(
      404,
      ctx.role === "passenger" ? "У вас нет активного заказа" : "Активный заказ не найден"
    );
  }
  assertOrderAccess(ctx, order);
  return order;
};

// The driver's feed: available published orders, addressed to him directly or
// to the whole city. `orderIndex` follows the numbering the assistant shows.
const availableOrdersFor = (ctx) =>
  Order.find({
    cityId: ctx.cityId,
    status: "PUBLISHED",
    $or: [{ mode: "broadcast" }, { targetDriverId: ctx.user._id }],
  })
    .sort({ createdAt: -1 })
    .limit(8);

const loadFeedOrder = async (ctx, orderId, orderIndex = 1) => {
  if (orderId) return loadOrder(ctx, orderId);
  const orders = await availableOrdersFor(ctx);
  const order = orders[(Number(orderIndex) || 1) - 1];
  if (!order) throw new ApiError(404, "Такого заказа нет в ленте");
  return order;
};

const loadAssignableOrder = async (ctx, orderId) => {
  if (orderId) return loadOrder(ctx, orderId);
  const order = await Order.findOne({ cityId: ctx.cityId, status: "PUBLISHED" }).sort({
    createdAt: -1,
  });
  if (!order) throw new ApiError(404, "Нет опубликованных заказов");
  return order;
};

const loadDispute = async (ctx, orderId) => {
  if (orderId) return loadOrder(ctx, orderId);
  const order = await Order.findOne({ cityId: ctx.cityId, status: "DISPUTE" }).sort({
    createdAt: -1,
  });
  if (!order) throw new ApiError(404, "Открытых споров нет");
  return order;
};

const orderDetails = async (ctx, order) => {
  const lines = [
    `🚕 Заказ ${orderTag(order)}.`,
    `🕒 Статус: ${statusText(order.status)}. Когда: ${whenText(order.when, ctx.city?.tz)}. 👥 Пассажиров: ${order.pax}.`,
  ];
  if (order.priceAgreed) lines.push(`💰 Цена: ${order.priceAgreed}.`);
  const waiting = waitingView(order.waiting);
  if (waiting) {
    const startsLater = new Date(waiting.startedAt).getTime() > Date.now();
    if (waiting.fee > 0)
      lines.push(
        `💰 Платное ожидание: ${waiting.paidMinutes} мин × ${waiting.pricePerMin} ₽ = ${waiting.fee} ₽.`
      );
    else if (startsLater && waiting.endedAt)
      lines.push("⏳ Ожидание по брони не начиналось: поездка началась раньше брони.");
    else if (startsLater)
      lines.push(
        `⏳ Ожидание: бесплатно ${waiting.freeMinutes} мин${
          waiting.pricePerMin > 0 ? `, далее ${waiting.pricePerMin} ₽/мин` : ""
        }, отсчёт с времени брони ${whenText(order.when, ctx.city?.tz)}.`
      );
    else if (!waiting.endedAt)
      lines.push(
        `⏳ Ожидание: бесплатно ${waiting.freeMinutes} мин${
          waiting.pricePerMin > 0 ? `, далее ${waiting.pricePerMin} ₽/мин` : ""
        }.`
      );
    else lines.push(`⏳ Ожидание: ${waiting.freeMinutes} мин бесплатно.`);
  }
  if (order.driverId) {
    const membership = await Membership.findOne({
      userId: order.driverId,
      cityId: order.cityId,
      role: "driver",
    }).select("_id");
    const profile = membership
      ? await DriverProfile.findOne({ membershipId: membership._id })
      : null;
    if (profile) {
      const phone = ctx.role === "driver" ? "" : `, ${profile.phone}`;
      lines.push(`🚗 Водитель: ${profile.displayName}, ${carCaption(profile)}${phone}.`);
    } else {
      lines.push("🚗 Водитель назначен.");
    }
  }
  if (ctx.role === "dispatcher" && order.passengerId) {
    const passenger = await User.findById(order.passengerId).select("name phone");
    if (passenger)
      lines.push(
        `👤 Пассажир: ${passenger.name ?? "—"}${passenger.phone ? `, ${passenger.phone}` : ""}.`
      );
  }
  if (ctx.role !== "driver") {
    const offers = await Offer.countDocuments({ orderId: order._id, status: "PENDING" });
    if (offers > 0) lines.push(`📨 Откликов: ${offers}.`);
  }
  if (order.notes) lines.push(`📝 Примечание: ${order.notes}.`);
  return lines.join("\n");
};

const quickForOrder = (ctx, order) => {
  if (!order) return [];
  if (ctx.role === "passenger") {
    if (order.status === "PUBLISHED") return ["Отклики", "Отменить заказ"];
    if (["ASSIGNED", "ARRIVING", "WAITING", "IN_RIDE"].includes(order.status))
      return ["Статус заказа", "Отменить заказ", "Открыть спор"];
    return ["Мои заказы", "Нужна машина"];
  }
  if (ctx.role === "driver") {
    if (order.status === "ASSIGNED") return ["Выехал", "Я на месте"];
    if (order.status === "ARRIVING") return ["Я на месте"];
    if (order.status === "WAITING") return ["Поехали"];
    if (order.status === "IN_RIDE") return ["Завершить поездку"];
    return ["Мои заказы", "Доступные заказы"];
  }
  if (order.status === "DISPUTE") return ["Закрыть спор", "Обстановка"];
  return ["Обстановка", "Свободные водители"];
};

// Resolves a driver by membership id, exact name or a name prefix. The local
// model cannot reliably copy 24-hex ids, so names are a first-class input.
const resolveDriver = async (ctx, raw, { onlineOnly = false } = {}) => {
  const value = String(raw ?? "").trim();
  if (!value) throw new ApiError(400, "Не указан водитель");
  if (isObjectId(value)) {
    const driver = await findDriverByMembership(ctx.cityId, value);
    if (!driver) throw new ApiError(404, "Водитель не найден в этом городе");
    return driver;
  }
  const drivers = await listDrivers({ cityId: ctx.cityId, onlineOnly, limit: 100 });
  const needle = value.toLowerCase();
  const exact = drivers.filter((driver) => driver.displayName.toLowerCase() === needle);
  const prefix = drivers.filter((driver) =>
    driver.displayName.toLowerCase().startsWith(needle)
  );
  // Russian cases in speech ("Ивану", "Марии") break a strict prefix match:
  // compare the first four letters, which survives most inflections
  const stem = needle.slice(0, 4);
  const fuzzy = drivers.filter((driver) =>
    driver.displayName.toLowerCase().startsWith(stem)
  );
  const found = exact[0] ?? prefix[0] ?? fuzzy[0];
  if (!found)
    throw new ApiError(
      404,
      `🚗 Водитель «${value}» не найден. Свободные: ${
        drivers.filter((driver) => driver.online).slice(0, 5).map((d) => d.displayName).join(", ") || "нет"
      }`
    );
  return found;
};

const TOOLS = {
  // ---------------------------------------------------------------- passenger
  create_order: {
    roles: ["passenger"],
    confirm: false,
    schema: z.object({
      route: z.string().trim().min(3, "Укажите маршрут").max(300, "Маршрут слишком длинный"),
      pax: z.coerce.number().int().min(1).max(8).default(1),
      whenAt: z.string().trim().optional(),
      notes: z.string().trim().max(300).optional(),
    }),
    run: async (ctx, args) => {
      let whenType = "now";
      let whenAt;
      if (args.whenAt) {
        // A bare "2026-10-26T07:00" from the model is the city's wall clock:
        // interpreting it in the server zone shifted Irkutsk rides by 5 hours
        const at = parseCityDateTime(args.whenAt, ctx.city?.tz);
        if (!at) throw new ApiError(400, "Не понял время поездки, назовите его ещё раз");
        if (at.getTime() <= Date.now() + 60_000)
          throw new ApiError(400, "Это время уже прошло — назовите будущее время");
        whenType = "scheduled";
        whenAt = at.toISOString();
      }
      const route = args.whenAt ? cleanBookingRoute(args.route) : args.route;
      const { order, events } = await createOrderForPassenger({
        user: ctx.user,
        memberships: ctx.memberships,
        data: {
          cityId: ctx.cityId,
          route,
          pax: args.pax ?? 1,
          whenType,
          whenAt,
          ...(args.notes && { notes: args.notes }),
        },
      });
      emitOrderEvents(events);
      ctx.session.lastOrderId = order._id;
      return {
        text: `🆕 Заказ создан: ${orderTag(order)}. ${statusText(order.status)}.${
          order.when?.type === "scheduled"
            ? ` 📅 Забронирован на ${whenText(order.when, ctx.city?.tz)}.`
            : ""
        } 🔍 Когда появятся отклики, я покажу их здесь.`,
        quick: ["Отклики", "Отменить заказ"],
        orderId: order._id,
      };
    },
  },

  my_orders: {
    roles: ["passenger", "driver", "dispatcher"],
    confirm: false,
    schema: z.object({}),
    run: async (ctx) => {
      const filter = { cityId: ctx.cityId, status: { $in: ACTIVE_STATUSES } };
      if (ctx.role === "passenger") filter.passengerId = ctx.user._id;
      if (ctx.role === "driver") filter.driverId = ctx.user._id;
      const orders = await Order.find(filter).sort({ createdAt: -1 }).limit(5);
      if (orders.length === 0)
        return {
          text:
            ctx.role === "passenger"
              ? "📭 Активных заказов нет. Скажите «нужна машина», и я оформлю."
              : "📭 Активных заказов нет.",
          quick: ctx.role === "passenger" ? ["Нужна машина"] : ["Доступные заказы"],
        };
      const text = orders.map((order) => `— ${orderTag(order)}, ${statusText(order.status)}`).join("\n");
      return {
        text: `📋 Ваши заказы:\n${text}`,
        quick: quickForOrder(ctx, orders[0]),
        orderId: orders[0]._id,
      };
    },
  },

  order_status: {
    roles: ["passenger", "driver", "dispatcher"],
    confirm: false,
    schema: z.object({ orderId: z.string().optional() }),
    run: async (ctx, args) => {
      const order = await loadOrder(ctx, args.orderId);
      return {
        text: await orderDetails(ctx, order),
        quick: quickForOrder(ctx, order),
        orderId: order._id,
      };
    },
  },

  list_offers: {
    roles: ["passenger", "dispatcher"],
    confirm: false,
    schema: z.object({ orderId: z.string().optional() }),
    run: async (ctx, args) => {
      const order = await loadOrder(ctx, args.orderId);
      const offers = await Offer.find({ orderId: order._id, status: "PENDING" }).sort({
        createdAt: 1,
      });
      if (offers.length === 0)
        return {
          text: `📭 Пока нет откликов по заказу ${orderTag(order)}. Как только водитель ответит, я сразу покажу.`,
          quick: quickForOrder(ctx, order),
          orderId: order._id,
        };

      const lines = [];
      for (const [index, offer] of offers.entries()) {
        const membership = await Membership.findOne({
          userId: offer.driverId,
          cityId: order.cityId,
          role: "driver",
        }).select("_id");
        const profile = membership
          ? await DriverProfile.findOne({ membershipId: membership._id })
          : null;
        lines.push(
          `${index + 1}. ${profile?.displayName ?? "Водитель"}${
            profile ? `, ${carCaption(profile)}` : ""
          } — ${offer.priceText}, ${offer.etaMin} мин.`
        );
      }
      return {
        text: `📨 Отклики по заказу ${orderTag(order)}:\n${lines.join("\n")}\nСкажите «прими первый/второй», и я назначу водителя.`,
        quick: ["Принять первый", "Отменить заказ"],
        orderId: order._id,
      };
    },
  },

  accept_offer: {
    roles: ["passenger"],
    confirm: true,
    schema: z
      .object({
        orderId: z.string().optional(),
        offerId: z.string().optional(),
        offerIndex: z.coerce.number().int().min(1).optional(),
      })
      .refine((data) => data.offerId || data.offerIndex, {
        message: "Укажите отклик: offerId или offerIndex",
      }),
    preview: async (ctx, args) => {
      const order = await loadOrder(ctx, args.orderId);
      const offers = await Offer.find({ orderId: order._id, status: "PENDING" }).sort({
        createdAt: 1,
      });
      const offer = args.offerId
        ? offers.find((item) => String(item._id) === String(args.offerId))
        : offers[(args.offerIndex ?? 1) - 1];
      if (!offer) throw new ApiError(404, "Такой отклик не найден");
      const membership = await Membership.findOne({
        userId: offer.driverId,
        cityId: order.cityId,
        role: "driver",
      }).select("_id");
      const profile = membership
        ? await DriverProfile.findOne({ membershipId: membership._id })
        : null;
      return {
        args: { orderId: String(order._id), offerId: String(offer._id) },
        summary: `Назначить ${profile?.displayName ?? "водителя"}${
          profile ? ` (${carCaption(profile)})` : ""
        } на заказ ${orderTag(order)} за ${offer.priceText}`,
      };
    },
    run: async (ctx, args) => {
      const order = await loadOrder(ctx, args.orderId);
      if (order.status !== "PUBLISHED")
        throw new ApiError(409, "Заказ уже не принимает отклики");

      const offer = await Offer.findOne({ _id: args.offerId, orderId: order._id });
      if (!offer) throw new ApiError(404, "Отклик не найден");
      if (offer.status !== "PENDING") throw new ApiError(409, "Отклик уже обработан");

      const driverActive = await Membership.exists({
        userId: offer.driverId,
        cityId: order.cityId,
        role: "driver",
        status: "ACTIVE",
      });
      if (!driverActive) throw new ApiError(409, "Водитель больше не работает в этом городе");

      const busy = await Order.exists({
        driverId: offer.driverId,
        status: { $in: ["ASSIGNED", "ARRIVING", "WAITING", "IN_RIDE"] },
      });
      if (busy) throw new ApiError(409, "Водитель уже выполняет другой заказ");

      const membership = await Membership.findOne({
        userId: offer.driverId,
        cityId: order.cityId,
        role: "driver",
      }).select("_id");
      const profile = membership
        ? await DriverProfile.findOne({ membershipId: membership._id })
        : null;

      const { order: assigned, events } = await assignAtomically(
        order._id,
        offer.driverId,
        { userId: ctx.user._id, role: "passenger" },
        { priceAgreed: offer.priceText, source: "ai" }
      );
      offer.status = "ACCEPTED";
      await offer.save();
      await Offer.updateMany(
        { orderId: order._id, _id: { $ne: offer._id } },
        { $set: { status: "DECLINED" } }
      );
      emitOrderEvents(events);
      await logAudit({
        actorId: ctx.user._id,
        action: "ai.acceptOffer",
        targetType: "Order",
        targetId: order._id,
        payload: { offerId: offer._id, driverId: offer.driverId, priceText: offer.priceText },
      });
      ctx.session.lastOrderId = assigned._id;

      return {
        text: `✅ Водитель назначен: ${profile?.displayName ?? "водитель"}${
          profile ? `, ${carCaption(profile)}` : ""
        }. Цена ${offer.priceText}, подача ~${offer.etaMin} мин. 📍 Адрес и телефон открыты в заказе.`,
        quick: ["Статус заказа", "Отменить заказ"],
        orderId: assigned._id,
      };
    },
  },

  cancel_order: {
    roles: ["passenger", "driver", "dispatcher"],
    confirm: true,
    schema: z.object({
      orderId: z.string().optional(),
      reason: z.string().trim().max(300).optional(),
    }),
    preview: async (ctx, args) => {
      const order = await loadOrder(ctx, args.orderId);
      return {
        args: { ...args, orderId: String(order._id) },
        summary: `Отменить заказ ${orderTag(order)} (${statusText(order.status)})`,
      };
    },
    run: async (ctx, args) => {
      const order = await loadOrder(ctx, args.orderId);
      const actor = { userId: ctx.user._id, role: ctx.role };
      const reason = args.reason || "Отменено через AI-диспетчера";
      const { order: updated, events } = await transition(order, "cancel", actor, { reason, source: "ai" });
      emitOrderEvents(events);
      return {
        text: `❌ Заказ ${orderTag(updated)} отменён.`,
        quick: ctx.role === "passenger" ? ["Нужна машина"] : ["Мои заказы"],
        orderId: updated._id,
      };
    },
  },

  open_dispute: {
    roles: ["passenger", "driver"],
    confirm: true,
    schema: z.object({
      orderId: z.string().optional(),
      reason: z.string().trim().max(300).optional(),
    }),
    preview: async (ctx, args) => {
      const order = await loadOrder(ctx, args.orderId);
      return {
        args: { ...args, orderId: String(order._id) },
        summary: `Открыть спор по заказу ${orderTag(order)}`,
      };
    },
    run: async (ctx, args) => {
      const order = await loadOrder(ctx, args.orderId);
      const actor = { userId: ctx.user._id, role: ctx.role };
      const reason = args.reason || "Разногласия по поездке";
      const { order: updated, events } = await transition(order, "dispute", actor, { reason, source: "ai" });
      emitOrderEvents(events);
      return {
        text: `⚠️ Спор по заказу ${orderTag(updated)} открыт, диспетчер подключён к чату.`,
        quick: ["Статус заказа"],
        orderId: updated._id,
      };
    },
  },

  // ------------------------------------------------------------------- driver
  driver_shift: {
    roles: ["driver"],
    confirm: false,
    schema: z.object({
      shift: z.enum(["online", "offline"]),
      confirmBack: z.boolean().optional(),
    }),
    run: async (ctx, args) => {
      const result = await applyShiftChange({
        userId: ctx.user._id,
        cityId: ctx.cityId,
        shift: args.shift,
        confirmBack: args.confirmBack === true,
      });
      if (result.reason === "locked") {
        return {
          text: `⚠️ Диспетчер снял вас с линии: ${result.profile.shiftNote}. Скажите «вернуться на линию», чтобы подтвердить возврат.`,
          quick: ["Вернуться на линию"],
        };
      }
      if (!result.ok) throw new ApiError(403, "Нет активной анкеты водителя");

      emitOrderEvents([
        {
          room: `user:${ctx.user._id}`,
          event: "driver:shiftChanged",
          payload: { driverId: String(ctx.user._id), shift: result.profile.shift, shiftNote: null },
        },
        {
          room: `city:${ctx.cityId}`,
          event: "driver:presence",
          payload: { driverId: String(ctx.user._id), shift: result.profile.shift },
        },
      ]);

      return {
        text:
          args.shift === "online"
            ? "🟢 Вы на линии. Показываю доступные заказы, как только они появятся."
            : "🌙 Вы ушли с линии. Вернуться можно в любой момент.",
        quick: args.shift === "online" ? ["Доступные заказы"] : ["Вернуться на линию"],
      };
    },
  },

  available_orders: {
    roles: ["driver"],
    confirm: false,
    schema: z.object({}),
    run: async (ctx) => {
      const orders = await availableOrdersFor(ctx);
      if (orders.length === 0)
        return {
          text: "📭 Свободных заказов сейчас нет. Я сообщу, когда появится новый.",
          quick: ["Мои заказы", "На линии"],
        };
      const lines = orders.map(
        (order) => `— ${orderTag(order)}, ${order.pax} чел., ${whenText(order.when, ctx.city?.tz)}`
      );
      return {
        text: `📋 Доступные заказы:\n${lines.join("\n")}\nСкажите «возьму первый» или «откликнусь на первый за 300».`,
        quick: ["Возьму первый", "Откликнуться на первый"],
        orderId: orders[0]._id,
      };
    },
  },

  send_offer: {
    roles: ["driver"],
    confirm: false,
    schema: z.object({
      orderId: z.string().optional(),
      orderIndex: z.coerce.number().int().min(1).optional(),
      priceText: z.string().trim().min(1, "Укажите цену").max(50),
      etaMin: z.coerce.number().int().min(1).max(180),
    }),
    run: async (ctx, args) => {
      const order = await loadFeedOrder(ctx, args.orderId, args.orderIndex);
      if (order.status !== "PUBLISHED")
        throw new ApiError(409, "Заказ больше не принимает отклики");
      if (order.mode === "direct" && String(order.targetDriverId) !== String(ctx.user._id))
        throw new ApiError(403, "Этот заказ оформлен другому водителю");

      const { membership, profile } = await loadDriverContext(ctx);

      const existing = await Offer.findOne({ orderId: order._id, driverId: ctx.user._id });
      if (existing && existing.status === "PENDING")
        throw new ApiError(409, "Отклик уже отправлен — ждём ответа пассажира");

      let offer;
      if (existing) {
        existing.priceText = args.priceText;
        existing.etaMin = args.etaMin;
        existing.status = "PENDING";
        await existing.save();
        offer = existing;
      } else {
        offer = await Offer.create({
          orderId: order._id,
          driverId: ctx.user._id,
          priceText: args.priceText,
          etaMin: args.etaMin,
        });
      }

      const payload = {
        orderId: order._id,
        offerId: offer._id,
        driverId: ctx.user._id,
        driverName: profile.displayName,
        priceText: offer.priceText,
        etaMin: offer.etaMin,
        carCaption: carCaption(profile),
      };
      emitOrderEvents([
        { room: `user:${order.passengerId}`, event: "order:offer", payload },
        { room: `order:${order._id}`, event: "order:offersChanged", payload: { orderId: order._id } },
      ]);
      void pushService
        .notifyNewOffer(order, offer, {
          driverName: payload.driverName,
          priceText: payload.priceText,
          etaMin: payload.etaMin,
        })
        .catch(() => undefined);

      ctx.session.lastOrderId = order._id;
      return {
        text: `📨 Отклик отправлен: ${orderTag(order)} — ${offer.priceText}, подача ${offer.etaMin} мин. Ждём ответа пассажира.`,
        quick: ["Мои заказы", "Доступные заказы"],
        orderId: order._id,
      };
    },
  },

  take_order: {
    roles: ["driver"],
    confirm: false,
    schema: z.object({
      orderId: z.string().optional(),
      orderIndex: z.coerce.number().int().min(1).optional(),
    }),
    run: async (ctx, args) => {
      const order = await loadFeedOrder(ctx, args.orderId, args.orderIndex);
      await loadDriverContext(ctx);

      if (order.mode === "direct") {
        if (String(order.targetDriverId) !== String(ctx.user._id))
          throw new ApiError(403, "Этот прямой заказ оформлен другому водителю");
      } else if (order.matchMode !== "first_take") {
        throw new ApiError(409, "В этом режиме нужно прислать отклик");
      }

      const { order: assigned, events } = await assignAtomically(
        order._id,
        ctx.user._id,
        { userId: ctx.user._id, role: "driver" },
        { source: "ai" }
      );
      await Offer.updateMany(
        { orderId: order._id, driverId: { $ne: ctx.user._id } },
        { $set: { status: "DECLINED" } }
      );
      events.push({
        room: `city:${order.cityId}`,
        event: "order:taken",
        payload: { orderId: order._id },
      });
      emitOrderEvents(events);
      ctx.session.lastOrderId = assigned._id;

      return {
        text: `✅ Заказ ${orderTag(assigned)} ваш. 📍 Адрес и телефон пассажира открыты в заказе.`,
        quick: ["Выехал"],
        orderId: assigned._id,
      };
    },
  },

  order_action: {
    roles: ["driver"],
    confirm: false,
    schema: z.object({
      orderId: z.string().optional(),
      action: z.enum(["arrive", "wait", "start", "finish", "no_show", "undo_start"]),
    }),
    run: async (ctx, args) => {
      const order = await loadOrder(ctx, args.orderId);
      const { order: updated, events } = await transition(
        order,
        args.action,
        { userId: ctx.user._id, role: "driver" },
        { source: "ai" }
      );
      emitOrderEvents(events);
      const LABELS = {
        arrive: "🚗 Отметил, что выехали.",
        wait: "📍 Отметил, что вы на месте.",
        start: "🛣 Поездка началась.",
        finish: "🏁 Поездка завершена.",
        no_show: "🚫 Отметил, что пассажир не вышел.",
        undo_start: "⏸ Вернул заказ в статус ожидания.",
      };
      return {
        text: `${LABELS[args.action]} ${orderTag(updated)}.`,
        quick: quickForOrder(ctx, updated),
        orderId: updated._id,
      };
    },
  },

  // --------------------------------------------------------------- dispatcher
  city_snapshot: {
    roles: ["dispatcher"],
    confirm: false,
    schema: z.object({}),
    run: async (ctx) => {
      const [published, rides, disputes, drivers] = await Promise.all([
        Order.countDocuments({ cityId: ctx.cityId, status: "PUBLISHED" }),
        Order.countDocuments({
          cityId: ctx.cityId,
          status: { $in: ["ASSIGNED", "ARRIVING", "WAITING", "IN_RIDE"] },
        }),
        Order.countDocuments({ cityId: ctx.cityId, status: "DISPUTE" }),
        listDrivers({ cityId: ctx.cityId, limit: 100 }),
      ]);
      const online = drivers.filter((driver) => driver.online).length;
      const busy = drivers.filter((driver) => driver.busy || driver.shift === "busy").length;
      return {
        text: `🚦 ${ctx.city.name}: ${published} ищут водителя, ${rides} в работе, ${disputes} спор(ов). 🚗 Водители: ${online} свободны, ${busy} заняты, всего ${drivers.length}.`,
        quick: ["Свободные водители", "Очередь заказов"],
      };
    },
  },

  list_drivers: {
    roles: ["dispatcher"],
    confirm: false,
    schema: z.object({
      onlineOnly: z.boolean().optional(),
      name: z.string().trim().optional(),
    }),
    run: async (ctx, args) => {
      let drivers = await listDrivers({
        cityId: ctx.cityId,
        onlineOnly: args.onlineOnly === true,
        limit: 30,
      });
      if (args.name) {
        const needle = args.name.toLowerCase();
        drivers = drivers.filter((driver) => driver.displayName.toLowerCase().includes(needle));
      }
      if (drivers.length === 0)
        return {
          text: args.onlineOnly ? "📭 На линии никого нет." : "📭 Водителей в городе нет.",
          quick: ["Обстановка"],
        };
      const lines = drivers.map((driver) => {
        const state = driver.online ? "на линии" : driver.busy ? "занят" : "не на линии";
        const rating = driver.rating ? `, ★${driver.rating.toFixed(1)}` : "";
        return `— ${driver.displayName} (${driver.carCaption}), ${state}${rating}`;
      });
      return {
        text: `🚗 Водители ${ctx.city.name}:\n${lines.join("\n")}\nСкажите «назначь <имя> на заказ #…» или «предложи заказ <имя>».`,
        quick: ["Обстановка", "Очередь заказов"],
      };
    },
  },

  list_orders: {
    roles: ["dispatcher"],
    confirm: false,
    schema: z.object({ status: z.string().trim().optional() }),
    run: async (ctx, args) => {
      const filter = { cityId: ctx.cityId };
      if (args.status) {
        const status = String(args.status).toUpperCase();
        filter.status = status;
      } else {
        filter.status = { $in: ACTIVE_STATUSES };
      }
      const orders = await Order.find(filter).sort({ createdAt: -1 }).limit(10);
      if (orders.length === 0) return { text: "📭 Очередь пуста.", quick: ["Обстановка"] };
      const lines = orders.map(
        (order) =>
          `— ${orderTag(order)}, ${order.pax} чел., ${statusText(order.status)}${
            order.driverId ? `, водитель назначен` : ""
          }`
      );
      return {
        text: `📋 Заказы ${ctx.city.name}:\n${lines.join("\n")}`,
        quick: ["Свободные водители", "Обстановка"],
        orderId: orders[0]._id,
      };
    },
  },

  offer_order: {
    roles: ["dispatcher"],
    confirm: false,
    schema: z.object({
      orderId: z.string().optional(),
      drivers: z.preprocess(
        (value) => (Array.isArray(value) ? value : [value]),
        z.array(z.string().trim().min(1)).min(1, "Укажите водителя")
      ),
      priceText: z.string().trim().max(50).optional(),
    }),
    run: async (ctx, args) => {
      const order = await loadOrder(ctx, args.orderId);
      if (order.status !== "PUBLISHED")
        throw new ApiError(409, "Предлагать можно только опубликованный заказ");

      const resolved = [];
      for (const raw of args.drivers) {
        resolved.push(await resolveDriver(ctx, raw));
      }

      await botDispatcher.postSystemMessage(
        order.chatId,
        `Диспетчер предлагает заказ водителям: ${resolved.map((driver) => driver.displayName).join(", ")}`
      );
      emitOrderEvents(
        resolved.map((driver) => ({
          room: `user:${driver.userId}`,
          event: "order:new",
          payload: { orderId: order._id },
        }))
      );
      for (const driver of resolved) {
        void pushService
          .sendPushToUser(driver.userId, {
            kind: "order",
            title: "Диспетчер предлагает заказ",
            body: `${routeText(order)}${args.priceText ? `, ${args.priceText}` : ""}`,
            tag: "bombila-live",
            renotify: true,
            url: "/",
          })
          .catch(() => undefined);
      }

      await logAudit({
        actorId: ctx.user._id,
        action: "ai.offerToDrivers",
        targetType: "Order",
        targetId: order._id,
        payload: { drivers: resolved.map((driver) => String(driver.membershipId)) },
      });

      return {
        text: `📨 Предложил заказ ${orderTag(order)}: ${resolved
          .map((driver) => driver.displayName)
          .join(", ")}. Ожидаю их отклики.`,
        quick: ["Обстановка", "Очередь заказов"],
        orderId: order._id,
      };
    },
  },

  assign_driver: {
    roles: ["dispatcher"],
    confirm: true,
    schema: z.object({
      orderId: z.string().optional(),
      driver: z.string().trim().min(1, "Укажите водителя"),
    }),
    preview: async (ctx, args) => {
      const order = await loadAssignableOrder(ctx, args.orderId);
      if (order.status !== "PUBLISHED")
        throw new ApiError(409, "Назначить можно только опубликованный заказ");
      const driver = await resolveDriver(ctx, args.driver);
      return {
        args: { orderId: String(order._id), driver: String(driver.membershipId) },
        summary: `Назначить ${driver.displayName} (${driver.carCaption}) на заказ ${orderTag(order)}`,
      };
    },
    run: async (ctx, args) => {
      const order = await loadAssignableOrder(ctx, args.orderId);
      const driver = await resolveDriver(ctx, args.driver);
      const { order: assigned, events } = await assignAtomically(
        order._id,
        driver.userId,
        { userId: ctx.user._id, role: "dispatcher" },
        { source: "ai" }
      );
      events.push({
        room: `city:${order.cityId}`,
        event: "order:taken",
        payload: { orderId: order._id },
      });
      emitOrderEvents(events);
      await logAudit({
        actorId: ctx.user._id,
        action: "ai.assignDriver",
        targetType: "Order",
        targetId: order._id,
        payload: { driverId: driver.userId, membershipId: driver.membershipId },
      });

      return {
        text: `✅ Назначил ${driver.displayName} (${driver.carCaption}) на заказ ${orderTag(assigned)}.`,
        quick: ["Обстановка", "Очередь заказов"],
        orderId: assigned._id,
      };
    },
  },

  resolve_dispute: {
    roles: ["dispatcher"],
    confirm: true,
    schema: z.object({
      orderId: z.string().optional(),
      outcome: z.enum(["complete", "cancel"]),
      reason: z.string().trim().max(300).optional(),
    }),
    preview: async (ctx, args) => {
      const order = await loadDispute(ctx, args.orderId);
      if (order.status !== "DISPUTE") throw new ApiError(409, "Заказ не в споре");
      return {
        args: { ...args, orderId: String(order._id) },
        summary: `Закрыть спор ${orderTag(order)}: ${
          args.outcome === "complete" ? "поездка засчитана" : "заказ отменён"
        }`,
      };
    },
    run: async (ctx, args) => {
      const order = await loadDispute(ctx, args.orderId);
      const event = args.outcome === "complete" ? "resolve_complete" : "resolve_cancel";
      const { order: updated, events } = await transition(
        order,
        event,
        { userId: ctx.user._id, role: "dispatcher" },
        { reason: args.reason, source: "ai" }
      );
      emitOrderEvents(events);
      await logAudit({
        actorId: ctx.user._id,
        action: "ai.resolveDispute",
        targetType: "Order",
        targetId: order._id,
        payload: { outcome: args.outcome, reason: args.reason ?? null },
      });
      return {
        text: `✅ Спор по заказу ${orderTag(updated)} закрыт: ${
          args.outcome === "complete" ? "поездка засчитана" : "заказ отменён"
        }.`,
        quick: ["Обстановка"],
        orderId: updated._id,
      };
    },
  },

  escalate: {
    roles: ["passenger", "driver", "dispatcher"],
    confirm: false,
    schema: z.object({
      orderId: z.string().optional(),
      text: z.string().trim().min(3, "Опишите вопрос").max(500),
    }),
    run: async (ctx, args) => {
      const order = await loadOrder(ctx, args.orderId, { required: false });
      if (order?.chatId) {
        await botDispatcher.postSystemMessage(
          order.chatId,
          `Вопрос передан живому диспетчеру: ${args.text}`
        );
      }
      const dispatchers = await Membership.find({
        cityId: ctx.cityId,
        role: "dispatcher",
        status: "ACTIVE",
        userId: { $ne: ctx.user._id },
      }).select("userId");
      for (const membership of dispatchers) {
        void pushService
          .sendPushToUser(membership.userId, {
            kind: "dispatch",
            title: "AI-диспетчер передал вопрос",
            body: args.text,
            tag: "bombila-live",
            renotify: true,
            url: "/",
          })
          .catch(() => undefined);
      }
      await logAudit({
        actorId: ctx.user._id,
        action: "ai.escalate",
        targetType: order ? "Order" : "City",
        targetId: order?._id ?? ctx.cityId,
        payload: { text: args.text },
      });
      return {
        text:
          dispatchers.length > 0
            ? "📨 Передал вопрос живому диспетчеру."
            : "📝 Живых диспетчеров в городе нет — записал вопрос в журнал.",
        quick: ["Обстановка"],
        orderId: order?._id,
      };
    },
  },

  help: {
    roles: ["passenger", "driver", "dispatcher"],
    confirm: false,
    schema: z.object({}),
    run: async (ctx) => {
      const text = {
        passenger:
          "ℹ️ Я могу: оформить заказ («нужна машина от вокзала до центра»), показать отклики водителей и статус, отменить заказ или открыть спор.",
        driver:
          "ℹ️ Я могу: выйти на линию, показать доступные заказы, отправить отклик с ценой, взять заказ и провести его по шагам.",
        dispatcher:
          "ℹ️ Я могу: показать обстановку, очередь заказов и водителей, предложить заказ, назначить водителя, отменить заказ и закрыть спор.",
      }[ctx.role];
      return {
        text,
        quick:
          ctx.role === "passenger"
            ? ["Нужна машина", "Мои заказы"]
            : ctx.role === "driver"
              ? ["На линии", "Доступные заказы"]
              : ["Обстановка", "Свободные водители"],
      };
    },
  },
};

const getTool = (name, role) => {
  const tool = TOOLS[name];
  if (!tool) return null;
  if (!tool.roles.includes(role)) return null;
  return tool;
};

const toolNamesFor = (role) =>
  Object.entries(TOOLS)
    .filter(([, tool]) => tool.roles.includes(role))
    .map(([name]) => name);

module.exports = { TOOLS, getTool, toolNamesFor, loadOrder, orderTag, orderDetails };
