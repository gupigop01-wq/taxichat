const Chat = require("../../models/Chat");
const Message = require("../../models/Message");
const AiSession = require("../../models/AiSession");
const agent = require("./agent");
const { getIo } = require("../../utilities/sockets");

// Shared plumbing for AI dispatcher threads: one thread per user + city + role,
// stored as a regular Chat of type "ai" so history, moderation and TTL rules
// stay the same as in the other chats. Both the REST controller and the
// proactive order feed write through this module.

const WELCOME = {
  passenger:
    "🚕 Здравствуйте! Я AI-диспетчер. Напишите, откуда и куда ехать, — оформлю заказ. Могу показать отклики водителей, статус поездки, отменить заказ или открыть спор.",
  driver:
    "🚗 Здравствуйте! Я AI-диспетчер. Скажите «на линии», чтобы начать смену. Покажу доступные заказы, помогу отправить отклик и провести поездку по шагам.",
  dispatcher:
    "🚦 Здравствуйте! Я AI-диспетчер города. Скажите «обстановка», «свободные водители», «назначь <имя>» или «закрой спор».",
};

// Handles the rare upsert race: the unique index is the source of truth.
const ensureSession = async ({ userId, cityId, role }) => {
  let session = await AiSession.findOne({ userId, cityId, role });
  if (session) {
    const chatExists = await Chat.exists({ _id: session.chatId });
    if (chatExists) {
      // Threads created before the welcome got its emoji keep the old bubble:
      // refresh it in place so every chat opens with the same styled text
      await Message.updateOne(
        { chatId: session.chatId, "meta.welcome": true, body: { $ne: WELCOME[role] } },
        { $set: { body: WELCOME[role] } }
      );
      return session;
    }
    session.chatId = (
      await Chat.create({ type: "ai", cityId, members: [userId] })
    )._id;
    await session.save();
    return session;
  }

  const chat = await Chat.create({ type: "ai", cityId, members: [userId] });
  try {
    session = await AiSession.create({ userId, cityId, role, chatId: chat._id });
  } catch (error) {
    if (error.code === 11000) {
      await Chat.deleteOne({ _id: chat._id });
      session = await AiSession.findOne({ userId, cityId, role });
      if (session) return session;
    }
    throw error;
  }

  await Message.create({
    chatId: chat._id,
    senderType: "bot",
    kind: "text",
    body: WELCOME[role],
    meta: { quick: agent.DEFAULT_QUICK[role], welcome: true },
  });
  return session;
};

const emitToUser = (userId, event, payload) => {
  const io = getIo();
  if (!io) return;
  io.to(`user:${userId}`).emit(event, payload);
};

const serializeMessage = (message, userId) => ({
  _id: message._id,
  chatId: message.chatId,
  kind: message.kind,
  body: message.body,
  meta: message.meta,
  senderType: message.senderType,
  senderId: message.senderId,
  mine: message.senderType === "user" && String(message.senderId) === String(userId),
  createdAt: message.createdAt,
});

module.exports = { WELCOME, ensureSession, emitToUser, serializeMessage };
