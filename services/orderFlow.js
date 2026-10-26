const Order = require("../models/Order");
const Chat = require("../models/Chat");
const City = require("../models/City");
const Membership = require("../models/Membership");
const DriverProfile = require("../models/DriverProfile");
const ApiError = require("../utilities/errors");
const { transition } = require("./orderService");
const botDispatcher = require("./botDispatcher");
const pushService = require("../utilities/pushService");

// Single implementation of "passenger places an order": the REST controller
// and the AI dispatcher both go through it, so validation, expiry timers,
// chat creation and fan-out stay identical.
// Returns { order, events } — socket events are emitted by the caller.
const createOrderForPassenger = async ({ user, memberships = [], data }) => {
  const city = await City.findById(data.cityId);
  if (!city) throw new ApiError(404, "Город не найден");
  if (!["PILOT", "ACTIVE"].includes(city.status))
    throw new ApiError(403, "В вашем городе заказы ещё не открыты");

  const passengerMembership = memberships.find(
    (item) =>
      item.role === "passenger" &&
      item.status === "ACTIVE" &&
      String(item.cityId?._id ?? item.cityId) === String(data.cityId)
  );
  if (!passengerMembership)
    throw new ApiError(403, "Вы не пассажир этого города");

  // A ride in the past can never be served; both the REST form and the AI
  // tool fail here, so a wrong timezone can never silently book "yesterday".
  if (data.whenType === "scheduled") {
    const at = data.whenAt ? new Date(data.whenAt) : null;
    if (!at || Number.isNaN(at.getTime()))
      throw new ApiError(400, "Укажите время поездки");
    if (at.getTime() <= Date.now() + 60_000)
      throw new ApiError(400, "Время поездки уже прошло — выберите будущее время");
  }

  const matchMode = data.matchMode ?? city.settings?.matchMode ?? "offers";

  // Direct order placed after a call to a free driver (concept 1.6)
  let directContext = null;
  if (data.targetDriverId) {
    if (city.settings?.directCallsEnabled === false)
      throw new ApiError(403, "Прямые вызовы водителей отключены в этом городе");

    const targetMembership = await Membership.findOne({
      userId: data.targetDriverId,
      cityId: data.cityId,
      role: "driver",
      status: "ACTIVE",
    });
    if (!targetMembership)
      throw new ApiError(400, "Целевой водитель не найден в этом городе");

    const targetProfile = await DriverProfile.findOne({
      membershipId: targetMembership._id,
    });
    if (data.whenType === "now" && (!targetProfile || targetProfile.shift !== "online"))
      throw new ApiError(409, "Водитель сейчас не на линии");
    if (data.whenType === "now") {
      const busy = await Order.exists({
        driverId: data.targetDriverId,
        status: { $in: ["ASSIGNED", "ARRIVING", "WAITING", "IN_RIDE"] },
      });
      if (busy) throw new ApiError(409, "У водителя уже есть активный заказ");
    }

    directContext = { targetMembership, targetProfile };
  }

  let order = await Order.create({
    passengerId: user._id,
    cityId: data.cityId,
    // Маршрут одной строкой; зоны не используются
    from: { text: data.route },
    when: { type: data.whenType, ...(data.whenAt && { at: new Date(data.whenAt) }) },
    pax: data.pax,
    ...(data.notes && { notes: data.notes }),
    matchMode: data.targetDriverId ? "offers" : matchMode,
    ...(data.targetDriverId && {
      mode: "direct",
      targetDriverId: data.targetDriverId,
    }),
  });

  // Direct orders reuse the existing direct chat as the order chat; the
  // previous conversation and call log stay in place (concept 1.6)
  let chat;
  if (directContext && data.chatId) {
    chat = await Chat.findById(data.chatId);
    if (
      !chat ||
      !chat.members.some((member) => String(member) === String(user._id)) ||
      !chat.members.some((member) => String(member) === String(data.targetDriverId))
    ) {
      throw new ApiError(400, "Чат не найден между пассажиром и водителем");
    }
    // Only one active order per dialog
    if (chat.orderId) {
      const previous = await Order.findById(chat.orderId).select("status");
      const TERMINAL = ["COMPLETED", "CANCELLED", "NO_SHOW", "EXPIRED"];
      if (previous && !TERMINAL.includes(previous.status)) {
        throw new ApiError(409, "В этом диалоге уже есть активный заказ");
      }
    }
    chat.type = "order";
    chat.orderId = order._id;
    await chat.save();
  } else {
    chat = await Chat.create({
      type: "order",
      cityId: data.cityId,
      orderId: order._id,
      // Direct orders include the target driver from the start
      members: [user._id, ...(directContext ? [data.targetDriverId] : [])],
    });
  }
  order.chatId = chat._id;

  const actor = { userId: user._id, role: "passenger" };
  let events = [];
  ({ order, events } = await transition(order, "publish", actor));

  const timeoutSeconds =
    directContext
      ? (city.settings?.directOrderTimeoutMin ?? 10) * 60
      : (city.settings?.cascadeTimeouts?.expire ?? 600);
  // Для заказов «на время» срок публикации не ограничен коротким окном
  order.expiresAt =
    data.whenType === "scheduled"
      ? new Date(new Date(order.when.at).getTime() + 60 * 60 * 1000)
      : new Date(Date.now() + timeoutSeconds * 1000);
  await order.save();
  await botDispatcher.upsertOrderCard(order);

  // Cascade fan-out, expiry and preorder timers (concept 1.6 / 1.14)
  const { scheduleOrderJobs } = require("../jobs/index");
  await scheduleOrderJobs(order);

  // Direct orders go to the target driver only; broadcast orders fan out
  // to the city (zones are no longer used). Scheduled orders are activated
  // by the preorder job before the ride instead.
  if (order.mode !== "direct" && data.whenType !== "scheduled") {
    events.push({
      room: `city:${data.cityId}`,
      event: "order:new",
      payload: { orderId: order._id },
    });
    void pushService.notifyNewOrder(order, { excludeUserId: user._id }).catch(() => undefined);
  }

  return { order, events, city };
};

module.exports = { createOrderForPassenger };
