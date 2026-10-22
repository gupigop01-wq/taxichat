const socketIO = require("socket.io");
const jwt = require("jsonwebtoken");
const { setIo } = require("./utilities/sockets");
const { catchSocketError } = require("./utilities/catchAsyncError");

// Parses the handshake Cookie header into an object
const parseCookies = (header) => {
  const result = {};
  for (const part of (header ?? "").split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) continue;
    try {
      result[trimmed.slice(0, separatorIndex)] = decodeURIComponent(
        trimmed.slice(separatorIndex + 1)
      );
    } catch {
      // Invalid URL-encoded cookies are not authentication credentials.
    }
  }
  return result;
};

const { AUTH_COOKIE } = require("./utilities/auth");

const {
  callRequestController,
  callAcceptedController,
  endCallController,
  callDeniedController,
} = require("./socketControllers/callController");

const {
  onlineController,
  offlineController,
  disconnectingController,
  joinRoomController,
} = require("./socketControllers/connectionController");
const { orderRoomController } = require("./socketControllers/orderRoomController");
const {
  messagingController,
  markMessageReadController,
} = require("./socketControllers/messageController");

const {
  typingController,
  recordingcontroller,
  clearChatRoomController,
} = require("./socketControllers/userActionController");

const { registerOrderCallHandlers } = require("./socketControllers/orderCallController");
const { registerDriverPresenceHandlers } = require("./socketControllers/driverPresenceController");
const callService = require("./services/callService");

// Attaches Socket.io to an http server; exported as a factory so tests can
// run it on an ephemeral port
const initSocket = (httpServer) => {
  const io = socketIO(httpServer);
  setIo(io);

  // Handshake auth: the JWT cookie is verified server-side and the verified
  // userId is bound to the socket; client-provided ids are never trusted
  // (concept 1.13: entrance only through ACTIVE memberships)
  io.use(async (socket, next) => {
    const cookies = parseCookies(socket.handshake.headers.cookie);
    const token = cookies[AUTH_COOKIE];
    if (!token) {
      socket.userId = null;
      return next();
    }
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET_KEY);
      socket.userId = String(payload.userId);
    } catch (error) {
      socket.userId = null;
      return next();
    }
    // Banned accounts get no live connection
    try {
      const User = require("./models/User");
      const user = await User.findById(socket.userId).select("banned");
      if (!user || user.banned) socket.userId = null;
    } catch (error) {
      socket.userId = null;
    }
    next();
  });

  io.on("connection", (socket) => {
    // -------------Connection controls -------------- //
    // socket come online
    onlineController(io, socket);

    // live order rooms (order:<id>) for participants only
    orderRoomController(io, socket);

    // socket goes offline
    offlineController(io, socket);

    // socket disconnecting
    disconnectingController(io, socket);

    // socket joins new room
    joinRoomController(io, socket);
    //--------------------------------------------------//

    // -------------User Action controls -------------- //
    // User typing
    typingController(io, socket);

    // User recording
    recordingcontroller(io, socket);

    // User clears chat room
    clearChatRoomController(io, socket);
    //--------------------------------------------------//

    // -------------Message controls -------------- //
    // User sends message
    messagingController(io, socket);

    // User reads message
    markMessageReadController(io, socket);

    //--------------------------------------------------//

    // ----------------- Legacy call controls --------------- //
    // User makes call request
    callRequestController(io, socket);

    // User accepts call
    callAcceptedController(io, socket);

    // User ends call
    endCallController(io, socket);

    // User denies call
    callDeniedController(io, socket);
    //--------------------------------------------------//

    // ----------- Order voice call signaling ------------ //
    registerOrderCallHandlers(io, socket);
    //--------------------------------------------------//

    // ----------- Driver shift and heartbeat ------------ //
    registerDriverPresenceHandlers(io, socket);
    //--------------------------------------------------//

    socket.on("disconnect", catchSocketError(socket, async () => {
      if (socket.userId) {
        await callService.handleDisconnect(io, socket.userId);
      }
    }));
  });

  return io;
};

module.exports = initSocket;
