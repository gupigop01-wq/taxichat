const { z } = require("zod");
const mongoose = require("mongoose");
const City = require("../models/City");
const Membership = require("../models/Membership");
const DriverProfile = require("../models/DriverProfile");
const ApiError = require("../utilities/errors");
const catchAsyncError = require("../utilities/catchAsyncError");
const { validateBody } = require("../utilities/catchAsyncError");
const { logAudit } = require("../utilities/audit");
const { recalcCityStatus } = require("../utilities/cityStatus");
const { canReviewInCity, isSuperadmin } = require("../utilities/rbac");
const { sameCarPair, carCaption } = require("../utilities/drivers");
const { requireMembership, loadMemberships } = require("../utilities/rbac");

const MEMBERSHIP_STATUSES = ["PENDING", "ACTIVE", "REJECTED", "WAITLIST", "SUSPENDED"];

const reviewSchema = z.object({
  decision: z.enum(["approve", "reject"], {
    errorMap: () => ({ message: "Решение должно быть approve или reject" }),
  }),
  reason: z.string().trim().max(500).optional(),
});

// Dispatcher view of a driver: the dispatcher needs everything to run the
// line — car, phone, current shift, live order and whether he is reachable
const driverView = (membership, profile, user, extra = {}) => ({
  _id: membership._id,
  status: membership.status,
  createdAt: membership.createdAt,
  reviewedBy: membership.reviewedBy,
  reason: membership.reason,
  zones: membership.zones,
  user: user ? { _id: user._id, username: user.username, name: user.name } : undefined,
  displayName: profile?.displayName,
  carCaption: profile ? carCaption(profile.car ?? {}) : undefined,
  ...(profile && {
    car: profile.car,
    // The driver's phone to call back; the account phone is the fallback
    phone: profile.phone ?? user?.phone ?? null,
    acceptDirectCalls: profile.acceptDirectCalls,
  }),
  shift: profile?.shift ?? "offline",
  shiftNote: profile?.shiftNote ?? null,
  lastSeen: profile?.lastSeen ?? null,
  online: Boolean(
    profile &&
      profile.shift !== "offline" &&
      profile.lastSeen &&
      Date.now() - new Date(profile.lastSeen).getTime() <= 90 * 1000
  ),
  ...extra,
});

// GET /api/dispatch/:cityId/drivers?status=pending
// City queue for dispatchers: driver memberships of the city by status
exports.listDrivers = [
  loadMemberships,
  catchAsyncError(async (req, res) => {
    const { cityId } = req.params;
    const status = req.query.status ?? "PENDING";
    if (!MEMBERSHIP_STATUSES.includes(status))
      throw new ApiError(400, "Недопустимый статус");

    if (!(await canReviewInCity(req, cityId)))
      throw new ApiError(403, "Недостаточно прав в этом городе");

    const memberships = await Membership.find({ cityId, role: "driver", status })
      .populate("userId", "username name phone")
      .populate("zones", "name")
      .sort({ createdAt: 1 })
      .limit(200);

    const profiles = await DriverProfile.find({
      membershipId: { $in: memberships.map((item) => item._id) },
    });
    const profileByMembership = new Map(
      profiles.map((profile) => [String(profile.membershipId), profile])
    );

    // Live occupation: the order a driver holds right now (if any)
    const Order = require("../models/Order");
    const activeOrders = await Order.find({
      driverId: { $in: memberships.map((item) => item.userId?._id).filter(Boolean) },
      status: { $in: ["BOOKED", "ASSIGNED", "ARRIVING", "WAITING", "IN_RIDE", "DISPUTE"] },
    }).select("_id driverId status from to passengerId");
    const orderByDriver = new Map(
      activeOrders.map((order) => [String(order.driverId), order])
    );

    res.json({
      status: "success",
      data: {
        drivers: memberships.map((membership) => {
          const profile = profileByMembership.get(String(membership._id));
          const activeOrder = orderByDriver.get(String(membership.userId?._id));
          return driverView(membership, profile, membership.userId, {
            activeOrder: activeOrder && {
              _id: activeOrder._id,
              status: activeOrder.status,
              from: activeOrder.from?.text,
              to: activeOrder.to?.text,
            },
          });
        }),
      },
    });
  }),
];

// PATCH /api/dispatch/drivers/:membershipId — approve or reject a driver form
exports.reviewDriver = [
  loadMemberships,
  validateBody(reviewSchema),
  catchAsyncError(async (req, res) => {
    const { membershipId: id } = req.params;
    if (!mongoose.isValidObjectId(id))
      throw new ApiError(400, "Некорректный идентификатор членства");

    const membership = await Membership.findById(id);
    if (!membership) throw new ApiError(404, "Членство не найдено");
    if (membership.role !== "driver")
      throw new ApiError(400, "Это не водительское членство");
    if (membership.status !== "PENDING")
      throw new ApiError(409, "Заявка уже обработана");

    if (!(await canReviewInCity(req, membership.cityId)))
      throw new ApiError(403, "Недостаточно прав в этом городе");

    // A dispatcher cannot review his own driver application in the same city
    if (String(membership.userId) === String(req.user._id))
      throw new ApiError(403, "Нельзя проверять собственную анкету");

    const { decision, reason } = req.body;

    if (decision === "approve") {
      // Validate the car pair before activating the driver
      await assertCarPairFree(membership);

      membership.status = "ACTIVE";
      membership.reviewedBy = req.user._id;
      membership.reason = undefined;
      await membership.save();
    } else {
      if (!reason) throw new ApiError(400, "Укажите причину отказа");
      membership.status = "REJECTED";
      membership.reviewedBy = req.user._id;
      membership.reason = reason;
      await membership.save();
    }

    // Notify the applicant so the client can refresh the roles
    const { emitOrderEvents } = require("../utilities/sockets");
    emitOrderEvents([
      {
        room: `user:${membership.userId}`,
        event: "membership:updated",
        payload: { cityId: String(membership.cityId), role: "driver", status: membership.status },
      },
    ]);

    await logAudit({
      actorId: req.user._id,
      action: "dispatch.driverReviewed",
      targetType: "Membership",
      targetId: membership._id,
      payload: { cityId: membership.cityId, decision, reason },
    });
    const statusChange = await recalcCityStatus(membership.cityId);

    res.json({
      status: "success",
      data: { membership, cityStatus: statusChange },
    });
  }),
];

// Throws when an ACTIVE driver of the city already uses the same color+plate
const assertCarPairFree = async (membership) => {
  const activeMemberships = await Membership.find({
    cityId: membership.cityId,
    role: "driver",
    status: "ACTIVE",
    _id: { $ne: membership._id },
  }).select("_id");

  const profiles = await DriverProfile.find({
    membershipId: { $in: activeMemberships.map((item) => item._id) },
  });
  const current = await DriverProfile.findOne({ membershipId: membership._id });
  if (!current) throw new ApiError(400, "Анкета водителя не найдена");

  for (const profile of profiles) {
    if (sameCarPair(current, profile))
      throw new ApiError(409, "Пара «цвет и номер» уже занята в этом городе");
  }
};

exports.assertCarPairFree = assertCarPairFree;
