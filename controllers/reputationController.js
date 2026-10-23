const { z } = require("zod");
const mongoose = require("mongoose");
const Rating = require("../models/Rating");
const Complaint = require("../models/Complaint");
const Order = require("../models/Order");
const City = require("../models/City");
const User = require("../models/User");
const DriverProfile = require("../models/DriverProfile");
const Membership = require("../models/Membership");
const ApiError = require("../utilities/errors");
const { emitOrderEvents } = require("../utilities/sockets");
const pushService = require("../utilities/pushService");
const catchAsyncError = require("../utilities/catchAsyncError");
const { validateBody } = require("../utilities/catchAsyncError");
const { logAudit } = require("../utilities/audit");
const botDispatcher = require("../services/botDispatcher");
const { regionAdminCityIds, loadMemberships } = require("../utilities/rbac");

// Prefer the order/home city; membership fallback must be unambiguous.
const complaintCityId = async (order, reporter) => {
  if (order) return order.cityId;
  if (!reporter) return null;
  if (reporter.homeCityId && (await City.exists({ _id: reporter.homeCityId })))
    return reporter.homeCityId;

  const cityIds = await Membership.distinct("cityId", {
    userId: reporter._id,
    status: "ACTIVE",
  });
  const cities = await City.find({ _id: { $in: cityIds } }).select("_id").limit(2);
  return cities.length === 1 ? cities[0]._id : null;
};

// Legacy complaints are resolved read-only until an authorized review saves one.
const effectiveComplaintCityId = async (complaint) => {
  if (complaint.cityId) return complaint.cityId;
  const order = complaint.orderId
    ? await Order.findById(complaint.orderId).select("cityId")
    : null;
  if (order) return order.cityId;
  const reporter = await User.findById(
    complaint.reporterId?._id ?? complaint.reporterId
  ).select("homeCityId");
  return complaintCityId(null, reporter);
};

const ratingSchema = z.object({
  stars: z
    .number()
    .int()
    .min(1, "Оценка от 1 до 5")
    .max(5, "Оценка от 1 до 5"),
  comment: z.string().trim().max(500, "Комментарий слишком длинный").optional(),
});

const complaintSchema = z.object({
  orderId: z
    .string()
    .refine(mongoose.isValidObjectId, "Некорректный идентификатор заказа")
    .optional(),
  targetUserId: z.string().optional(),
  type: z.enum(["sos", "fraud", "behavior", "safety", "other"], {
    errorMap: () => ({ message: "Недопустимый тип жалобы" }),
  }),
  text: z.string().trim().min(1, "Опишите проблему").max(1000),
});

exports.ratingSchema = ratingSchema;
exports.complaintSchema = complaintSchema;
exports.reviewSchema = z.object({
  status: z.enum(["IN_REVIEW", "RESOLVED", "DISMISSED"]),
  resolution: z.string().trim().max(500).optional(),
});

// Recalculates the cached driver rating shown in lists
const refreshDriverRating = async (driverId) => {
  const aggregate = await Rating.aggregate([
    { $match: { toUserId: new mongoose.Types.ObjectId(String(driverId)) } },
    { $group: { _id: "$toUserId", avg: { $avg: "$stars" }, count: { $sum: 1 } } },
  ]);

  const membership = await Membership.findOne({ userId: driverId, role: "driver" });
  if (!membership) return null;

  const stats = aggregate[0];
  return DriverProfile.findOneAndUpdate(
    { membershipId: membership._id },
    {
      rating: stats ? Math.round(stats.avg * 10) / 10 : null,
      ratingCount: stats ? stats.count : 0,
    },
    { new: true }
  );
};

// POST /api/orders/:id/rating — participants rate each other after completion
exports.rateOrder = [
  validateBody(ratingSchema),
  catchAsyncError(async (req, res) => {
    const order = await Order.findById(req.params.id);
    if (!order) throw new ApiError(404, "Заказ не найден");
    if (order.status !== "COMPLETED")
      throw new ApiError(409, "Оценить можно только завершённую поездку");
    if (!order.driverId) throw new ApiError(409, "У заказа нет водителя");

    const isPassenger = String(order.passengerId) === String(req.user._id);
    const isDriver = String(order.driverId) === String(req.user._id);
    if (!isPassenger && !isDriver)
      throw new ApiError(403, "Оценить может только участник поездки");

    const existing = await Rating.findOne({
      orderId: order._id,
      fromUserId: req.user._id,
    });
    if (existing) throw new ApiError(409, "Вы уже оценили эту поездку");

    const rating = await Rating.create({
      orderId: order._id,
      fromUserId: req.user._id,
      fromRole: isPassenger ? "passenger" : "driver",
      toUserId: isPassenger ? order.driverId : order.passengerId,
      stars: req.body.stars,
      ...(req.body.comment && { comment: req.body.comment }),
    });

    if (isPassenger) {
      // Only passengers rate the driver; the driver's rating drives the
      // ordering in the free-drivers list (concept 1.9)
      await refreshDriverRating(order.driverId);
    }

    // Both participants get a push and an in-app notice about the rating
    const ratedPayload = {
      orderId: order._id,
      stars: rating.stars,
      fromRole: rating.fromRole,
      fromName: req.user.name,
      ratingId: rating._id,
      passengerId: String(order.passengerId),
      driverId: order.driverId ? String(order.driverId) : null,
      scope: "order",
      eventId: `rating:${rating._id}`,
    };
    emitOrderEvents([
      { room: `user:${order.passengerId}`, event: "order:rated", payload: ratedPayload },
      ...(order.driverId
        ? [{ room: `user:${order.driverId}`, event: "order:rated", payload: ratedPayload }]
        : []),
    ]);
    void pushService.notifyOrderRated(order, ratedPayload).catch(() => undefined);

    res.status(201).json({ status: "success", data: { rating } });
  }),
];

// GET /api/drivers/:userId/rating — aggregated rating
exports.getDriverRating = catchAsyncError(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.userId))
    throw new ApiError(400, "Некорректный пользователь");
  const aggregate = await Rating.aggregate([
    { $match: { toUserId: new mongoose.Types.ObjectId(req.params.userId) } },
    { $group: { _id: "$toUserId", avg: { $avg: "$stars" }, count: { $sum: 1 } } },
  ]);

  const stats = aggregate[0];
  res.json({
    status: "success",
    data: {
      rating: stats ? Math.round(stats.avg * 10) / 10 : null,
      count: stats ? stats.count : 0,
    },
  });
});

// POST /api/complaints — a complaint or SOS signal to the admins
exports.createComplaint = [
  validateBody(complaintSchema),
  catchAsyncError(async (req, res) => {
    const { orderId, targetUserId, type, text } = req.body;

    let order = null;
    if (orderId) {
      order = await Order.findOne({
        _id: orderId,
        $or: [{ passengerId: req.user._id }, { driverId: req.user._id }],
      }).select("cityId");
      // Do not distinguish a private order from a nonexistent one.
      if (!order) throw new ApiError(404, "Заказ не найден");
    }
    const cityId = await complaintCityId(order, req.user);
    if (!cityId)
      throw new ApiError(400, "Укажите домашний город или заказ для жалобы");
    const complaint = await Complaint.create({
      reporterId: req.user._id,
      ...(orderId && { orderId }),
      ...(targetUserId && { targetUserId }),
      cityId,
      type,
      text,
    });

    await logAudit({
      actorId: req.user._id,
      action: type === "sos" ? "sos.raised" : "complaint.created",
      targetType: "Complaint",
      targetId: complaint._id,
      payload: { orderId, type },
    });

    res.status(201).json({ status: "success", data: { complaint } });
  }),
];

// POST /api/orders/:id/sos — emergency signal inside an order chat
exports.raiseSos = catchAsyncError(async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) throw new ApiError(404, "Заказ не найден");

  const isParticipant =
    String(order.passengerId) === String(req.user._id) ||
    String(order.driverId) === String(req.user._id);
  if (!isParticipant) throw new ApiError(403, "Вы не участник заказа");

  const complaint = await Complaint.create({
    reporterId: req.user._id,
    orderId: order._id,
    cityId: order.cityId,
    type: "sos",
    text: req.body?.text ?? "Кнопка SOS нажата во время заказа",
    // Snapshot of the reporter's number so the dispatcher can call back even
    // if the account changes later
    ...(req.user.phone && { phone: req.user.phone }),
  });

  await botDispatcher.postSystemMessage(
    order.chatId,
    "Кнопка SOS нажата. Сигнал отправлен администраторам и диспетчерам"
  );

  // Notify active dispatchers of the city immediately
  const dispatchers = await Membership.find({
    cityId: order.cityId,
    role: "dispatcher",
    status: "ACTIVE",
  }).select("userId");
  emitOrderEvents(
    dispatchers.map((dispatcher) => ({
      room: `user:${dispatcher.userId}`,
      event: "sos:raised",
      payload: {
        orderId: order._id,
        complaintId: complaint._id,
        text: complaint.text,
        reporterName: req.user.name,
        reporterRole: String(order.passengerId) === String(req.user._id) ? "passenger" : "driver",
        status: complaint.status,
        createdAt: complaint.createdAt,
      },
    }))
  );
  // The dispatcher may have the app closed: the push wakes the phone
  void pushService
    .notifyCitySos(order.cityId, {
      complaintId: complaint._id,
      from: order.from?.text,
      reporterName: req.user.name,
    })
    .catch(() => undefined);

  await logAudit({
    actorId: req.user._id,
    action: "sos.raised",
    targetType: "Complaint",
    targetId: complaint._id,
    payload: { orderId: order._id },
  });

  res.status(201).json({ status: "success", data: { complaint } });
});

// GET /api/admin/complaints?status=&type=
exports.listComplaints = catchAsyncError(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.type) filter.type = req.query.type;
  // Region admins see only complaints of their region; superadmin sees all
  const scope = await regionAdminCityIds(req);
  if (scope !== null)
    filter.$or = [{ cityId: { $in: scope } }, { cityId: null }];

  const cursor = Complaint.find(filter)
    .populate("reporterId", "username name")
    .populate("targetUserId", "username name")
    .sort({ createdAt: -1 })
    .cursor();
  const complaints = [];
  try {
    for await (const complaint of cursor) {
      const cityId = await effectiveComplaintCityId(complaint);
      if (scope !== null && !scope.includes(String(cityId))) continue;
      if (cityId) complaint.cityId = cityId;
      complaints.push(complaint);
      // Scope legacy rows before applying the response limit.
      if (complaints.length === 200) break;
    }
  } finally {
    await cursor.close();
  }

  res.json({ status: "success", data: { complaints } });
});

// PATCH /api/admin/complaints/:id — resolve or dismiss
exports.reviewComplaint = catchAsyncError(async (req, res) => {
  const complaint = await Complaint.findById(req.params.id);
  if (!complaint) throw new ApiError(404, "Жалоба не найдена");
  const scope = await regionAdminCityIds(req);
  const cityId = await effectiveComplaintCityId(complaint);
  if (scope !== null && !scope.includes(String(cityId)))
    throw new ApiError(404, "Жалоба не найдена");
  if (complaint.status !== "OPEN")
    throw new ApiError(409, "Жалоба уже обработана");

  const { status, resolution } = req.body ?? {};
  if (!["IN_REVIEW", "RESOLVED", "DISMISSED"].includes(status))
    throw new ApiError(400, "Недопустимый статус");

  complaint.status = status;
  complaint.resolution = resolution;
  complaint.resolvedBy = req.user._id;
  if (!complaint.cityId && cityId) complaint.cityId = cityId;
  await complaint.save();

  await logAudit({
    actorId: req.user._id,
    action: "admin.complaintReviewed",
    targetType: "Complaint",
    targetId: complaint._id,
    payload: { status, resolution },
  });

  res.json({ status: "success", data: { complaint } });
});

// ---- SOS center for the city dispatcher -------------------------------------
// A dispatcher (or the region admin of that city, or superadmin) may work an
// SOS of his city. The scope check mirrors the order-management rule.
const canWorkCitySos = async (req, cityId) => {
  if (req.user?.isSuperadmin) return true;
  const ownCity = (req.memberships ?? []).some(
    (item) =>
      item.role === "dispatcher" &&
      item.status === "ACTIVE" &&
      String(item.cityId?._id ?? item.cityId) === String(cityId)
  );
  if (ownCity) return true;
  return (await regionAdminCityIds(req))?.includes(String(cityId)) === true;
};

const sosView = (complaint) => ({
  _id: complaint._id,
  orderId: complaint.orderId,
  cityId: complaint.cityId,
  status: complaint.status,
  text: complaint.text,
  phone: complaint.phone ?? null,
  reporter: complaint.reporterId
    ? { _id: complaint.reporterId._id ?? complaint.reporterId, name: complaint.reporterId.name ?? null }
    : null,
  takenBy: complaint.takenBy
    ? { _id: complaint.takenBy._id ?? complaint.takenBy, name: complaint.takenBy.name ?? null }
    : null,
  takenAt: complaint.takenAt ?? null,
  resolution: complaint.resolution ?? null,
  createdAt: complaint.createdAt,
});

const loadSosForDispatcher = async (req) => {
  const complaint = await Complaint.findOne({ _id: req.params.id, type: "sos" });
  if (!complaint) throw new ApiError(404, "Сигнал не найден");
  if (!(await canWorkCitySos(req, complaint.cityId)))
    throw new ApiError(403, "Недостаточно прав в этом городе");
  return complaint;
};

// GET /api/dispatch/:cityId/sos — open and in-review signals of the city
exports.listCitySos = [
  loadMemberships,
  catchAsyncError(async (req, res) => {
    if (!(await canWorkCitySos(req, req.params.cityId)))
      throw new ApiError(403, "Недостаточно прав в этом городе");

    const complaints = await Complaint.find({
      cityId: req.params.cityId,
      type: "sos",
      status: { $in: ["OPEN", "IN_REVIEW"] },
    })
      .populate("reporterId", "name")
      .populate("takenBy", "name")
      .sort({ createdAt: -1 })
      .limit(50);

    res.json({ status: "success", data: { signals: complaints.map(sosView) } });
  }),
];

// POST /api/dispatch/sos/:id/take — the dispatcher answers the signal

// POST /api/dispatch/sos/:id/take — the dispatcher answers the signal
exports.takeCitySos = [
  loadMemberships,
  catchAsyncError(async (req, res) => {
    const complaint = await loadSosForDispatcher(req);
    if (!["OPEN", "IN_REVIEW"].includes(complaint.status))
      throw new ApiError(409, "Сигнал уже обработан");

    // Two dispatchers answering at once must not overwrite the first handler
    if (!complaint.takenBy) {
      complaint.takenBy = req.user._id;
      complaint.takenAt = new Date();
      complaint.status = "IN_REVIEW";
      await complaint.save();

      await logAudit({
        actorId: req.user._id,
        action: "sos.taken",
        targetType: "Complaint",
        targetId: complaint._id,
        payload: { orderId: complaint.orderId },
      });
    }

    await complaint.populate("reporterId", "name");
    await complaint.populate("takenBy", "name");

    // Let the whole shift see who is handling the signal
    const staff = await Membership.find({
      cityId: complaint.cityId,
      role: "dispatcher",
      status: "ACTIVE",
    }).select("userId");
    emitOrderEvents(
      staff.map((member) => ({
        room: `user:${member.userId}`,
        event: "sos:taken",
        payload: { complaintId: complaint._id, takenBy: { name: req.user.name } },
      }))
    );

    res.json({ status: "success", data: { signal: sosView(complaint) } });
  }),
];

const closeSosSchema = z.object({
  outcome: z.enum(["resolved", "dismissed"], {
    errorMap: () => ({ message: "Исход: resolved или dismissed" }),
  }),
  resolution: z.string().trim().min(3, "Опишите, что сделано").max(300),
});
exports.closeSosSchema = closeSosSchema;

// PATCH /api/dispatch/sos/:id — close with a mandatory note
exports.closeCitySos = [
  loadMemberships,
  validateBody(closeSosSchema),
  catchAsyncError(async (req, res) => {
    const complaint = await loadSosForDispatcher(req);
    if (!["OPEN", "IN_REVIEW"].includes(complaint.status))
      throw new ApiError(409, "Сигнал уже обработан");

    complaint.status = req.body.outcome === "resolved" ? "RESOLVED" : "DISMISSED";
    complaint.resolution = req.body.resolution;
    complaint.resolvedBy = req.user._id;
    if (!complaint.takenBy) {
      complaint.takenBy = req.user._id;
      complaint.takenAt = new Date();
    }
    await complaint.save();

    await logAudit({
      actorId: req.user._id,
      action: "sos.closed",
      targetType: "Complaint",
      targetId: complaint._id,
      payload: { status: complaint.status, resolution: complaint.resolution },
    });

    // Participants of the order learn that help is on the way / the signal
    // is closed, so nobody keeps waiting in silence
    const order = await Order.findById(complaint.orderId).select("chatId");
    if (order?.chatId) {
      await botDispatcher.postSystemMessage(
        order.chatId,
        complaint.status === "RESOLVED"
          ? `Диспетчерская: сигнал SOS обработан — ${complaint.resolution}`
          : `Диспетчерская: сигнал SOS закрыт — ${complaint.resolution}`
      );
    }

    // Other dispatchers drop the banner at once instead of on the next reload
    const staff = await Membership.find({
      cityId: complaint.cityId,
      role: "dispatcher",
      status: "ACTIVE",
    }).select("userId");
    emitOrderEvents(
      staff.map((member) => ({
        room: `user:${member.userId}`,
        event: "sos:closed",
        payload: { complaintId: complaint._id, orderId: complaint.orderId },
      }))
    );

    await complaint.populate("reporterId", "name");
    await complaint.populate("takenBy", "name");
    res.json({ status: "success", data: { signal: sosView(complaint) } });
  }),
];




