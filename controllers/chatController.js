const { z } = require("zod");
const mongoose = require("mongoose");
const Chat = require("../models/Chat");
const Message = require("../models/Message");
const City = require("../models/City");
const User = require("../models/User");
const Membership = require("../models/Membership");
const DriverProfile = require("../models/DriverProfile");
const ApiError = require("../utilities/errors");
const catchAsyncError = require("../utilities/catchAsyncError");
const { validateBody } = require("../utilities/catchAsyncError");
const { emitOrderEvents } = require("../utilities/sockets");
const { carCaption } = require("../utilities/drivers");

const PHONE_PATTERN = /(\+?7|8)[\s\-()]?\d{3}[\s\-()]?\d{3}[\s\-()]?\d{2}[\s\-()]?\d{2}/;
const URL_PATTERN = /(https?:\/\/|www\.)\S+|\b[\w-]+\.(?:ru|рф|com|net|org)\b/i;

const messageSchema = z.union([
  z.object({
    body: z.string().trim().min(1, "Введите сообщение").max(2000, "Сообщение слишком длинное"),
  }),
  z.object({
    kind: z.literal("photo"),
    imageUrl: z.string().min(1, "Не передано фото"),
  }),
  z.object({
    kind: z.literal("voice"),
    voiceNoteUrl: z.string().min(1, "Не передана голосовая запись"),
    voiceNoteDuration: z.number().int().min(1, "Длительность от 1 секунды").max(600),
  }),
]);

const offerSchema = z.object({
  priceText: z.string().trim().min(1, "Укажите цену").max(50),
  etaMin: z.number().int().min(1, "Укажите время подачи").max(180),
});

exports.messageSchema = messageSchema;
exports.offerSchema = offerSchema;

const getDirectChatForUser = async (chatId, userId) => {
  if (!mongoose.isValidObjectId(chatId))
    throw new ApiError(400, "Некорректный идентификатор чата");

  const chat = await Chat.findById(chatId);
  if (!chat) throw new ApiError(404, "Чат не найден");
  if (chat.type !== "direct" && chat.type !== "order")
    throw new ApiError(400, "Неподдерживаемый тип чата");

  const isMember = chat.members.some((member) => String(member) === String(userId));
  if (!isMember) throw new ApiError(403, "Нет доступа к этому чату");

  return chat;
};

const serializeMessage = (message, userId) => ({
  _id: message._id,
  kind: message.kind,
  body: message.body,
  meta: message.meta,
  senderType: message.senderType,
  senderId: message.senderId?._id ?? message.senderId,
  senderName: message.senderId?.name,
  mine: message.senderId
    ? String(message.senderId._id ?? message.senderId) === String(userId)
    : false,
  createdAt: message.createdAt,
});

// GET /api/chats/my — dialogs from direct calls (concept 1.6): peer name,
// car caption and last message preview; phone numbers stay hidden
exports.listMyChats = catchAsyncError(async (req, res) => {
  const chats = await Chat.find({ members: req.user._id, type: "direct" })
    .sort({ lastActivityAt: -1 })
    .limit(50);

  const chatIds = chats.map((chat) => chat._id);
  const peerIds = [
    ...new Set(
      chats.map((chat) =>
        String(chat.members.find((member) => String(member) !== String(req.user._id)))
      )
    ),
  ].filter((id) => id && id !== "undefined");

  const [peers, lastMessages] = await Promise.all([
    User.find({ _id: { $in: peerIds } }).select("name username"),
    Message.aggregate([
      { $match: { chatId: { $in: chatIds } } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: "$chatId",
          kind: { $first: "$kind" },
          body: { $first: "$body" },
          createdAt: { $first: "$createdAt" },
        },
      },
    ]),
  ]);

  const peerMemberships = await Membership.find({
    userId: { $in: peerIds },
    role: "driver",
  }).select("userId _id");
  const profiles = await DriverProfile.find({
    membershipId: { $in: peerMemberships.map((membership) => membership._id) },
  });
  const profileByUser = new Map();
  for (const membership of peerMemberships) {
    const profile = profiles.find(
      (item) => String(item.membershipId) === String(membership._id)
    );
    if (profile) profileByUser.set(String(membership.userId), profile);
  }
  const peerById = new Map(peers.map((peer) => [String(peer._id), peer]));
  const lastByChat = new Map(
    lastMessages.map((entry) => [String(entry._id), entry])
  );

  // Unread human messages per dialog for the current viewer
  const unreadAgg = await Message.aggregate([
    {
      $match: {
        chatId: { $in: chatIds },
        senderType: "user",
        senderId: { $ne: req.user._id },
        readBy: { $ne: req.user._id },
      },
    },
    { $group: { _id: "$chatId", count: { $sum: 1 } } },
  ]);
  const unreadByChat = new Map(
    unreadAgg.map((entry) => [String(entry._id), entry.count])
  );

  res.json({
    status: "success",
    data: {
      chats: chats
        .map((chat) => {
          const peerId = String(
            chat.members.find((member) => String(member) !== String(req.user._id))
          );
          const peer = peerById.get(peerId);
          const profile = profileByUser.get(peerId);
          const last = lastByChat.get(String(chat._id));
          return {
            _id: chat._id,
            // Order behind the dialog: needed to get call credentials
            orderId: chat.orderId ?? null,
            peer: peer ? { _id: peer._id, name: peer.name } : { name: "Удалённый пользователь" },
            carCaption: profile?.car
              ? carCaption(profile.car)
              : undefined,
            lastMessage: last
              ? { kind: last.kind, body: last.body, createdAt: last.createdAt }
              : null,
            unreadCount: unreadByChat.get(String(chat._id)) ?? 0,
            lastActivityAt: chat.lastActivityAt,
            closedAt: chat.closedAt,
          };
        })
        .filter(Boolean),
    },
  });
});

// POST /api/chats/:id/read — mark all messages of the dialog as read
exports.markChatRead = catchAsyncError(async (req, res) => {
  const chat = await getDirectChatForUser(req.params.id, req.user._id);

  const result = await Message.updateMany(
    {
      chatId: chat._id,
      senderType: "user",
      senderId: { $ne: req.user._id },
      readBy: { $ne: req.user._id },
    },
    { $addToSet: { readBy: req.user._id } }
  );

  res.json({
    status: "success",
    data: { marked: result.modifiedCount ?? 0 },
  });
});

// GET /api/chats/:id/messages?before=
exports.listChatMessages = catchAsyncError(async (req, res) => {
  const chat = await getDirectChatForUser(req.params.id, req.user._id);

  const before = req.query.before ? new Date(req.query.before) : null;
  const filter = { chatId: chat._id };
  if (before) filter.createdAt = { $lt: before };

  const messages = await Message.find(filter)
    .sort({ createdAt: -1 })
    .limit(50)
    .populate("senderId", "username name");

  res.json({
    status: "success",
    data: { messages: messages.reverse().map((message) => serializeMessage(message, req.user._id)) },
  });
});

// POST /api/chats/:id/messages — text, photo and voice messages
exports.sendChatMessage = [
  validateBody(messageSchema),
  catchAsyncError(async (req, res) => {
    const chat = await getDirectChatForUser(req.params.id, req.user._id);

    const city = await City.findById(chat.cityId).select("settings.filterContacts");
    if (city?.settings?.filterContacts && req.body.body) {
      if (PHONE_PATTERN.test(req.body.body) || URL_PATTERN.test(req.body.body)) {
        throw new ApiError(
          400,
          "Отправка телефонных номеров и ссылок запрещена настройками города"
        );
      }
    }

    const message = await Message.create({
      chatId: chat._id,
      senderId: req.user._id,
      senderType: "user",
      ...(req.body.body
        ? { kind: "text", body: req.body.body }
        : req.body.kind === "photo"
          ? { kind: "photo", body: "Фото", meta: { imageUrl: req.body.imageUrl } }
          : {
              kind: "voice",
              body: "Голосовое сообщение",
              meta: {
                voiceNoteUrl: req.body.voiceNoteUrl,
                voiceNoteDuration: req.body.voiceNoteDuration,
              },
            }),
    });
    await Chat.updateOne({ _id: chat._id }, { $set: { lastActivityAt: new Date() } });

    // Direct chats have no room; notify each member personally
    const events = chat.members
      .filter((member) => String(member) !== String(req.user._id))
      .map((member) => ({
        room: `user:${member}`,
        event: "chat:message",
        payload: {
          chatId: String(chat._id),
          messageId: message._id,
          senderId: req.user._id,
          senderName: req.user.name,
          body: message.body,
          createdAt: message.createdAt,
        },
      }));
    emitOrderEvents(events);

    res.status(201).json({
      status: "success",
      data: { message: serializeMessage(message, req.user._id) },
    });
  }),
];

// POST /api/chats/:id/offers — driver sends an offer card (price + ETA) that
// the passenger can accept to prefill the order form (concept 1.6)
exports.sendChatOffer = [
  validateBody(offerSchema),
  catchAsyncError(async (req, res) => {
    const chat = await getDirectChatForUser(req.params.id, req.user._id);

    const message = await Message.create({
      chatId: chat._id,
      senderId: req.user._id,
      senderType: "user",
      kind: "offer",
      body: `Предложение: ${req.body.priceText}, подача через ${req.body.etaMin} мин`,
      meta: {
        priceText: req.body.priceText,
        etaMin: req.body.etaMin,
        driverId: req.user._id,
      },
    });
    await Chat.updateOne({ _id: chat._id }, { $set: { lastActivityAt: new Date() } });

    const events = chat.members
      .filter((member) => String(member) !== String(req.user._id))
      .map((member) => ({
        room: `user:${member}`,
        event: "chat:message",
        payload: {
          chatId: String(chat._id),
          messageId: message._id,
          kind: "offer",
          senderId: req.user._id,
          senderName: req.user.name,
          meta: message.meta,
          createdAt: message.createdAt,
        },
      }));
    emitOrderEvents(events);

    res.status(201).json({
      status: "success",
      data: { message: serializeMessage(message, req.user._id) },
    });
  }),
];
