const { isChatRoomMember } = require("../controllers/chatRoomController");
const { catchSocketError } = require("../utilities/catchAsyncError");

exports.callRequestController = (io, socket) => {
  socket.on(
    "user:callRequest",
    catchSocketError(socket, async (payload, acknowledgementFn) => {
      const { chatRoomId, signalData, callType } = payload ?? {};
      const reply = typeof acknowledgementFn === "function" ? acknowledgementFn : () => {};
      if (!(await isChatRoomMember(chatRoomId, socket.userId))) return reply(false);

      // The caller is always the verified socket identity
      const callerId = socket.userId;

      // If call receiver is not in room
      const socketsInChatRoom = await io.in(chatRoomId).allSockets();
      if (socketsInChatRoom.size <= 1) {
        reply(false);

        return;
      }

      //   Emit to other user about call request
      socket
        .to(chatRoomId)
        .timeout(5000)
        .emit(
          "user:callRequest",
          { chatRoomId, signalData, userId: callerId, callType },
          (err) => {
            if (err) {
              console.log("How?");
            } else {
              reply(true);
            }
          }
        );
    })
  );
};

exports.callAcceptedController = (io, socket) => {
  socket.on("user:callAccepted", catchSocketError(socket, async (payload) => {
    const { chatRoomId, signalData } = payload ?? {};
    if (!(await isChatRoomMember(chatRoomId, socket.userId))) return;
    socket.to(chatRoomId).emit("user:callAccepted", { signalData });
  }));
};

exports.endCallController = (io, socket) => {
  socket.on("user:endCall", catchSocketError(socket, async (payload) => {
    const { chatRoomId } = payload ?? {};
    if (!(await isChatRoomMember(chatRoomId, socket.userId))) return;
    io.to(chatRoomId).emit("user:endCall");
  }));
};

exports.callDeniedController = (io, socket) => {
  socket.on("user:callDenied", catchSocketError(socket, async (payload) => {
    const { chatRoomId } = payload ?? {};
    if (!(await isChatRoomMember(chatRoomId, socket.userId))) return;
    io.to(chatRoomId).emit("user:callDenied");
  }));
};
