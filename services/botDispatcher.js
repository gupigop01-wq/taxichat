const Message = require("../models/Message");

// Bot-dispatcher behavior (concept 1.7): system texts on every transition,
// quick action buttons per status and the pinned order card.

const CAR_CAPTION = (profile) =>
  profile
    ? [profile.car?.color, profile.car?.plate, profile.car?.brand]
        .filter(Boolean)
        .join(" ")
    : undefined;

// Quick buttons shown in the order chat, filtered by the viewer's role.
// The rule of thumb: a button exists only when the viewer can legally press it
// in that status (see TRANSITIONS in orderService), and the text says what
// actually happens next.
//  - "text" buttons send meta.text as a regular chat message, so the other
//    party sees it in the chat and gets a push.
// There are no canned "running late" buttons: a participant who is late just
// writes it in the chat, so the message stays specific instead of a template.
const ACTIONS_BY_STATUS = {
  PUBLISHED: [
    { action: "offer", label: "Прислать отклик", roles: ["driver"] },
    { action: "book", label: "🔖 Забронировать на время", roles: ["driver"] },
    { action: "cancel", label: "Отменить заказ", roles: ["passenger"] },
    { action: "dispute", label: "Открыть спор", roles: ["passenger"] },
  ],
  BOOKED: [
    { action: "activate", label: "🚕 Приступить к брони", roles: ["driver"] },
    { action: "dispute", label: "Открыть спор", roles: ["passenger"] },
  ],
  ASSIGNED: [
    { action: "arrive", label: "Выехал к вам", roles: ["driver"] },
    { action: "cancel", label: "Отменить поездку", roles: ["passenger", "driver"] },
    { action: "dispute", label: "Открыть спор", roles: ["passenger", "driver"] },
  ],
  ARRIVING: [
    { action: "wait", label: "Я на месте", roles: ["driver"] },
    { action: "cancel", label: "Отменить поездку", roles: ["passenger", "driver"] },
    { action: "dispute", label: "Открыть спор", roles: ["passenger", "driver"] },
  ],
  WAITING: [
    { action: "start", label: "Поехали", roles: ["driver"] },
    { action: "no_show", label: "Пассажир не вышел", roles: ["driver"] },
    {
      action: "text",
      label: "Жду у подъезда",
      roles: ["passenger"],
      text: "Жду у подъезда",
    },
    { action: "dispute", label: "Открыть спор", roles: ["passenger", "driver"] },
  ],
  IN_RIDE: [
    { action: "finish", label: "Завершить поездку", roles: ["driver"] },
    { action: "undo_start", label: "Поездка ещё не началась", roles: ["driver"] },
    { action: "dispute", label: "Открыть спор", roles: ["passenger", "driver"] },
  ],
  // Only a dispatcher resolves a dispute: the participants already told their
  // side through the chat and the SOS signal
  DISPUTE: [
    { action: "resolve_complete", label: "Поездка состоялась", roles: ["dispatcher"] },
    { action: "resolve_cancel", label: "Отменить заказ", roles: ["dispatcher"] },
  ],
};

const actionsForStatus = (status) => ACTIONS_BY_STATUS[status] ?? [];

// Creates or updates the pinned order summary card (concept 1.7)
const upsertOrderCard = async (order) => {
  const meta = {
    orderId: order._id,
    status: order.status,
    from: order.from?.text,
    to: order.to?.text,
    when: order.when,
    pax: order.pax,
    priceAgreed: order.priceAgreed,
    driverId: order.driverId,
    expiresAt: order.expiresAt,
  };

  const existing = await Message.findOne({
    chatId: order.chatId,
    kind: "order_card",
  }).sort({ createdAt: 1 });

  if (existing) {
    existing.meta = meta;
    await existing.save();
    return existing;
  }

  return Message.create({
    chatId: order.chatId,
    senderType: "bot",
    kind: "order_card",
    body: "Заказ",
    meta,
  });
};

const TERMINAL_STATUSES = ["COMPLETED", "CANCELLED", "NO_SHOW", "EXPIRED"];

// Posts the quick action buttons for the current status. The previous button
// message is removed, so an old "Отменить заказ" never survives a transition,
// and a finished order gets no actions at all.
const postActionButtons = async (chatId, status) => {
  await Message.deleteMany({ chatId, kind: "action" });
  if (TERMINAL_STATUSES.includes(status)) return null;

  const buttons = actionsForStatus(status);
  if (buttons.length === 0) return null;

  return Message.create({
    chatId,
    senderType: "bot",
    kind: "action",
    body: "Доступные действия",
    meta: { buttons },
  });
};

// Posts a system message as the bot
const postSystemMessage = async (chatId, body) =>
  Message.create({
    chatId,
    senderType: "bot",
    kind: "system",
    body,
  });

module.exports = {
  CAR_CAPTION,
  actionsForStatus,
  upsertOrderCard,
  postActionButtons,
  postSystemMessage,
};
