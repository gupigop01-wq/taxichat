const { z } = require("zod");
const City = require("../models/City");
const Message = require("../models/Message");
const AiSession = require("../models/AiSession");
const ApiError = require("../utilities/errors");
const catchAsyncError = require("../utilities/catchAsyncError");
const { loadMemberships, canReviewInCity } = require("../utilities/rbac");
const agent = require("../services/ai/agent");
const llmClient = require("../services/ai/llmClient");
const { PROVIDERS } = require("../services/ai/config");
const {
  WELCOME,
  ensureSession,
  emitToUser,
  serializeMessage,
} = require("../services/ai/sessions");

// REST surface of the AI dispatcher chat. One thread per user + city + role,
// stored as a regular Chat of type "ai" so history, moderation and TTL rules
// stay the same as in the other chats.

const ROLES = ["passenger", "driver", "dispatcher"];

const chatQuerySchema = z.object({
  cityId: z.string().min(1, "Не указан город"),
  role: z.enum(ROLES, { message: "Неизвестная роль" }),
});

const messageSchema = z.object({
  cityId: z.string().min(1, "Не указан город"),
  role: z.enum(ROLES, { message: "Неизвестная роль" }),
  text: z.string().trim().min(1, "Введите сообщение").max(2000, "Сообщение слишком длинное"),
});

const confirmSchema = z.object({
  cityId: z.string().min(1, "Не указан город"),
  role: z.enum(ROLES, { message: "Неизвестная роль" }),
  approve: z.boolean(),
});

const parseQuery = (query) => {
  const parsed = chatQuerySchema.safeParse({ cityId: query.cityId, role: query.role });
  if (!parsed.success) throw new ApiError(400, parsed.error.issues[0].message);
  return parsed.data;
};

const loadCity = async (cityId) => {
  const city = await City.findById(cityId).select("name status settings tz");
  if (!city) throw new ApiError(404, "Город не найден");
  return city;
};

const findMembership = (memberships, cityId, role) =>
  memberships.find(
    (item) =>
      item.role === role &&
      item.status === "ACTIVE" &&
      String(item.cityId?._id ?? item.cityId) === String(cityId)
  );

const assertRole = async (req, cityId, role) => {
  const membership = findMembership(req.memberships ?? [], cityId, role);
  if (membership) return membership;
  // Dispatcher powers are shared with region admins of the region and with
  // the superadmin — the same rule the rest of the API uses.
  if (role === "dispatcher" && (await canReviewInCity(req, cityId))) return null;
  const label = { passenger: "пассажира", driver: "водителя", dispatcher: "диспетчера" }[role];
  throw new ApiError(403, `У вас нет активной роли ${label} в этом городе`);
};

// One AI thread per user + city + role lives in services/ai/sessions.js

const buildContext = ({ req, city, cityId, role, session }) => ({
  user: req.user,
  userId: req.user._id,
  city,
  cityId,
  role,
  memberships: req.memberships ?? [],
  session,
});

const saveBotReply = async ({ session, userId, result }) => {
  const meta = {
    ...(result.quick?.length && { quick: result.quick }),
    ...(result.confirm && { confirm: result.confirm }),
    ...(result.orderId && { orderId: result.orderId }),
    ...(result.degraded && { degraded: true }),
  };
  const message = await Message.create({
    chatId: session.chatId,
    senderType: "bot",
    kind: "text",
    body: result.text,
    meta,
  });
  emitToUser(userId, "ai:message", {
    chatId: String(session.chatId),
    message: serializeMessage(message, userId),
  });
  return message;
};

// GET /api/ai/status — diagnostics for the app and the admin
exports.getStatus = catchAsyncError(async (req, res) => {
  res.json({
    status: "success",
    data: {
      ai: llmClient.status(),
      providers: Object.keys(PROVIDERS),
      roles: ROLES,
    },
  });
});

// GET /api/ai/chats — all AI threads of the user (city/role switcher)
exports.listChats = catchAsyncError(async (req, res) => {
  const sessions = await AiSession.find({ userId: req.user._id })
    .populate("cityId", "name status")
    .sort({ updatedAt: -1 })
    .limit(30);

  res.json({
    status: "success",
    data: {
      chats: sessions.map((session) => ({
        cityId: session.cityId?._id ?? session.cityId,
        cityName: session.cityId?.name,
        cityStatus: session.cityId?.status,
        role: session.role,
        turns: session.turns,
        lastUserAt: session.lastUserAt,
        pending: Boolean(session.pending),
      })),
    },
  });
});

// GET /api/ai/chat?cityId=&role= — history and the current pending action
exports.getChat = [
  loadMemberships,
  catchAsyncError(async (req, res) => {
    const { cityId, role } = parseQuery(req.query);
    const city = await loadCity(cityId);
    await assertRole(req, cityId, role);
    const session = await ensureSession({ userId: req.user._id, cityId, role });

    const messages = await Message.find({ chatId: session.chatId })
      .sort({ createdAt: -1 })
      .limit(80);
    const aiStatus = llmClient.status();

    res.json({
      status: "success",
      data: {
        chatId: session.chatId,
        cityId,
        role,
        cityName: city.name,
        quick: agent.DEFAULT_QUICK[role],
        pending: session.pending,
        ai: {
          provider: aiStatus.provider,
          configured: aiStatus.configured,
          keyCount: aiStatus.keyCount,
        },
        messages: messages.reverse().map((message) => serializeMessage(message, req.user._id)),
      },
    });
  }),
];

// POST /api/ai/messages — one user turn, answered synchronously
exports.sendMessage = [
  loadMemberships,
  catchAsyncError(async (req, res) => {
    const parsed = messageSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0].message);
    const { cityId, role, text } = parsed.data;
    const city = await loadCity(cityId);
    await assertRole(req, cityId, role);
    const session = await ensureSession({ userId: req.user._id, cityId, role });

    const userMessage = await Message.create({
      chatId: session.chatId,
      senderId: req.user._id,
      senderType: "user",
      kind: "text",
      body: text,
    });
    emitToUser(req.user._id, "ai:message", {
      chatId: String(session.chatId),
      message: serializeMessage(userMessage, req.user._id),
    });
    emitToUser(req.user._id, "ai:typing", { chatId: String(session.chatId), typing: true });

    const started = Date.now();
    let result;
    try {
      result = await agent.runTurn({
        ctx: buildContext({ req, city, cityId, role, session }),
        text,
      });
    } catch (error) {
      // The chat must stay alive even when a tool or the model breaks
      result = {
        text: "Не получилось обработать сообщение. Попробуйте сформулировать проще.",
        quick: agent.DEFAULT_QUICK[role],
        degraded: true,
      };
      // eslint-disable-next-line no-console
      console.error("[ai] turn failed:", error.message);
    }

    agent.remember(session, text, result.text);
    await session.save();

    const reply = await saveBotReply({ session, userId: req.user._id, result });
    emitToUser(req.user._id, "ai:typing", { chatId: String(session.chatId), typing: false });

    res.json({
      status: "success",
      data: {
        chatId: session.chatId,
        userMessage: serializeMessage(userMessage, req.user._id),
        reply: serializeMessage(reply, req.user._id),
        text: result.text,
        quick: result.quick ?? [],
        ...(result.confirm && { confirm: result.confirm }),
        ...(result.orderId && { orderId: String(result.orderId) }),
        ...(result.degraded && { degraded: true }),
        latencyMs: Date.now() - started,
      },
    });
  }),
];

// POST /api/ai/confirm — the user approves or drops a destructive action
exports.confirm = [
  loadMemberships,
  catchAsyncError(async (req, res) => {
    const parsed = confirmSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0].message);
    const { cityId, role, approve } = parsed.data;
    const city = await loadCity(cityId);
    await assertRole(req, cityId, role);
    const session = await ensureSession({ userId: req.user._id, cityId, role });
    if (!session.pending) throw new ApiError(409, "Нет действия, ожидающего подтверждения");

    const decision = approve ? "Подтверждаю" : "Отмена";
    const userMessage = await Message.create({
      chatId: session.chatId,
      senderId: req.user._id,
      senderType: "user",
      kind: "text",
      body: decision,
    });
    emitToUser(req.user._id, "ai:message", {
      chatId: String(session.chatId),
      message: serializeMessage(userMessage, req.user._id),
    });
    emitToUser(req.user._id, "ai:typing", { chatId: String(session.chatId), typing: true });

    const result = await agent
      .confirmPending(buildContext({ req, city, cityId, role, session }), approve)
      .finally(() => {
        emitToUser(req.user._id, "ai:typing", { chatId: String(session.chatId), typing: false });
      });

    agent.remember(session, decision, result.text);
    await session.save();

    const reply = await saveBotReply({ session, userId: req.user._id, result });

    res.json({
      status: "success",
      data: {
        chatId: session.chatId,
        userMessage: serializeMessage(userMessage, req.user._id),
        reply: serializeMessage(reply, req.user._id),
        text: result.text,
        quick: result.quick ?? [],
        ...(result.orderId && { orderId: String(result.orderId) }),
      },
    });
  }),
];

exports.WELCOME = WELCOME;
