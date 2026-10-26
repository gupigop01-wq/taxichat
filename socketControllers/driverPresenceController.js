const { applyShiftChange, SHIFTS } = require("../services/driverShiftService");

// Throttled presence updates for the free-drivers list (concept 1.6:
// "не чаще раза в 5 секунд")
const lastPresenceEmit = new Map();

const emitPresence = (io, cityId, payload) => {
  const key = String(cityId);
  const now = Date.now();
  if (now - (lastPresenceEmit.get(key) ?? 0) < 5000) return;
  lastPresenceEmit.set(key, now);
  io.to(`city:${key}`).emit("driver:presence", payload);
};

// The state change itself (not just the throttled broadcast) goes to the
// driver who asked for it, so the toggle never depends on the throttle.
const emitShiftState = (io, userId, cityId, profile) => {
  const payload = {
    driverId: String(userId),
    shift: profile.shift,
    shiftNote: profile.shiftNote ?? null,
  };
  io.to(`user:${userId}`).emit("driver:presence", payload);
  io.to(`user:${userId}`).emit("driver:shiftChanged", payload);
  io.to(`city:${cityId}`).emit("driver:presence", payload);
};

const driverProfileFor = async (userId) => {
  const Membership = require("../models/Membership");
  const DriverProfile = require("../models/DriverProfile");
  const membership = await Membership.findOne({
    userId,
    role: "driver",
  }).select("_id cityId status");
  if (!membership || membership.status !== "ACTIVE") return null;
  return {
    membership,
    profile: await DriverProfile.findOne({ membershipId: membership._id }),
  };
};

exports.registerDriverPresenceHandlers = (io, socket) => {
  // Driver goes online or offline for the shift (concept 1.8)
  socket.on("driver:shift", async (payload) => {
    try {
      const shift = payload?.shift;
      if (!SHIFTS.includes(shift)) return;
      if (!socket.userId) return;

      const result = await applyShiftChange({
        userId: socket.userId,
        shift,
        confirmBack: payload?.confirmBack === true,
      });

      // A dispatcher took this driver off the line: the reason is repeated
      // until the driver confirms it explicitly
      if (result.reason === "locked") {
        socket.emit("driver:offline", {
          reason: result.profile.shiftNote,
          needsConfirmation: true,
        });
        return;
      }
      if (!result.ok) return;

      emitPresence(io, result.membership.cityId, {
        driverId: String(socket.userId),
        shift,
      });
      emitShiftState(io, socket.userId, result.membership.cityId, result.profile);
    } catch (error) {
      socket.emit("driver:error", { error: error.message });
    }
  });

  // Heartbeat every 30 seconds; 90 s of silence means offline (job, Этап 5)
  socket.on("driver:heartbeat", async () => {
    try {
      if (!socket.userId) return;
      const context = await driverProfileFor(socket.userId);
      if (!context?.profile) return;
      context.profile.lastSeen = new Date();
      await context.profile.save();
    } catch (error) {
      socket.emit("driver:error", { error: error.message });
    }
  });
};
