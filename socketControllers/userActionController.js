const { clearChatRoom, isChatRoomMember } = require("../controllers/chatRoomController");
const { catchSocketError } = require("../utilities/catchAsyncError");

// When user is typing a message
exports.typingController = (io, socket) => {
  socket.on("user:typing", catchSocketError(socket, async (chatRoomId) => {
    if (!(await isChatRoomMember(chatRoomId, socket.userId))) return;

    socket
      .to(chatRoomId)
      .emit("user:typing", { userId: socket.userId, chatRoomId });
  }));
};

// When user is recording a message
exports.recordingcontroller = (io, socket) => {
  socket.on("user:recording", catchSocketError(socket, async (chatRoomId) => {
    if (!(await isChatRoomMember(chatRoomId, socket.userId))) return;

    socket
      .to(chatRoomId)
      .emit("user:recording", { userId: socket.userId, chatRoomId });
  }));

  socket.on("user:recordingStopped", catchSocketError(socket, async (chatRoomId) => {
    if (!(await isChatRoomMember(chatRoomId, socket.userId))) return;

    socket
      .to(chatRoomId)
      .emit("user:recordingStopped", { userId: socket.userId, chatRoomId });
  }));
};

// When user clears a chatRoom
exports.clearChatRoomController = (io, socket) => {
  socket.on("user:chatRoomClear", catchSocketError(socket, async (payload) => {
    const chatRoomId = payload?.chatRoomId;
    if (!(await isChatRoomMember(chatRoomId, socket.userId))) return;
    await clearChatRoom({ chatRoomId });
    io.to(chatRoomId).emit("user:chatRoomClear", { chatRoomId });
  }));
};
