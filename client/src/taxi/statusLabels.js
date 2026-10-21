// Shared Russian labels for order statuses (concept 1.6)
export const STATUS_LABELS = {
  DRAFT: "Запланирован",
  PUBLISHED: "Ожидает водителя",
  BOOKED: "Забронирован",
  ASSIGNED: "Водитель назначен",
  ARRIVING: "Водитель выехал",
  WAITING: "Водитель на месте",
  IN_RIDE: "Идёт поездка",
  COMPLETED: "Завершён",
  EXPIRED: "Истёк",
  CANCELLED: "Отменён",
  NO_SHOW: "Неявка",
  DISPUTE: "Спор",
};

export const statusLabel = (status) => STATUS_LABELS[status] ?? status;

// Компактные статусы заказа для карточек: эмодзи + короткий текст
export const statusBadge = (status) =>
  ({
    DRAFT: "🕓 Запланирован",
    PUBLISHED: "🔎 Ищем водителя",
    BOOKED: "🔖 Забронирован",
    ASSIGNED: "🚕 Водитель назначен",
    ARRIVING: "🚕 Выехал",
    WAITING: "📍 На месте",
    IN_RIDE: "🛣 В пути",
    COMPLETED: "✅ Завершён",
    EXPIRED: "⌛ Истёк",
    CANCELLED: "✖️ Отменён",
    NO_SHOW: "🚫 Неявка",
    DISPUTE: "⚠️ Спор",
  })[status] ?? status;

// Эмодзи статуса города (вместо длинных подписей)
export const cityStatusEmoji = (status) =>
  ({
    DORMANT: "😴",
    WAITLIST: "🕓",
    PILOT: "✅",
    ACTIVE: "🟢",
    SUSPENDED: "⛔",
  })[status] ?? "❔";

// Короткая подпись статуса города (для деталей)
export const CITY_STATUS_LABELS = {
  DORMANT: "Не запущен",
  WAITLIST: "Список ожидания",
  PILOT: "Активен",
  ACTIVE: "Полностью активен",
  SUSPENDED: "Приостановлен",
};

export const cityStatusLabel = (status) =>
  CITY_STATUS_LABELS[status] ?? status;

// Короткие подписи для узких списков выбора города
export const CITY_STATUS_SHORT = {
  DORMANT: "Не запущен",
  WAITLIST: "Ожидание",
  PILOT: "Пилот",
  ACTIVE: "Активен",
  SUSPENDED: "Пауза",
};

export const cityStatusShort = (status) =>
  CITY_STATUS_SHORT[status] ?? cityStatusLabel(status);

// Человекочитаемое время заказа: «Сейчас», «К 14:30», «Завтра 09:15», «15 окт 18:00»
export const formatWhen = (when) => {
  if (!when?.at || when.type === "now") return "Сейчас";
  const date = new Date(when.at);
  if (Number.isNaN(date.getTime())) return "Сейчас";
  const now = new Date();
  const time = date.toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  });
  if (date.toDateString() === now.toDateString()) return `К ${time}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (date.toDateString() === tomorrow.toDateString()) return `Завтра ${time}`;
  return `${date.toLocaleDateString("ru-RU", { day: "numeric", month: "short" })} ${time}`;
};

// Значение по умолчанию для datetime-local: через час, кратно 15 минутам
export const defaultScheduledAt = () => {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  date.setMinutes(Math.ceil(date.getMinutes() / 15) * 15, 0, 0);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate()
  )}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
