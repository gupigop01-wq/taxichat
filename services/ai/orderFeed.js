const City = require("../../models/City");
const Membership = require("../../models/Membership");
const Message = require("../../models/Message");
const AiSession = require("../../models/AiSession");
const DriverProfile = require("../../models/DriverProfile");
const { ensureSession, emitToUser, serializeMessage } = require("./sessions");
const { pruneOrderEvents } = require("./cleanup");
const { routeText, whenText } = require("./labels");
const { waitingView } = require("../../utilities/waiting");

// Proactive order feed for the AI dispatcher chat. Every status change made
// anywhere in the app (order card, driver buttons, dispatcher panel, AI tools,
// timers) is mirrored into the AI threads of the people it concerns: order
// participants get their side of the story, city dispatchers and region admins
// get the queue view with management buttons. The message carries meta.actions,
// so the chat itself can run the action without opening the card.

const TERMINAL = ["COMPLETED", "CANCELLED", "NO_SHOW", "EXPIRED"];
const CANCELABLE = [
  "DRAFT",
  "PUBLISHED",
  "BOOKED",
  "ASSIGNED",
  "ARRIVING",
  "WAITING",
  "IN_RIDE",
];
const DRIVER_PHASE = ["ASSIGNED", "ARRIVING", "WAITING", "IN_RIDE"];

const ref = (order) => `#${String(order._id).slice(-6)}`;

const apiAction = (key, label, path, body, { danger = false } = {}) => ({
  key,
  label,
  type: "api",
  method: "POST",
  path,
  ...(body && { body }),
  ...(danger && { danger: true }),
});

// Buttons a given role may legally press in the current status (mirrors
// TRANSITIONS in orderService; the server still re-validates every call).
const actionsFor = (role, order, userId) => {
  if (TERMINAL.includes(order.status)) return [];
  const id = String(order._id);
  const cancel = () =>
    apiAction("cancel", "Отменить заказ", `/api/orders/${id}/cancel`, {
      reason: "Отмена из AI-чата",
    }, { danger: true });
  const dispute = () =>
    apiAction("dispute", "Открыть спор", `/api/orders/${id}/dispute`, {
      reason: "Разногласия по поездке",
    }, { danger: true });
  const step = (key, label, action) =>
    apiAction(key, label, `/api/orders/${id}/action`, { action });

  if (role === "driver") {
    // A published order is the drivers' feed: the button mirrors the way this
    // order can be claimed, so nobody has to type "откликнусь за 300" by hand.
    if (!order.driverId) {
      if (order.status !== "PUBLISHED") return [];
      if (order.mode === "direct" && String(order.targetDriverId) !== String(userId)) return [];
      if (order.when?.type === "scheduled")
        return [apiAction("book", "Забронировать", `/api/orders/${id}/book`)];
      if (order.mode === "direct" || order.matchMode === "first_take")
        return [apiAction("accept", "Взять заказ", `/api/orders/${id}/accept`)];
      return [{ key: "offer", label: "Откликнуться", type: "offer" }];
    }
    // Only the driver of this order drives it; a driver who merely sees the
    // published order must not get cancel/dispute buttons for someone else.
    if (String(order.driverId) !== String(userId)) return [];
    const list = [];
    if (order.status === "BOOKED") list.push(step("activate", "Приступить к брони", "activate"));
    if (order.status === "ASSIGNED") list.push(step("arrive", "Выехал к пассажиру", "arrive"));
    if (order.status === "ARRIVING") list.push(step("wait", "Я на месте", "wait"));
    if (order.status === "WAITING") list.push(step("start", "Начать поездку", "start"));
    if (order.status === "IN_RIDE") list.push(step("finish", "Завершить поездку", "finish"));
    if (CANCELABLE.includes(order.status)) list.push(cancel());
    if (DRIVER_PHASE.includes(order.status)) list.push(dispute());
    return list;
  }

  if (role === "passenger") {
    const list = [];
    if (CANCELABLE.includes(order.status)) list.push(cancel());
    if (["PUBLISHED", ...DRIVER_PHASE].includes(order.status)) list.push(dispute());
    return list;
  }

  // dispatcher / region admin
  const list = [];
  if (CANCELABLE.includes(order.status)) list.push(cancel());
  if (order.status === "DISPUTE") {
    list.push(
      apiAction("resolve_complete", "Поездка состоялась", `/api/orders/${id}/resolve`, {
        outcome: "complete",
      })
    );
    list.push(
      apiAction("resolve_cancel", "Закрыть с отменой", `/api/orders/${id}/resolve`, {
        outcome: "cancel",
      }, { danger: true })
    );
  }
  return list;
};

const actorLabel = (actor) =>
  ({ passenger: "пассажир", driver: "водитель", dispatcher: "диспетчер", system: "система" }[
    actor?.role
  ] ?? "система");

const driverCaption = (profile) =>
  profile
    ? [profile.displayName, profile.car?.color, profile.car?.plate, profile.car?.brand]
        .filter(Boolean)
        .join(" · ")
    : "водитель";

const loadDriverProfile = async (userId) => {
  if (!userId) return null;
  const membership = await Membership.findOne({ userId, role: "driver" }).select("_id");
  if (!membership) return null;
  return DriverProfile.findOne({ membershipId: membership._id });
};

// Text per event and per audience: the passenger reads "к вам", the driver
// reads "вы", the staff reads the neutral queue wording. Every line starts
// with a themed emoji and parameters (route, time, price, reason) get their
// own line, so a long thread stays scannable on a phone.
const eventText = (order, event, { role, actor, reason, driver, tz }) => {
  const tag = ref(order);
  const route = routeText(order);
  const line = route ? `\n📍 ${route}` : "";
  const staff = role === "dispatcher";
  const waiting = waitingView(order.waiting);
  const waitingTerms = waiting
    ? `\n⏳ Бесплатно ${waiting.freeMinutes} мин${
        waiting.pricePerMin > 0 ? ` · далее ${waiting.pricePerMin} ₽/мин` : ""
      }${
        new Date(waiting.startedAt).getTime() > Date.now()
          ? ` · отсчёт по брони ${whenText(order.when, tz)}`
          : ""
      }`
    : "";
  const waitingFee =
    waiting && waiting.fee > 0
      ? `\n💰 Ожидание: ${waiting.paidMinutes} мин · ${waiting.fee} ₽`
      : "";

  switch (event) {
    case "publish": {
      const base = `🆕 Новый заказ ${tag}${line}\n🕒 ${whenText(order.when, tz)} · 👥 ${order.pax} пасс. · 🚦 ищет водителя${
        order.notes ? `\n📝 ${order.notes}` : ""
      }`;
      return base;
    }
    case "book":
      return `🔖 Бронь ${tag}${line}\n🕒 ${whenText(order.when, tz)}`;
    case "activate":
      return `🚕 Бронь активирована, водитель приступает\n${tag}${line}`;
    case "assign":
      return `👨‍✈️ Водитель назначен на заказ ${tag}${line}\n🚗 ${driver}`;
    case "arrive":
      if (role === "passenger") return `🚕 Водитель выехал к вам\n${tag}${line}`;
      if (role === "driver") return `🚗 Вы выехали к пассажиру\n${tag}${line}`;
      return `🚕 Водитель выехал\n${tag}${line}`;
    case "wait":
      if (role === "passenger")
        return `📍 Водитель на месте, ожидает вас\n${tag}${line}${waitingTerms}`;
      if (role === "driver")
        return `📍 Вы отметили, что на месте\n${tag}${line}${waitingTerms}`;
      return `📍 Водитель на месте\n${tag}${line}${waitingTerms}`;
    case "start":
      return `🛣 Поездка началась\n${tag}${line}${waitingFee}`;
    case "undo_start":
      return `⏸ Поездка ещё не началась\n${tag} снова в ожидании${line}`;
    case "finish":
      return `🏁 Поездка завершена\n${tag}${line}${
        order.priceAgreed ? `\n💰 ${order.priceAgreed}` : ""
      }${waitingFee}`;
    case "no_show":
      return `🚫 Пассажир не вышел\n${tag}${line}${waitingFee}`;
    case "cancel":
      return `❌ Заказ ${tag} отменён${line}\n👤 Кто: ${actorLabel(actor)}${
        reason ? `\n📝 Причина: ${reason}` : ""
      }${waitingFee}`;
    case "dispute":
      return `⚠️ Открыт спор по заказу ${tag}${line}${
        reason ? `\n📝 Причина: ${reason}` : ""
      }${waitingFee}`;
    case "resolve_complete":
      return `✅ Спор закрыт: поездка засчитана\n${tag}${line}${reason ? `\n📝 ${reason}` : ""}`;
    case "resolve_cancel":
      return `✅ Спор закрыт: заказ отменён\n${tag}${line}${reason ? `\n📝 ${reason}` : ""}`;
    case "expire":
      return `⌛ Время заказа ${tag} истекло${line}`;
    default:
      return staff ? `ℹ️ Заказ ${tag}: статус ${order.status}${line}` : null;
  }
};

// A published order is work for the drivers who are actually on the line in
// that city. Off-shift drivers must not be woken by somebody else's ride.
const onlineDriversFor = async (order) => {
  const memberships = await Membership.find({
    cityId: order.cityId,
    role: "driver",
    status: "ACTIVE",
  }).select("_id userId");
  if (!memberships.length) return [];

  const profiles = await DriverProfile.find({
    membershipId: { $in: memberships.map((item) => item._id) },
    shift: "online",
  }).select("membershipId");
  const userIdByMembership = new Map(
    memberships.map((item) => [String(item._id), item.userId])
  );

  return profiles
    .map((profile) => userIdByMembership.get(String(profile.membershipId)))
    .filter(
      (userId) =>
        userId &&
        (!order.targetDriverId ||
          String(order.targetDriverId) === String(userId))
    )
    .map((userId) => ({ userId, role: "driver" }));
};

const staffRecipients = async (cityId) => {
  const [dispatchers, city] = await Promise.all([
    Membership.find({ cityId, role: "dispatcher", status: "ACTIVE" }).select("userId"),
    City.findById(cityId).select("regionId tz"),
  ]);
  const list = dispatchers.map((item) => ({ userId: item.userId, role: "dispatcher" }));
  const tz = city?.tz;
  if (!city?.regionId) return { recipients: list, tz };

  // Region admins are attached to one city of their region; match the region
  const admins = await Membership.find({ role: "region_admin", status: "ACTIVE" }).select(
    "userId cityId"
  );
  if (!admins.length) return { recipients: list, tz };
  const cities = await City.find({ _id: { $in: admins.map((item) => item.cityId) } }).select(
    "regionId"
  );
  const regionByCity = new Map(cities.map((item) => [String(item._id), String(item.regionId)]));
  for (const admin of admins) {
    if (regionByCity.get(String(admin.cityId)) === String(city.regionId)) {
      list.push({ userId: admin.userId, role: "dispatcher" });
    }
  }
  return { recipients: list, tz };
};

const deliver = async ({ recipient, order, event, body, actions }) => {
  const session = await ensureSession({
    userId: recipient.userId,
    cityId: order.cityId,
    role: recipient.role,
  });
  const meta = {
    kind: "order_event",
    orderId: String(order._id),
    event,
    status: order.status,
    ...(actions?.length && { actions }),
  };
  const message = await Message.create({
    chatId: session.chatId,
    senderType: "bot",
    kind: "text",
    body,
    meta,
  });
  // The thread now knows which order the user is dealing with, so a later
  // "статус" or "отмени" resolves to this order even outside the card
  await AiSession.updateOne({ _id: session._id }, { $set: { lastOrderId: order._id } });

  emitToUser(recipient.userId, "ai:message", {
    chatId: String(session.chatId),
    message: serializeMessage(message, recipient.userId),
  });
};

// The transition makes older messages of this order irrelevant everywhere:
// a finish keeps only the finish message, an assignment drops offers and
// earlier steps. This runs right away, including the actor's own thread
// where the feed was skipped because the AI reply already covers it.
const pruneOrderMessages = async (order) => {
  const removed = await pruneOrderEvents({
    orderId: order._id,
    status: order.status,
  });
  const removedChats = Object.keys(removed);
  if (!removedChats.length) return;
  const sessions = await AiSession.find({ chatId: { $in: removedChats } })
    .select("chatId userId")
    .lean();
  for (const session of sessions) {
    const ids = removed[String(session.chatId)];
    if (ids?.length) {
      emitToUser(session.userId, "ai:cleanup", {
        chatId: String(session.chatId),
        ids,
      });
    }
  }
};

// `source: "ai"` marks a change made by the actor through the same AI chat:
// that user already gets a written answer, so the feed skips only their own
// thread (everyone else still needs to know).
const notifyOrderEvent = async (
  order,
  { event, actor, reason, source } = {}
) => {
  try {
    const recipients = [];
    if (event === "publish") {
      // A fresh order is work for the drivers on the line; the passenger
      // already knows because they placed it.
      recipients.push(...(await onlineDriversFor(order)));
    } else {
      if (order.passengerId) recipients.push({ userId: order.passengerId, role: "passenger" });
      if (order.driverId) recipients.push({ userId: order.driverId, role: "driver" });
    }
    const staff = await staffRecipients(order.cityId);
    recipients.push(...staff.recipients);

    const seen = new Set();
    const unique = recipients.filter((item) => {
      if (!item.userId) return false;
      const key = `${item.userId}:${item.role}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const driver = ["assign", "activate"].includes(event)
      ? driverCaption(await loadDriverProfile(order.driverId))
      : "";

    for (const recipient of unique) {
      if (
        source === "ai" &&
        actor?.userId &&
        String(actor.userId) === String(recipient.userId) &&
        actor.role === recipient.role
      ) {
        continue;
      }
      const body = eventText(order, event, {
        role: recipient.role,
        actor,
        reason,
        driver,
        tz: staff.tz,
      });
      if (!body) continue;
      await deliver({
        recipient,
        order,
        event,
        body,
        actions: actionsFor(recipient.role, order, recipient.userId),
      });
    }

    await pruneOrderMessages(order);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[ai] order feed failed:", error.message);
  }
};

const notifyOffer = async (order, offer, driver = {}) => {
  try {
    const route = routeText(order);
    const body = `📨 Новый отклик · ${ref(order)}${route ? `\n📍 ${route}` : ""}\n🚗 ${
      driver.driverName ?? "Водитель"
    } · 💰 ${offer.priceText} · ⏱ подача ~${offer.etaMin} мин`;
    await deliver({
      recipient: { userId: order.passengerId, role: "passenger" },
      order,
      event: "offer",
      body,
      actions: [
        apiAction("accept", "Принять отклик", `/api/orders/${order._id}/accept`, {
          offerId: String(offer._id),
        }),
      ],
    });
    // The driver's own thread swaps "Новый заказ" for a confirmation, so the
    // "Откликнуться" button cannot come back after a reload and fail with 409.
    if (offer.driverId) {
      await deliver({
        recipient: { userId: offer.driverId, role: "driver" },
        order,
        event: "offer_sent",
        body: `📨 Отклик отправлен · ${ref(order)}${
          route ? `\n📍 ${route}` : ""
        }\n💰 ${offer.priceText} · ⏱ подача ~${offer.etaMin} мин · ждём ответа пассажира`,
        actions: [],
      });
    }
    await pruneOrderMessages(order);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[ai] offer feed failed:", error.message);
  }
};

module.exports = { notifyOrderEvent, notifyOffer, actionsFor };
