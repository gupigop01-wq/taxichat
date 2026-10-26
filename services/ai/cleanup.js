const mongoose = require("mongoose");
const Chat = require("../../models/Chat");
const Message = require("../../models/Message");
const Order = require("../../models/Order");
const AiSession = require("../../models/AiSession");

// Housekeeping of the AI dispatcher threads. A thread mirrors every order
// event, so without a sweep it turns into an unreadable log. The chat is a
// status line, not a history: every sweep leaves the welcome bubble plus one
// single message — the newest one that belongs to an order still in flight.
// When nothing is in flight the thread holds only the greeting. A confirmation
// nobody answered in half an hour is stale.
const TERMINAL = ["COMPLETED", "CANCELLED", "NO_SHOW", "EXPIRED"];
const OFFER_EVENT = "offer";

const PENDING_MS = 30 * 60 * 1000;

const isTerminal = (status) => TERMINAL.includes(status);

const isStatusEvent = (message) => message.meta?.kind === "order_event";

// Live pruning rule, applied the moment an order changes (the periodic sweep
// is stricter and keeps a single bubble). A group holds everything that
// mentions the order — status events as well as agent answers like
// "Назначил …" or "Доступные заказы …" that carry meta.orderId.
const keepIdsFor = (messages, status) => {
  const sorted = [...messages].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );
  if (!sorted.length) return new Set();

  if (isTerminal(status)) {
    // A dead order leaves one trace: the message that reported its end. When
    // the thread never got that message, everything it says is obsolete too.
    const terminalMessage = sorted.find(
      (message) => isStatusEvent(message) && TERMINAL.includes(message.meta?.status)
    );
    return terminalMessage ? new Set([String(terminalMessage._id)]) : new Set();
  }

  const statusEvents = sorted.filter(isStatusEvent);
  const seenStatuses = statusEvents.map((message) => message.meta?.status).filter(Boolean);
  // A thread that only ever saw the order while it was open was watching a
  // broadcast. Once the ride went elsewhere, its copy is obsolete.
  if (
    status !== "PUBLISHED" &&
    seenStatuses.length &&
    seenStatuses.every((value) => value === "PUBLISHED")
  ) {
    return new Set();
  }

  const keep = new Set();
  // Answers and confirmations stay readable while the order is alive.
  for (const message of sorted) {
    if (!isStatusEvent(message)) keep.add(String(message._id));
  }
  const latestStatus = statusEvents.find(
    (message) => message.meta?.event !== OFFER_EVENT
  );
  if (latestStatus) keep.add(String(latestStatus._id));
  // Offers stay clickable only while the order is still published
  if (status === "PUBLISHED") {
    for (const message of statusEvents) {
      if (message.meta?.event === OFFER_EVENT) keep.add(String(message._id));
    }
  }
  if (!keep.size) keep.add(String(sorted[0]._id));
  return keep;
};

const staleFrom = (messages, statusByOrder) => {
  const groups = new Map();
  for (const message of messages) {
    const orderId = String(message.meta?.orderId ?? "");
    const status = statusByOrder.get(orderId);
    if (!orderId || !status) continue;
    const key = `${message.chatId}:${orderId}`;
    const group = groups.get(key) ?? [];
    group.push(message);
    groups.set(key, group);
  }

  const stale = [];
  for (const group of groups.values()) {
    const status = statusByOrder.get(String(group[0].meta?.orderId ?? ""));
    const keep = keepIdsFor(group, status);
    for (const message of group) {
      if (!keep.has(String(message._id))) stale.push(message);
    }
  }
  return stale;
};

// Order ids are stored as strings in feed messages and as ObjectIds in the
// legacy order cards, so a lookup has to ask for both shapes.
const orderIdFilter = (orderId) => {
  const id = String(orderId);
  const values = [id];
  if (mongoose.isValidObjectId(id)) values.push(new mongoose.Types.ObjectId(id));
  return { $in: values };
};

const deleteStale = async (stale) => {
  const removed = {};
  if (!stale.length) return { count: 0, removed };
  for (const event of stale) {
    const chatId = String(event.chatId);
    (removed[chatId] ||= []).push(String(event._id));
  }
  const result = await Message.deleteMany({
    _id: { $in: stale.map((event) => event._id) },
  });
  return { count: result.deletedCount ?? 0, removed };
};

const mergeRemoved = (target, source) => {
  for (const [chatId, ids] of Object.entries(source)) {
    (target[chatId] ||= []).push(...ids);
  }
};

// Live pruning after a feed message: the thread is brought to the state of
// the order at the moment it changed, without waiting for the sweep.
const pruneOrderEvents = async ({ orderId, status, chatId } = {}) => {
  if (!orderId || !status) return {};
  const query = { "meta.orderId": orderIdFilter(orderId) };
  if (chatId) query.chatId = chatId;
  const messages = await Message.find(query)
    .select("_id chatId meta createdAt")
    .lean();
  if (!messages.length) return {};

  const stale = staleFrom(messages, new Map([[String(orderId), status]]));
  return (await deleteStale(stale)).removed;
};

const cleanupAiChats = async () => {
  const chats = await Chat.find({ type: "ai" }).select("_id").lean();
  const chatIds = chats.map((chat) => chat._id);
  const summary = {
    messages: 0,
    orderEvents: 0,
    pending: 0,
    removed: {},
  };
  if (!chatIds.length) return summary;

  // One pass over every thread, newest first: the first message that mentions
  // an order still in flight is the one worth showing, everything else goes.
  const messages = await Message.find({ chatId: { $in: chatIds } })
    .select("_id chatId meta createdAt")
    .sort({ createdAt: -1 })
    .lean();

  const orderIds = [
    ...new Set(
      messages.map((message) => String(message.meta?.orderId ?? "")).filter(Boolean)
    ),
  ];
  const orders = orderIds.length
    ? await Order.find({ _id: { $in: orderIds } }).select("_id status").lean()
    : [];
  const activeOrders = new Set(
    orders
      .filter((order) => !isTerminal(order.status))
      .map((order) => String(order._id))
  );

  // The welcome bubble stays: it is the only explanation of what the thread is
  // for. The order bubble is one per chat, so a second live order does not
  // stack up in the same thread.
  const keep = new Set();
  const anchored = new Set();
  for (const message of messages) {
    if (message.meta?.welcome) keep.add(String(message._id));
    const orderId = String(message.meta?.orderId ?? "");
    if (!activeOrders.has(orderId)) continue;
    const chatId = String(message.chatId);
    if (anchored.has(chatId)) continue;
    anchored.add(chatId);
    keep.add(String(message._id));
  }

  // Only ids from this snapshot are deleted: a message delivered while the
  // sweep runs is left for the next one instead of vanishing unannounced.
  const stale = messages.filter((message) => !keep.has(String(message._id)));
  const deleted = await deleteStale(stale);
  summary.orderEvents = stale.filter((message) => message.meta?.orderId).length;
  summary.messages = stale.length - summary.orderEvents;
  mergeRemoved(summary.removed, deleted.removed);

  // Confirmations that were never answered
  const pending = await AiSession.updateMany(
    { pending: { $ne: null }, "pending.createdAt": { $lt: new Date(Date.now() - PENDING_MS) } },
    { $set: { pending: null } }
  );
  summary.pending = pending.modifiedCount ?? 0;

  return summary;
};

module.exports = { cleanupAiChats, pruneOrderEvents };
