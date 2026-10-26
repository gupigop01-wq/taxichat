const Membership = require("../models/Membership");
const ApiError = require("./errors");

// One role per city: a person is either a passenger or a driver — or works as a
// dispatcher or a region admin there. Switching roles replaces the current one
// instead of adding a second membership.
const CITY_ROLES = ["passenger", "driver", "dispatcher", "region_admin"];

// Roles that may hold a live order or a driver card; they are not replaced
// while something is in progress.
const LIVE_ORDER_STATUSES = ["BOOKED", "ASSIGNED", "ARRIVING", "WAITING", "IN_RIDE", "DISPUTE"];

const currentRoleInCity = async (userId, cityId) => {
  const memberships = await Membership.find({ userId, cityId }).sort({ createdAt: 1 });
  return memberships.find((item) => item.status !== "REJECTED") ?? memberships[0] ?? null;
};

// A driver cannot be switched away from while he has a ride, and a dispatcher
// cannot be switched away from while he holds the city line.
const assertSwitchAllowed = async (userId, cityId, role) => {
  const Order = require("../models/Order");
  if (role === "driver") {
    const live = await Order.findOne({
      driverId: userId,
      cityId,
      status: { $in: LIVE_ORDER_STATUSES },
    }).select("_id");
    if (live) {
      throw new ApiError(409, "Сначала завершите активную поездку");
    }
  }
};

// Replaces every other role of the person in the city with `role`, keeping the
// driver card only for the driver role.
const replaceRoleInCity = async ({ userId, cityId, role, status = "ACTIVE", reviewedBy }) => {
  if (!CITY_ROLES.includes(role)) {
    throw new ApiError(400, "Недопустимая роль");
  }
  await assertSwitchAllowed(userId, cityId, role);

  const DriverProfile = require("../models/DriverProfile");
  const previous = await Membership.find({ userId, cityId, role: { $ne: role } });
  if (role !== "driver" && previous.some((item) => item.role === "driver")) {
    await DriverProfile.deleteMany({
      membershipId: { $in: previous.filter((item) => item.role === "driver").map((item) => item._id) },
    });
  }
  if (previous.length > 0) {
    await Membership.deleteMany({ _id: { $in: previous.map((item) => item._id) } });
  }

  const membership = await Membership.findOneAndUpdate(
    { userId, cityId, role },
    { $set: { status, ...(reviewedBy && { reviewedBy }), reason: undefined } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return membership;
};

// Removes every membership of the person in the city except `keepRole`.
// A driver card belongs to the driver role only, so it follows its role out.
const dropOtherRoles = async (userId, cityId, keepRole) => {
  const DriverProfile = require("../models/DriverProfile");
  const others = await Membership.find({ userId, cityId, role: { $ne: keepRole } });
  if (others.length === 0) return 0;
  const driverIds = others.filter((item) => item.role === "driver").map((item) => item._id);
  if (driverIds.length > 0) {
    await DriverProfile.deleteMany({ membershipId: { $in: driverIds } });
  }
  await Membership.deleteMany({ _id: { $in: others.map((item) => item._id) } });
  return others.length;
};

module.exports = {
  CITY_ROLES,
  currentRoleInCity,
  replaceRoleInCity,
  assertSwitchAllowed,
  dropOtherRoles,
};
