// Russian labels shared by the AI prompts, replies and the client.
const { formatWhen } = require("../time");

const STATUS_LABELS = {
  DRAFT: "черновик",
  PUBLISHED: "ищет водителя",
  BOOKED: "забронирован",
  ASSIGNED: "водитель назначен",
  ARRIVING: "водитель в пути",
  WAITING: "водитель на месте",
  IN_RIDE: "в поездке",
  COMPLETED: "завершён",
  EXPIRED: "истёк",
  CANCELLED: "отменён",
  NO_SHOW: "пассажир не вышел",
  DISPUTE: "спор",
};

const ROLE_LABELS = {
  passenger: "пассажир",
  driver: "водитель",
  dispatcher: "диспетчер",
};

const ACTIVE_STATUSES = [
  "DRAFT",
  "PUBLISHED",
  "BOOKED",
  "ASSIGNED",
  "ARRIVING",
  "WAITING",
  "IN_RIDE",
  "DISPUTE",
];

const TERMINAL_STATUSES = ["COMPLETED", "CANCELLED", "NO_SHOW", "EXPIRED"];

const statusText = (status) => STATUS_LABELS[status] ?? String(status ?? "");

// `tz` is the order city's IANA zone: the same instant reads differently in
// Irkutsk and in Moscow, and the person must see their city's clock.
const whenText = (when, tz) => formatWhen(when, tz);

const routeText = (order) => {
  if (!order) return "";
  const from = order.from?.text ?? "";
  const to = order.to?.text ?? "";
  return to ? `${from} → ${to}` : from;
};

module.exports = {
  STATUS_LABELS,
  ROLE_LABELS,
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  statusText,
  whenText,
  routeText,
};
