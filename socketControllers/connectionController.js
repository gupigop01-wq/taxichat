const {
  checkMembersOffUndeliveredListInMessage,
  isChatRoomMember,
} = require("../controllers/chatRoomController");
const User = require("../models/User");
const Membership = require("../models/Membership");

exports.getSocketDetails = async (userId) => {
  // Get user model
  const userModel = await User.findById(userId);
  if (!userModel) return { userModel: null, allRoomsUserIn: [] };

  // Get all rooms
  const allRoomsUserIn = userModel.chatRooms.map((room) => room.toString());

  return { userModel, allRoomsUserIn };
};

// Joins the membership-scoped rooms: user, city, driver zones (concept 1.13)
exports.joinMembershipRooms = async (socket, userId) => {
  socket.join(`user:${userId}`);

  const memberships = await Membership.find({ userId, status: "ACTIVE" }).select(
    "cityId zones role"
  );
  for (const membership of memberships) {
    socket.join(`city:${membership.cityId}`);
    if (membership.role === "driver") {
      for (const zoneId of membership.zones ?? []) {
        socket.join(`zone:${zoneId}`);
      }
    }
  }
};

exports.onlineController = (io, socket) => {
  socket.on("user:online", async () => {
    // The verified userId from the handshake; client-provided ids are ignored
    const userId = socket.userId;
    if (!userId) return;
    // Join membership rooms first so no events are missed
    await this.joinMembershipRooms(socket, userId);

    // Get user detaiils
    const { userModel, allRoomsUserIn } = await this.getSocketDetails(userId);
    if (!userModel) return;

    //   Make user join rooms
    socket.join(allRoomsUserIn);

    //   Update database on status
    userModel.status = {
      online: true,
      lastSeen: undefined,
    };

    for (let properties of userModel.undeliveredMessages) {
      await checkMembersOffUndeliveredListInMessage({
        membersId: [userId],
        io,
        ...properties,
      });
    }

    userModel.undeliveredMessages = [];

    // Save user model
    await userModel.save({ validateBeforeSave: false });

    // Emit user online status in all rooms user is in
    socket.to(allRoomsUserIn).emit("user:online", userId);
  });
};

exports.offlineController = (io, socket) => {
  socket.on("user:offline", async () => {
    const { userId } = socket;
    if (!userId) return;
    // Get user detaiils
    const { userModel, allRoomsUserIn } = await this.getSocketDetails(userId);
    if (!userModel) return;

    const time = new Date(Date.now()).toISOString();

    userModel.status = {
      online: false,
      lastSeen: time,
    };

    await userModel.save({ validateBeforeSave: false });

    socket
      .to(allRoomsUserIn)
      .emit("user:offline", { userId: userModel._id, time });
  });
};

// socket disconnection
exports.disconnectingController = (io, socket) => {
  socket.on("disconnecting", async () => {
    if (!socket.userId) return;
    // Get user detaiils
    const { userModel, allRoomsUserIn } = await this.getSocketDetails(
      socket.userId
    );
    if (!userModel) return;

    const time = new Date(Date.now()).toISOString();

    userModel.status = {
      online: false,
      lastSeen: time,
    };

    await userModel.save({ validateBeforeSave: false });

    socket
      .to(allRoomsUserIn)
      .emit("user:offline", { userId: userModel._id, time });
  });
};

exports.joinRoomController = (io, socket) => {
  // Only legacy chat rooms the verified user is a member of; system rooms
  // (user:, city:, zone:, order:) are never joinable from the client
  socket.on("user:joinRooms", async (payload) => {
    if (!socket.userId) return;
    const rooms = Array.isArray(payload?.rooms) ? payload.rooms : [];
    for (const room of rooms) {
      if (await isChatRoomMember(room, socket.userId)) socket.join(String(room));
    }
  });
};
