const Membership = require("../../models/Membership");
const DriverProfile = require("../../models/DriverProfile");
const Order = require("../../models/Order");

const BUSY_STATUSES = ["ASSIGNED", "ARRIVING", "WAITING", "IN_RIDE"];

const carCaption = (profile) =>
  [profile?.car?.color, profile?.car?.plate, profile?.car?.brand]
    .filter(Boolean)
    .join(" ");

// The city's drivers with their live state. Integration point for "связка
// пассажир ↔ водитель": the AI picks from this list, then acts through the
// order state machine, never by editing collections directly.
const listDrivers = async ({ cityId, onlineOnly = false, limit = 20 } = {}) => {
  const memberships = await Membership.find({
    cityId,
    role: "driver",
    status: "ACTIVE",
  }).select("_id userId");

  if (memberships.length === 0) return [];

  const profiles = await DriverProfile.find({
    membershipId: { $in: memberships.map((item) => item._id) },
  });

  const busyDriverIds = new Set(
    (
      await Order.find({
        cityId,
        status: { $in: BUSY_STATUSES },
        driverId: { $ne: null },
      }).select("driverId")
    ).map((order) => String(order.driverId))
  );

  const byMembership = new Map(
    memberships.map((item) => [String(item._id), item])
  );

  const drivers = profiles.map((profile) => {
    const membership = byMembership.get(String(profile.membershipId));
    const busy = busyDriverIds.has(String(membership?.userId));
    const online = profile.shift === "online" && !busy;
    return {
      membershipId: profile.membershipId,
      userId: membership?.userId,
      displayName: profile.displayName,
      phone: profile.phone,
      carCaption: carCaption(profile),
      shift: profile.shift,
      shiftNote: profile.shiftNote ?? null,
      acceptDirectCalls: profile.acceptDirectCalls !== false,
      rating: profile.rating,
      ratingCount: profile.ratingCount ?? 0,
      lastSeen: profile.lastSeen,
      busy,
      online,
    };
  });

  const filtered = onlineOnly ? drivers.filter((driver) => driver.online) : drivers;

  // Best first: free and online, then rating, then the most recent heartbeat
  filtered.sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    const ratingA = a.rating ?? 0;
    const ratingB = b.rating ?? 0;
    if (ratingA !== ratingB) return ratingB - ratingA;
    return new Date(b.lastSeen ?? 0) - new Date(a.lastSeen ?? 0);
  });

  return filtered.slice(0, limit);
};

const findDriverByMembership = async (cityId, membershipId) => {
  if (!membershipId) return null;
  const membership = await Membership.findOne({
    _id: membershipId,
    cityId,
    role: "driver",
    status: "ACTIVE",
  }).select("_id userId");
  if (!membership) return null;
  const profile = await DriverProfile.findOne({ membershipId: membership._id });
  if (!profile) return null;
  return {
    membershipId: membership._id,
    userId: membership.userId,
    displayName: profile.displayName,
    phone: profile.phone,
    carCaption: carCaption(profile),
    shift: profile.shift,
  };
};

const matchSummary = (drivers, { limit = 3 } = {}) => {
  const free = drivers.filter((driver) => driver.online && driver.acceptDirectCalls);
  if (free.length === 0) return "Свободных водителей сейчас нет";
  return free
    .slice(0, limit)
    .map((driver) => `${driver.displayName}${driver.carCaption ? ` (${driver.carCaption})` : ""}`)
    .join(", ");
};

module.exports = {
  BUSY_STATUSES,
  carCaption,
  listDrivers,
  findDriverByMembership,
  matchSummary,
};
