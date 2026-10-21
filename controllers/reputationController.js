const { z } = require("zod");
const mongoose = require("mongoose");
const Rating = require("../models/Rating");
const Complaint = require("../models/Complaint");
const Order = require("../models/Order");
const DriverProfile = require("../models/DriverProfile");
const Membership = require("../models/Membership");
const ApiError = require("../utilities/errors");
const catchAsyncError = require("../utilities/catchAsyncError");
const { validateBody } = require("../utilities/catchAsyncError");
const { logAudit } = require("../utilities/audit");
const botDispatcher = require("../services/botDispatcher");
const { regionAdminCityIds } = require("../utilities/rbac");

// City of a complaint: the order city, otherwise the reporter's home city
const complaintCityId = async (orderId, reporter) => {
  if (orderId && mongoose.isValidObjectId(orderId)) {
    const order = await Order.findById(orderId).select("cityId");
    if (order) return order.cityId;
  }
  return reporter?.homeCityId ?? undefined;
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
  orderId: z.string().optional(),
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

    const cityId = await complaintCityId(orderId, req.user);
    const complaint = await Complaint.create({
      reporterId: req.user._id,
      ...(orderId && { orderId }),
      ...(targetUserId && { targetUserId }),
      ...(cityId && { cityId }),
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
  const { emitOrderEvents } = require("../utilities/sockets");
  emitOrderEvents(
    dispatchers.map((dispatcher) => ({
      room: `user:${dispatcher.userId}`,
      event: "sos:raised",
      payload: { orderId: order._id, complaintId: complaint._id },
    }))
  );

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
  if (scope !== null) filter.cityId = { $in: scope };

  const complaints = await Complaint.find(filter)
    .populate("reporterId", "username name")
    .populate("targetUserId", "username name")
    .sort({ createdAt: -1 })
    .limit(200);

  res.json({ status: "success", data: { complaints } });
});

// PATCH /api/admin/complaints/:id — resolve or dismiss
exports.reviewComplaint = catchAsyncError(async (req, res) => {
  const complaint = await Complaint.findById(req.params.id);
  if (!complaint) throw new ApiError(404, "Жалоба не найдена");
  const scope = await regionAdminCityIds(req);
  if (scope !== null && !scope.includes(String(complaint.cityId)))
    throw new ApiError(404, "Жалоба не найдена");
  if (complaint.status !== "OPEN")
    throw new ApiError(409, "Жалоба уже обработана");

  const { status, resolution } = req.body ?? {};
  if (!["IN_REVIEW", "RESOLVED", "DISMISSED"].includes(status))
    throw new ApiError(400, "Недопустимый статус");

  complaint.status = status;
  complaint.resolution = resolution;
  complaint.resolvedBy = req.user._id;
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
