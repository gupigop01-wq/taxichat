const {
  addMessageToChatRoom,
  checkMembersOffUndeliveredListInMessage,
  addMessageAsUndeliveredToUser,
  addMessageAsUnreadToUser,
  markMessageAsReadByUser,
  isChatRoomMember,
} = require("../controllers/chatRoomController");
const { catchSocketError } = require("../utilities/catchAsyncError");

// Sliding-window flood guard: max 30 message packets per minute per socket
const MESSAGE_RATE_LIMIT = 30;
const messageBuckets = new Map();

const allowMessage = (socket) => {
  const now = Date.now();
  const bucket = (messageBuckets.get(socket.id) ?? []).filter(
    (time) => now - time < 60 * 1000
  );
  if (bucket.length >= MESSAGE_RATE_LIMIT) {
    messageBuckets.set(socket.id, bucket);
    return false;
  }
  bucket.push(now);
  messageBuckets.set(socket.id, bucket);
  return true;
};

exports.messagingController = (io, socket) => {
  socket.once("disconnect", () => messageBuckets.delete(socket.id));
  socket.on("user:message", catchSocketError(socket, async (payload) => {
    const chatRoomId = payload?.chatRoomId;
    const message = payload?.message;
    if (!message || typeof message !== "object") return;
    if (!(await isChatRoomMember(chatRoomId, socket.userId))) {
      socket.emit("chat:error", { error: "Нет доступа к этому чату" });
      return;
    }

    if (!allowMessage(socket)) {
      socket.emit("chat:error", {
        error: "Слишком много сообщений, подождите минуту",
      });
      return;
    }

    // The sender is always the verified socket identity
    message.sender = socket.userId;

    // Save message to database
    const { messageObj, day } = await addMessageToChatRoom(chatRoomId, message);

    // Broadcast message to room
    io.timeout(180000)
      .to(chatRoomId)
      .emit(
        "user:message",
        {
          chatRoomId,
          message: messageObj,
          day,
          userId: socket.userId,
        },
        async (error, membersId) => {
          try {
            if (error) {
              // The receiving client left before acknowledging; the message
              // is already stored and marked undelivered
              console.log("message ack error:", error.message ?? error);
              return;
            }
            if (!Array.isArray(membersId)) return;

            // Unique identifier of a message in chatRoom
            const uniqueMessageDetails = {
              chatRoomId,
              day,
              messageId: messageObj._id,
            };

            // Remove members from undelivered list
            const { undeliveredMembers } =
              await checkMembersOffUndeliveredListInMessage({
                ...uniqueMessageDetails,
                membersId: membersId.map((id) => id.toString()),
                io,
              });

            // Add message as undelivered to members that aren't currently online
            await addMessageAsUndeliveredToUser({
              ...uniqueMessageDetails,
              undeliveredMembers,
            });

            // Add message as unread to all members of the room except sender of the messagee
            await addMessageAsUnreadToUser({
              ...uniqueMessageDetails,
              unreadMembers: messageObj.unreadMembers.filter(
                (memberId) =>
                  memberId.toString() !== messageObj.sender.toString()
              ),
            });

            // Emit to all users that message can be read
            io.to(chatRoomId).emit("user:messageCanBeRead", {
              ...uniqueMessageDetails,
              message: messageObj,
            });
          } catch (bookkeepingError) {
            // Delivery bookkeeping must never crash the process
            console.log(
              "delivery bookkeeping failed:",
              bookkeepingError.message ?? bookkeepingError
            );
          }
        }
      );
  }));
};

exports.markMessageReadController = (io, socket) => {
  socket.on(
    "user:messageRead",
    catchSocketError(socket, async ({ messageId, chatRoomId, day } = {}) => {
      if (!(await isChatRoomMember(chatRoomId, socket.userId))) return;
      await markMessageAsReadByUser({
        messageId,
        chatRoomId,
        day,
        userId: socket.userId,
        io,
      });
    })
  );

  socket.on(
    "user:markMessagesAsRead",
    catchSocketError(socket, async ({ messages, chatRoomId } = {}) => {
      if (!Array.isArray(messages)) return;
      if (!(await isChatRoomMember(chatRoomId, socket.userId))) return;
      for (let { messageId, day } of messages) {
        await markMessageAsReadByUser({
          messageId,
          chatRoomId,
          day,
          userId: socket.userId,
          io,
        });
      }
    })
  );
};
