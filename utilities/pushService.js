// Web Push (VAPID) sender. Missing keys keep pushes disabled (the in-app
// notices and socket events still work), but a missing web-push package is a
// broken deployment: the dependency is required and is reported loudly once.
let webpush = null;
let packageError = null;
try {
  webpush = require("web-push");
} catch (error) {
  packageError = error;
  console.error(
    "[push] FATAL: the web-push package is not installed — push notifications are disabled. " +
      "Run `npm install` (web-push is a required dependency).",
    error.message
  );
}

let configured = false;
let keysWarned = false;
let packageWarned = false;
const configure = () => {
  if (configured) return true;
  if (!webpush) {
    if (!packageWarned) {
      packageWarned = true;
      console.error("[push] push is unavailable: the web-push package is missing", packageError?.message ?? "");
    }
    return false;
  }
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    if (!keysWarned) {
      keysWarned = true;
      // Tests deliberately run without keys: the warning is for deployments
      if (process.env.NODE_ENV !== "test") {
        console.warn(
          "[push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not set — push notifications are disabled. " +
            "Generate keys with `npx web-push generate-vapid-keys` and put them in .env."
        );
      }
    }
    return false;
  }
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
  results.forEach((result, index) => {
    const tail = subscriptions[index].endpoint.slice(-10);
    if (result.status === "fulfilled") {
      console.log(`[push] sent ${payload?.kind ?? "?"} ...${tail} status=${result.value?.statusCode}`);
    } else {
      console.warn(`[push] failed ${payload?.kind ?? "?"} ...${tail} ${result.reason?.statusCode ?? ""} ${result.reason?.message ?? ""}`);
    }
  });
  if (deadIds.length) await PushSubscription.deleteMany({ _id: { $in: deadIds } });
  return { sent: subscriptions.length - deadIds.length, failed: deadIds.length };
};

// Pushes to every active driver of a city (new order fan-out on the go).
// New work belongs to the drivers who are on the line: a driver who went off
// shift should not be woken for somebody else's ride.
const sendPushToCityDrivers = async (cityId, payload, { excludeUserId } = {}) => {
  if (!configure()) return { sent: 0, skipped: "push-not-configured" };
  const Membership = require("../models/Membership");
  const DriverProfile = require("../models/DriverProfile");
  const memberships = await Membership.find({
    cityId,
    role: "driver",
    status: "ACTIVE",
  }).select("_id userId");
  if (!memberships.length) return { sent: 0 };
  const profiles = await DriverProfile.find({
    membershipId: { $in: memberships.map((membership) => membership._id) },
    shift: "online",
  }).select("membershipId");
  const userIdByMembership = new Map(
    memberships.map((membership) => [String(membership._id), String(membership.userId)])
  );
  const recipientIds = profiles
    .map((profile) => userIdByMembership.get(String(profile.membershipId)))
    .filter((id) => id && id !== String(excludeUserId ?? ""));
  const results = await Promise.allSettled(
    recipientIds.map((id) => sendPushToUser(id, payload))
  );
  return { sent: results.filter((result) => result.value?.sent > 0).length };
};

// Pushes to the dispatchers and the region admin of a city.
const sendPushToCityStaff = async (cityId, payload, { excludeUserId } = {}) => {
  const results = await Promise.all(
    ["dispatcher", "region_admin"].map((role) =>
      sendPushToCityRole(cityId, role, payload, { excludeUserId })
    )
  );
  return { sent: results.filter((result) => result.sent > 0).length };
};

const sendPushToCityRole = async (cityId, role, payload, { excludeUserId } = {}) => {
  if (!configure()) return { sent: 0, skipped: "push-not-configured" };
  const Membership = require("../models/Membership");
  const memberships = await Membership.find({ cityId, role, status: "ACTIVE" }).select("userId");
  const recipientIds = memberships
    .map((membership) => String(membership.userId))
    .filter((id) => id !== String(excludeUserId ?? ""));
  const results = await Promise.allSettled(recipientIds.map((id) => sendPushToUser(id, payload)));
  return { sent: results.filter((result) => result.value?.sent > 0).length };
};

// SOS reached the city dispatchers: it must interrupt, so it is its own
// high-priority card and stays on screen until handled.
const notifyCitySos = async (cityId, { complaintId, from, reporterName } = {}) => {
  if (!configure()) return { sent: 0, skipped: "push-not-configured" };
  const payload = {
    kind: "sos",
    title: "SOS · сигнал пассажира",
    body: [reporterName, from].filter(Boolean).join(" · ") || "Открыт заказ",
    speakText: "SOS. Сигнал пассажира",
    tag: "bombila-sos",
    renotify: true,
    url: "/?sos=1",
    complaintId: String(complaintId ?? ""),
    requireInteraction: true,
    actions: [{ action: "open", title: "Открыть" }],
  };
  return sendPushToCityStaff(cityId, payload);
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
    // The service worker posts /accept with this id when "Принять" is tapped
    orderId: String(order._id ?? order.id),
    offerId: String(offer._id ?? offer.id),
    requireInteraction: true,
    actions: [
      { action: "accept", title: "Принять" },
      { action: "decline", title: "Отказаться" },
    ],
  };
  return sendPushToUser(order.passengerId ?? order.passenger, payload);
};

// New published order for the drivers of the city and the city staff
// (dispatcher and region admin see the order in their queue and watch it).
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
  const [drivers, staff] = await Promise.all([
    sendPushToCityDrivers(order.cityId, payload, { excludeUserId }),
    sendPushToCityStaff(order.cityId, { ...payload, kind: "new-order-staff" }, { excludeUserId }),
  ]);
  return { sent: Math.max(drivers.sent ?? 0, staff.sent ?? 0), drivers, staff };
};


// The ride was rated: both participants learn about it (the star count and
// who rated whom), so nobody misses that feedback arrived.
const notifyOrderRated = async (order, { stars, fromRole, fromName } = {}) => {
  if (!configure()) return { sent: 0, skipped: "push-not-configured" };
  const text =
    fromRole === "passenger"
      ? `Пассажир оценил поездку: ${stars} из 5 ★`
      : `Водитель оценил поездку: ${stars} из 5 ★`;
  const payload = {
    kind: "rating",
    title: "Оценка поездки",
    body: text,
    speakText: text,
    tag: "bombila-live",
    renotify: true,
    url: "/",
    orderId: String(order._id ?? order.id),
  };
  const recipients = [];
  if (order.passengerId) recipients.push(String(order.passengerId));
  if (order.driverId) recipients.push(String(order.driverId));
  const results = await Promise.allSettled(recipients.map((id) => sendPushToUser(id, payload)));
  return { sent: results.filter((result) => result.value?.sent > 0).length };
};
module.exports = {
  configure,
  publicKey,
  sendPushToUser,
  sendPushToCityDrivers,
  sendPushToCityStaff,
  notifyOrderStatus,
  notifyNewOffer,
  notifyNewOrder,
  notifyOrderRated,
  notifyCitySos,
  // test-only: forget the cached "configured" state between scenarios
  __resetConfiguredForTests: () => {
    configured = false;
    keysWarned = false;
    packageWarned = false;
  },
};


