const { randomUUID } = require("crypto");
const Order = require("../models/Order");
const pushService = require("../utilities/pushService");
const Chat = require("../models/Chat");
const Message = require("../models/Message");
const Membership = require("../models/Membership");
const DriverProfile = require("../models/DriverProfile");
const ApiError = require("../utilities/errors");
const { waitingView, waitingFeeText } = require("../utilities/waiting");
const { whenText } = require("./ai/labels");
const botDispatcher = require("./botDispatcher");

const ORDER_STATUSES = [
  "DRAFT",
  "PUBLISHED",
  "BOOKED",
  "ASSIGNED",
  "ARRIVING",
  "WAITING",
  "IN_RIDE",
  "COMPLETED",
  "EXPIRED",
  "CANCELLED",
  "NO_SHOW",
  "DISPUTE",
];

// Allowed transitions with actor roles (concept 1.6). "driver"/"passenger"
// further narrow to the assigned driver / order owner in assertActor.
const TRANSITIONS = {
  publish: {
    from: ["DRAFT"],
    to: "PUBLISHED",
    // "system" publishes scheduled orders at preorder activation
    roles: ["passenger", "system"],
  },
  // Бронь: водитель резервирует заказ на будущее, оставаясь свободным
  // для текущих заказов
  book: {
    from: ["PUBLISHED"],
    to: "BOOKED",
    roles: ["passenger", "driver", "dispatcher", "system"],
  },
  // Активация брони: когда время пришло, водитель приступает к заказу
  activate: {
    from: ["BOOKED"],
    to: "ASSIGNED",
    roles: ["system", "driver", "dispatcher"],
  },
  assign: {
    from: ["PUBLISHED"],
    to: "ASSIGNED",
    roles: ["passenger", "driver", "dispatcher", "system"],
  },
  arrive: { from: ["ASSIGNED"], to: "ARRIVING", roles: ["driver"] },
  wait: { from: ["ARRIVING"], to: "WAITING", roles: ["driver"] },
  start: { from: ["WAITING"], to: "IN_RIDE", roles: ["driver"] },
  undo_start: { from: ["IN_RIDE"], to: "WAITING", roles: ["driver"] },
  finish: { from: ["IN_RIDE"], to: "COMPLETED", roles: ["driver"] },
  no_show: { from: ["WAITING"], to: "NO_SHOW", roles: ["driver"] },
  cancel: {
    from: [
      "DRAFT",
      "PUBLISHED",
      "BOOKED",
      "ASSIGNED",
      "ARRIVING",
      "WAITING",
      "IN_RIDE",
    ],
    to: "CANCELLED",
    // "system" cancels timed-out direct orders (concept 1.6)
    roles: ["passenger", "driver", "dispatcher", "system"],
  },
  dispute: {
    from: ["PUBLISHED", "BOOKED", "ASSIGNED", "ARRIVING", "WAITING", "IN_RIDE"],
    to: "DISPUTE",
    roles: ["passenger", "driver", "dispatcher"],
  },
  expire: { from: ["PUBLISHED"], to: "EXPIRED", roles: ["system"] },
  // A dispatcher closes a dispute: the ride counts as done or as cancelled
  resolve_complete: { from: ["DISPUTE"], to: "COMPLETED", roles: ["dispatcher"] },
  resolve_cancel: { from: ["DISPUTE"], to: "CANCELLED", roles: ["dispatcher"] },
};

const SYSTEM_MESSAGES = {
  publish: "Заказ опубликован",
  book: "Заказ забронирован водителем на указанное время",
  activate: "Время брони наступило: водитель приступает к заказу",
  assign: "Водитель назначен: адреса и телефон водителя открыты в чате",
  arrive: "Водитель выехал",
  wait: "Водитель на месте",
  start: "Поездка началась",
  undo_start: "Водитель отменил начало поездки",
  finish: "Поездка завершена",
  no_show: "Водитель отметил, что пассажир не вышел",
  cancel: "Заказ отменён",
  dispute: "Открыт спор: к чату подключается диспетчер",
  expire: "Время заказа истекло",
  resolve_complete: "Спор закрыт диспетчером: поездка засчитана",
  resolve_cancel: "Спор закрыт диспетчером: заказ отменён",
};

const TERMINAL_STATUSES = ["COMPLETED", "CANCELLED", "NO_SHOW", "EXPIRED"];

// Keep chat/presence side effects in lifecycle order within this process.
// Conditional database updates below still protect concurrent server instances.
const pendingChanges = new Map();
const withOrderChange = async (orderId, change) => {
  const key = String(orderId);
  const previous = pendingChanges.get(key) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  pendingChanges.set(key, current);
  await previous;
  try {
    return await change();
  } finally {
    release();
    if (pendingChanges.get(key) === current) pendingChanges.delete(key);
  }
};

const statusEvents = (order, payload) => [
  { room: `order:${order._id}`, event: "order:status", payload: { ...payload, scope: "order" } },
  { room: `city:${order.cityId}`, event: "order:status", payload: { ...payload, scope: "city" } },
  ...[...new Set([order.passengerId, order.driverId].filter(Boolean).map(String))].map((userId) => ({
    room: `user:${userId}`,
    event: "order:status",
    payload: { ...payload, scope: "order" },
  })),
];

const PENALTY_BAN_THRESHOLD = 10;
const PENALTY_STATUSES = ["ASSIGNED", "ARRIVING", "WAITING", "IN_RIDE"];
// Points fade with time: one point leaves for every full day without a new
// penalty, so old mistakes never accumulate into a lifetime ban
const PENALTY_DECAY_MS = 24 * 60 * 60 * 1000;

// Points still standing today: stored points minus one per full day of quiet
const currentPenaltyPoints = (user, now = Date.now()) => {
  const stored = user.penaltyPoints ?? 0;
  if (stored <= 0) return 0;
  const last = user.penaltyAt ? new Date(user.penaltyAt).getTime() : null;
  if (!last) return stored;
  const days = Math.max(0, Math.floor((now - last) / PENALTY_DECAY_MS));
  return Math.max(0, stored - days);
};

// The actor is at fault unless the evidence excuses him: the driver may leave
// without a penalty only after the no-show window has really expired (the
// driver cannot excuse himself by pressing "wait" a second before cancelling),
// and the passenger is excused only when the driver never reached the pickup.
const lastStatusAt = (order, status) => {
  const entry = [...(order.statusLog ?? [])].reverse().find((item) => item.status === status);
  return entry ? new Date(entry.at).getTime() : null;
};

const isFaultlessCancel = async (order, actor, previousStatus) => {
  if (actor.role !== "driver") return false;
  if (previousStatus !== "WAITING") return false;

  // The snapshot is authoritative: it survives a start/undo cycle, while the
  // status log has a fresh WAITING entry after every undo.
  const waitedAt = order.waiting?.startedAt
    ? new Date(order.waiting.startedAt).getTime()
    : lastStatusAt(order, "WAITING");
  if (!waitedAt) return false;

  let freeMinutes = order.waiting?.freeMinutes;
  if (freeMinutes == null) {
    const City = require("../models/City");
    const city = await City.findById(order.cityId).select("settings.waitingMinutes");
    freeMinutes = city?.settings?.waitingMinutes ?? 10;
  }
  return Date.now() - waitedAt >= freeMinutes * 60 * 1000;
};

// Late cancels by the guilty party add penalty points; the threshold auto-bans
// the account for three days (concept 1.9). The ban lifts by itself (or by an
// admin), and the points have decayed by then.
const applyPenalty = async (order, event, actor, previousStatus) => {
  if (event !== "cancel") return;
  if (!PENALTY_STATUSES.includes(previousStatus)) return;
  if (!["passenger", "driver"].includes(actor.role) || !actor.userId) return;
  if (await isFaultlessCancel(order, actor, previousStatus)) return;

  const User = require("../models/User");
  const { logAudit } = require("../utilities/audit");
  const { disconnectUser } = require("../utilities/sockets");

  const user = await User.findById(actor.userId);
  if (!user || user.isSuperadmin) return;

  const now = Date.now();
  const points = currentPenaltyPoints(user, now) + 1;
  user.penaltyPoints = points;
  user.penaltyAt = new Date(now);
  if (points >= PENALTY_BAN_THRESHOLD && !user.banned) {
    user.banned = true;
    user.banReason = "Автобан за повторные отмены после назначения";
    user.banUntil = new Date(now + 3 * 24 * 60 * 60 * 1000);
    user.bannedAt = new Date(now);
  }
  await user.save();
  if (user.banned) disconnectUser(user._id);

  await logAudit({
    actorId: actor.userId,
    action: user.banned ? "penalty.autoBan" : "penalty.added",
    targetType: "User",
    targetId: user._id,
    payload: {
      orderId: order._id,
      points,
      ...(user.banned && { banUntil: user.banUntil }),
    },
  });
};

// Validates the event against the table and the actor's rights
const assertTransition = (order, event, actor) => {
  const transition = TRANSITIONS[event];
  if (!transition) throw new ApiError(400, "Неизвестное событие заказа");
  if (!transition.from.includes(order.status)) {
    throw new ApiError(
      409,
      `Действие недоступно: заказ в статусе ${order.status}`
    );
  }
  if (!transition.roles.includes(actor.role)) {
    throw new ApiError(403, "Недостаточно прав для этого действия");
  }

  if (actor.role === "passenger") {
    if (String(order.passengerId) !== String(actor.userId))
      throw new ApiError(403, "Это не ваш заказ");
  }
  if (actor.role === "driver") {
    const isAssigned =
      order.driverId && String(order.driverId) === String(actor.userId);
    // The target driver of a direct order may decline it before assignment
    const isDirectTarget =
      order.mode === "direct" &&
      order.status === "PUBLISHED" &&
      String(order.targetDriverId) === String(actor.userId);
    // Booking: a driver reserves a published order (becomes its driver)
    const isBooking = event === "book" && order.status === "PUBLISHED";
    // Activating a booking: only the driver who booked it
    const isActivating =
      event === "activate" &&
      order.status === "BOOKED" &&
      String(order.driverId) === String(actor.userId);
    if (!isAssigned && !isDirectTarget && !isBooking && !isActivating)
      throw new ApiError(403, "Заказ назначен не вам");
  }
  // dispatcher membership in the order city is checked by the caller
};

// Driver presence: busy while assigned, online again afterwards (concept 1.8).
// DriverProfile is keyed by membership, so resolve it first.
const setDriverShift = async (userId, shift) => {
  const membership = await Membership.findOne({ userId, role: "driver" }).select("_id");
  if (!membership) return null;
  return DriverProfile.findOneAndUpdate(
    { membershipId: membership._id },
    { shift },
    { new: true }
  );
};

// Adds the bot system message, refreshes the pinned order card and posts
// the quick action buttons for the new status (concept 1.7)
const updateOrderChat = async (order, { membersToAdd = [], systemText, extraTexts = [] } = {}) => {
  if (!order.chatId) return;

  if (membersToAdd.length > 0) {
    await Chat.updateOne(
      { _id: order.chatId },
      { $addToSet: { members: { $each: membersToAdd } } }
    );
  }

  if (systemText) {
    await botDispatcher.postSystemMessage(order.chatId, systemText);
  }
  for (const text of extraTexts) {
    await botDispatcher.postSystemMessage(order.chatId, text);
  }

  await botDispatcher.upsertOrderCard(order);
  await botDispatcher.postActionButtons(order.chatId, order.status);

  // Messages of finished orders expire after 90 days (concept 1.10)
  if (TERMINAL_STATUSES.includes(order.status)) {
    const expireAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    await Message.updateMany({ chatId: order.chatId }, { $set: { expireAt } });
    await Chat.updateOne(
      { _id: order.chatId },
      { $set: { closedAt: new Date(Date.now() + 30 * 60 * 1000) } }
    );
  }
};

// The single entry point for every status change (concept 1.6).
// Writes statusLog, posts a bot system message to the order chat and returns
// socket events for the caller to emit.
const transition = (order, event, actor, { reason, source } = {}) => withOrderChange(order._id, async () => {
  assertTransition(order, event, actor);

  if (event === "cancel" && !reason)
    throw new ApiError(400, "Укажите причину отмены");

  const previousStatus = order.status;
  const eventId = randomUUID();
  order.status = TRANSITIONS[event].to;
  order.statusLog.push({
    status: order.status,
    eventId,
    by: actor.userId ?? undefined,
    ...(reason && { reason }),
    at: new Date(),
  });

  if (event === "assign" && actor.role === "driver") {
    order.driverId = actor.userId;
  }

  // Бронь: водитель резервирует заказ, не становясь занятым
  if (event === "book") {
    order.driverId = actor.userId;
    order.bookedAt = new Date();
  }

  // Активация брони: заказ переходит в обычный поток
  if (event === "activate") {
    order.activatedAt = new Date();
  }

  let membersToAdd = [];
  let systemText = SYSTEM_MESSAGES[event];

  if (event === "dispute") {
    const dispatchers = await Membership.find({
      cityId: order.cityId,
      role: "dispatcher",
      status: "ACTIVE",
    }).select("userId");
    membersToAdd = dispatchers.map((item) => item.userId);
    systemText = reason
      ? `Открыт спор: ${reason}. К чату подключается диспетчер`
      : SYSTEM_MESSAGES.dispute;
  }

  if (event === "cancel" && reason) {
    systemText = `Заказ отменён: ${reason}`;
  }
  if (event.startsWith("resolve_") && reason) {
    systemText = `${SYSTEM_MESSAGES[event]}. ${reason}`;
  }

  // Paid waiting (city settings): the terms are snapshotted at "Я на месте".
  // Leaving WAITING freezes the accrued minutes; a mistaken start is undone
  // without charging the time in ride.
  const extraTexts = [];
  if (event === "wait") {
    const City = require("../models/City");
    const city = await City.findById(order.cityId).select(
      "tz settings.waitingMinutes settings.waitingPricePerMin"
    );
    const freeMinutes = Math.max(0, city?.settings?.waitingMinutes ?? 10);
    const pricePerMin = Math.max(0, city?.settings?.waitingPricePerMin ?? 0);
    // A booking's free window starts at the booked pickup time, not at the
    // check-in: an early arrival must not eat the passenger's free minutes.
    // A late check-in starts now, so the passenger pays nothing for the
    // driver's own delay.
    const bookedMs =
      order.when?.type === "scheduled" && order.when?.at
        ? new Date(order.when.at).getTime()
        : null;
    const now = Date.now();
    const startsAt = bookedMs && bookedMs > now ? bookedMs : now;
    order.waiting = {
      startedAt: new Date(startsAt),
      freeMinutes,
      pricePerMin,
      endedAt: null,
    };
    const rateText = pricePerMin > 0 ? `, далее ${pricePerMin} ₽/мин` : "";
    extraTexts.push(
      startsAt > now
        ? `Бесплатное ожидание ${freeMinutes} мин${rateText} начнётся по брони: ${whenText(
            order.when,
            city?.tz
          )}`
        : `Бесплатное ожидание ${freeMinutes} мин${rateText}`
    );
  }

  if (
    ["start", "no_show", "cancel", "dispute"].includes(event) &&
    order.waiting?.startedAt &&
    !order.waiting.endedAt
  ) {
    order.waiting.endedAt = new Date();
    const feeText = waitingFeeText(waitingView(order.waiting));
    if (feeText) extraTexts.push(feeText);
  }

  if (event === "undo_start" && order.waiting?.startedAt && order.waiting.endedAt) {
    // The clock was paused by the ride: shift the start forward by the time
    // spent in IN_RIDE, keeping the paid minutes accrued before the start.
    // A booking ride started before the booked time never ran the free window,
    // so its anchor stays on the booked time.
    const startedMs = new Date(order.waiting.startedAt).getTime();
    const endedMs = new Date(order.waiting.endedAt).getTime();
    if (endedMs > startedMs) {
      order.waiting.startedAt = new Date(startedMs + Math.max(0, Date.now() - endedMs));
    }
    order.waiting.endedAt = null;
  }

  if (
    (event === "assign" || event === "activate") &&
    order.driverId
  ) {
    membersToAdd.push(order.driverId);
  }

  if (order.isNew) {
    await order.save();
  } else {
    // Status, timestamps, assignment and log become visible together. The
    // version also rejects stale snapshots after a status cycle (start/undo).
    await order.validate();
    const changes = order.getChanges();
    changes.$inc = { ...changes.$inc, __v: 1 };
    const committed = await Order.findOneAndUpdate(
      {
        _id: order._id,
        status: previousStatus,
        __v: order.__v === undefined ? { $exists: false } : order.__v,
      },
      changes,
      { new: true, runValidators: true }
    );
    if (!committed)
      throw new ApiError(409, "Заказ уже изменён другим участником");

    order = committed;
  }

  await updateOrderChat(order, { membersToAdd, systemText, extraTexts });

  // Booking does NOT take the driver offline: he stays free for current
  // orders; he becomes busy only when the booking is activated
  if ((event === "assign" || event === "activate") && order.driverId) {
    await setDriverShift(order.driverId, "busy");
  }
  if (TERMINAL_STATUSES.includes(order.status) && order.driverId) {
    await setDriverShift(order.driverId, "online");
  }

  // Waiting timer for the no-show window (concept 1.6)
  if (event === "wait") {
    const { scheduleWaitingTimer } = require("../jobs/index");
    await scheduleWaitingTimer(order);
  }

  // Penalty points for late cancels (concept 1.9)
  await applyPenalty(order, event, actor, previousStatus);

  const base = {
    orderId: order._id,
    eventId,
    status: order.status,
    previousStatus,
    by: actor.userId,
    passengerId: String(order.passengerId),
    driverId: order.driverId ? String(order.driverId) : null,
  };
  const events = statusEvents(order, base);

  // Fire-and-forget web push to participants (skips the actor on PUBLISHED)
  void pushService
    .notifyOrderStatus(order, { status: order.status, eventId, actorId: actor.userId })
    .catch(() => undefined);

  // Mirror the change into the AI dispatcher threads of everyone involved
  await require("./ai/orderFeed").notifyOrderEvent(order, {
    event,
    actor,
    reason,
    source,
  });

  return { order, events, previousStatus };
});

// Atomic assignment used by every assign path (concept 1.6: first-take race)
const assignAtomically = (orderId, driverId, actor, { priceAgreed, source } = {}) => withOrderChange(orderId, async () => {
  const eventId = randomUUID();
  const order = await Order.findOneAndUpdate(
    { _id: orderId, status: "PUBLISHED" },
    {
      $set: {
        status: "ASSIGNED",
        driverId,
        ...(priceAgreed && { priceAgreed }),
      },
      $push: {
        statusLog: { status: "ASSIGNED", eventId, by: actor.userId, at: new Date() },
      },
      $inc: { __v: 1 },
    },
    { new: true }
  );

  if (!order) throw new ApiError(409, "Заказ уже назначен или недоступен");

  await updateOrderChat(order, {
    membersToAdd: [driverId],
    systemText: SYSTEM_MESSAGES.assign,
  });

  await setDriverShift(driverId, "busy");

  const assigned = {
    orderId: order._id,
    eventId,
    status: "ASSIGNED",
    previousStatus: "PUBLISHED",
    by: actor.userId,
    passengerId: String(order.passengerId),
    driverId: String(driverId),
  };
  const events = statusEvents(order, assigned);

  void pushService
    .notifyOrderStatus(order, { status: "ASSIGNED", eventId, actorId: actor.userId })
    .catch(() => undefined);

  await require("./ai/orderFeed").notifyOrderEvent(order, {
    event: "assign",
    actor,
    source,
  });

  return { order, events };
});

module.exports = {
  ORDER_STATUSES,
  TRANSITIONS,
  SYSTEM_MESSAGES,
  transition,
  assignAtomically,
};
