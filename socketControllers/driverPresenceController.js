const Membership = require("../models/Membership");
const DriverProfile = require("../models/DriverProfile");

const SHIFTS = ["online", "offline"];

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

const driverProfileFor = async (userId) => {
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

      const context = await driverProfileFor(socket.userId);
      if (!context?.profile) return;

      // Going back online clears the note a dispatcher left when he took the
      // driver off the line
      if (shift === "online") {
        context.profile.shiftNote = null;
        context.profile.shiftChangedBy = undefined;
        context.profile.shiftChangedAt = undefined;
      }
      context.profile.shift = shift;
      context.profile.lastSeen = new Date();
      await context.profile.save();

      emitPresence(io, context.membership.cityId, {
        driverId: String(socket.userId),
        shift,
      });
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
