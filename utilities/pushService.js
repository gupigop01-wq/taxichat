// Web Push (VAPID) sender. The web-push package is optional at runtime: when
// it (or VAPID keys) are missing, pushes are skipped gracefully instead of
// crashing the order flow — the in-app notices and socket events still work.
let webpush = null;
try {
  webpush = require("web-push");
} catch {
  webpush = null;
}

let configured = false;
const configure = () => {
  if (configured) return true;
  if (!webpush) return false;
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:admin@bombila.app",
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
  configured = true;
  return true;
};

const publicKey = () => (configure() ? process.env.VAPID_PUBLIC_KEY : undefined);

// Sends one payload to every saved subscription of the user. Dead endpoints
// (404/410) are pruned so stale phones stop costing requests.
const sendPushToUser = async (userId, payload) => {
  if (!configure()) return { sent: 0, skipped: "push-not-configured" };
  const PushSubscription = require("../models/PushSubscription");
  const subscriptions = await PushSubscription.find({ userId: new (require("mongoose").Types.ObjectId)(userId) });
  if (subscriptions.length === 0) return { sent: 0 };
  const body = JSON.stringify(payload);
  const results = await Promise.allSettled(
    subscriptions.map((subscription) =>
      webpush.sendNotification(subscription, body)
    )
  );
  const deadIds = subscriptions.filter(
    (subscription, index) =>
      results[index].status === "rejected" && [404, 410].includes(results[index].reason?.statusCode)
  ).map((subscription) => subscription._id);
  if (deadIds.length) await PushSubscription.deleteMany({ _id: { $in: deadIds } });
  return { sent: subscriptions.length - deadIds.length, failed: deadIds.length };
};

// Pushes to every active driver of a city (new order fan-out on the go).
const sendPushToCityDrivers = async (cityId, payload, { excludeUserId } = {}) => {
  if (!configure()) return { sent: 0, skipped: "push-not-configured" };
  const Membership = require("../models/Membership");
  const memberships = await Membership.find({ cityId, role: "driver", status: "ACTIVE" }).select("userId");
  const recipientIds = memberships
    .map((membership) => String(membership.userId))
    .filter((id) => id !== String(excludeUserId ?? ""));
  const results = await Promise.allSettled(recipientIds.map((id) => sendPushToUser(id, payload)));
  return { sent: results.filter((result) => result.value?.sent > 0).length };
};

const STATUS_TEXTS = {
  ASSIGNED: "Водитель назначен",
  ARRIVING: "Водитель выехал к вам",
  WAITING: "Водитель на месте",
  IN_RIDE: "Поездка началась",
  COMPLETED: "Поездка завершена",
  CANCELLED: "Заказ отменён",
  EXPIRED: "Время заказа истекло",
  NO_SHOW: "Пассажир не вышел",
  DISPUTE: "Открыт спор по заказу",
  PUBLISHED: "Заказ опубликован, водители видят его",
  BOOKED: "Заказ забронирован",
};

// Status change: both participants get the human-readable push (the actor
// themselves can skip it on PUBLISHED — they just created the order).
const notifyOrderStatus = async (order, { status, eventId, actorId, driverName } = {}) => {
  if (!configure()) return { sent: 0, skipped: "push-not-configured" };
  const text = STATUS_TEXTS[status] ?? status;
  const payload = {
    kind: "status",
    title: "Бомбила",
    body: `Заказ: ${text}`,
    speakText: `Заказ. ${text}`,
    // One live card in the tray: a newer notice replaces the previous one
    tag: "bombila-live",
    renotify: true,
    url: "/",
    orderId: String(order._id ?? order.id),
    eventId,
  };
  const recipients = new Set();
  if (order.passengerId) recipients.add(String(order.passengerId));
  if (order.driverId) recipients.add(String(order.driverId));
  const exclude = String(actorId ?? "");
  const results = await Promise.allSettled(
    [...recipients].map((id) => (id === exclude ? Promise.resolve({ sent: 0 }) : sendPushToUser(id, payload)))
  );
  return { sent: results.filter((result) => result.value?.sent > 0).length };
};

// Live offer for the passenger: actionable notification (buttons on Android).
const notifyNewOffer = async (order, offer, { driverName, priceText, etaMin } = {}) => {
  if (!configure()) return { sent: 0, skipped: "push-not-configured" };
  const payload = {
    kind: "offer",
    title: "Отклик водителя",
    body: `${driverName ?? "Водитель"} — ${priceText ?? ""} ₽, подача ${etaMin ?? "?"} мин`,
    speakText: `Отклик водителя. Цена ${priceText ?? ""} ₽`,
    tag: "bombila-live",
    renotify: true,
    url: "/",
    orderId: String(order._id ?? order.id),
    requireInteraction: true,
    actions: [
      { action: "accept", title: "Принять" },
      { action: "decline", title: "Отказаться" },
    ],
  };
  return sendPushToUser(order.passengerId ?? order.passenger, payload);
};

// New published order for the drivers of the city.
const notifyNewOrder = async (order, { excludeUserId } = {}) => {
  if (!configure()) return { sent: 0, skipped: "push-not-configured" };
  const payload = {
    kind: "new-order",
    title: "Новый заказ в городе",
    body: order.to?.text ? `${order.from?.text ?? ""} → ${order.to.text}` : order.from?.text ?? "",
    tag: "bombila-live",
    renotify: true,
    url: "/",
    orderId: String(order._id ?? order.id),
    requireInteraction: true,
    actions: [{ action: "open", title: "Открыть" }],
  };
  return sendPushToCityDrivers(order.cityId, payload, { excludeUserId });
};

module.exports = {
  configure,
  publicKey,
  sendPushToUser,
  sendPushToCityDrivers,
  notifyOrderStatus,
  notifyNewOffer,
  notifyNewOrder,
  // test-only: forget the cached "configured" state between scenarios
  __resetConfiguredForTests: () => {
    configured = false;
  },
};

