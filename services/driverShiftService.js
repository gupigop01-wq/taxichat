const Membership = require("../models/Membership");
const DriverProfile = require("../models/DriverProfile");

const SHIFTS = ["online", "offline"];

// Single place where a driver's shift is written. A dispatcher's "taken off
// the line" note is a lock on the shift: only an explicit confirmation from
// the driver clears it, whichever transport (socket or REST) asks for online.
const applyShiftChange = async ({ userId, shift, confirmBack = false, cityId }) => {
  if (!SHIFTS.includes(shift)) return { ok: false, reason: "unknown-shift" };

  const membership = await Membership.findOne({
    userId,
    role: "driver",
    ...(cityId && { cityId }),
  }).select("_id cityId status");
  if (!membership || membership.status !== "ACTIVE") return { ok: false, reason: "no-membership" };

  const profile = await DriverProfile.findOne({ membershipId: membership._id });
  if (!profile) return { ok: false, reason: "no-profile" };

  const lockedByDispatcher = Boolean(profile.shiftNote);
  if (shift === "online" && lockedByDispatcher && confirmBack !== true) {
    return { ok: false, reason: "locked", membership, profile };
  }
  if (shift === "online" && confirmBack === true) {
    profile.shiftNote = null;
    profile.shiftChangedBy = undefined;
    profile.shiftChangedAt = undefined;
  }
  profile.shift = shift;
  profile.lastSeen = new Date();
  await profile.save();
  return { ok: true, membership, profile };
};

module.exports = { applyShiftChange, SHIFTS };
