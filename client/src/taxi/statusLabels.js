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

// Время заказа живёт в зоне ГОРОДА, а не устройства: диспетчер в Москве и
// пассажир в Иркутске должны видеть одни и те же 07:00. `city` — строка IANA
// или объект города из /api/geo/cities (у него есть tz).
const DEFAULT_TZ = "Europe/Moscow";
const pad = (value) => String(value).padStart(2, "0");

export const cityTimeZone = (city) =>
  (typeof city === "string" ? city : city?.tz) ||
  Intl.DateTimeFormat().resolvedOptions().timeZone ||
  DEFAULT_TZ;

const partsIn = (date, tz) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: cityTimeZone(tz),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const map = {};
  for (const part of parts) if (part.type !== "literal") map[part.type] = part.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
  };
};

const wallMillis = (parts) =>
  Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);

const splitWall = (value) => {
  const match = String(value ?? "").match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/
  );
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number);
  return { year, month, day, hour, minute };
};

// Настенное время города -> UTC-инстант (для отправки на сервер)
export const zonedWallToUtc = (value, tz = DEFAULT_TZ) => {
  const parts = splitWall(value);
  if (!parts) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const guess = wallMillis(parts);
  const firstOffset = wallMillis(partsIn(new Date(guess), tz)) - guess;
  const utc = guess - firstOffset;
  // Второй проход — на случай перехода на летнее время в других странах
  const secondOffset = wallMillis(partsIn(new Date(utc), tz)) - utc;
  return new Date(guess - secondOffset);
};

// Человекочитаемое время заказа: «Сейчас», «К 14:30», «Завтра 09:15»
export const formatWhen = (when, city) => {
  if (!when?.at || when.type === "now") return "Сейчас";
  const date = new Date(when.at);
  if (Number.isNaN(date.getTime())) return "Сейчас";
  const tz = cityTimeZone(city);
  const target = partsIn(date, tz);
  const now = partsIn(new Date(), tz);
  const time = `${pad(target.hour)}:${pad(target.minute)}`;
  const dayDiff = Math.round(
    (Date.UTC(target.year, target.month - 1, target.day) -
      Date.UTC(now.year, now.month - 1, now.day)) /
      86_400_000
  );
  if (dayDiff === 0) return `К ${time}`;
  if (dayDiff === 1) return `Завтра ${time}`;
  const day = new Date(Date.UTC(target.year, target.month - 1, target.day))
    .toLocaleDateString("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" });
  return `${day} ${time}`;
};

// Подпись выбранной брони в композере: время + дата по часам города
export const formatWallWhen = (value, city) => {
  const parts = splitWall(value);
  if (!parts) return "";
  const day = new Date(Date.UTC(parts.year, parts.month - 1, parts.day))
    .toLocaleDateString("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" });
  return `${pad(parts.hour)}:${pad(parts.minute)} · ${day}`;
};

// Значение по умолчанию для выбора: через час по часам города, кратно 15 мин
export const defaultScheduledAt = (city) => {
  const tz = cityTimeZone(city);
  const parts = partsIn(new Date(Date.now() + 60 * 60 * 1000), tz);
  let minutes = Math.ceil((parts.hour * 60 + parts.minute) / 15) * 15;
  const dayShift = Math.floor(minutes / 1440);
  minutes %= 1440;
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + dayShift));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(
    date.getUTCDate()
  )}T${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
};
