// Wall-clock time of a city. Bookings are stored as UTC instants and every
// human-facing time is rendered in the city's own IANA zone: Russia spans
// eleven zones, so the server zone or a hardcoded zone is never correct.

const DEFAULT_TZ = "Europe/Moscow";

const pad = (value) => String(value).padStart(2, "0");

const isValidTimeZone = (tz) => {
  if (typeof tz !== "string" || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
};

const safeTz = (tz) => (isValidTimeZone(tz) ? tz : DEFAULT_TZ);

// Calendar fields of an instant as seen on the city clock
const cityParts = (date, tz = DEFAULT_TZ) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: safeTz(tz),
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

const wallToUtcMillis = ({ year, month, day, hour, minute }) =>
  Date.UTC(year, month - 1, day, hour, minute);

// Wall time in `tz` -> the UTC instant it denotes. Two passes keep the offset
// right at a DST boundary even though Russian zones no longer switch clocks.
const zonedToUtc = (parts, tz = DEFAULT_TZ) => {
  const guess = wallToUtcMillis(parts);
  const firstOffset = wallToUtcMillis(cityParts(new Date(guess), tz)) - guess;
  const utc = guess - firstOffset;
  // Second pass: the offset at the approximate instant may differ (DST edge)
  const secondOffset = wallToUtcMillis(cityParts(new Date(utc), tz)) - utc;
  return new Date(guess - secondOffset);
};

const OFFSET_SUFFIX = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const NAIVE_DATE_TIME =
  /^(\d{4})-(\d{1,2})-(\d{1,2})[T\s](\d{1,2}):(\d{2})(?::\d{2})?(?:\.\d{1,3})?$/;

// Accepts both an ISO instant with an explicit offset and a bare "wall time"
// produced by an LLM ("2026-10-26T07:00"). A bare value is read on the city
// clock, not on the server clock: the model is told the city time and must not
// shift the ride by the server/city offset.
const parseCityDateTime = (value, tz = DEFAULT_TZ) => {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (OFFSET_SUFFIX.test(text)) {
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const match = text.match(NAIVE_DATE_TIME);
  if (!match) {
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const [, year, month, day, hour, minute] = match.map(Number);
  if (hour > 23 || minute > 59 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return zonedToUtc({ year, month, day, hour, minute }, tz);
};

const formatCityTime = (date, tz, options = {}) =>
  new Intl.DateTimeFormat("ru-RU", { timeZone: safeTz(tz), ...options }).format(date);

// Short human wording for `order.when`: "сейчас", "завтра в 07:00",
// "26.10 в 07:00". Always in the city zone.
const formatWhen = (when, tz = DEFAULT_TZ, now = new Date()) => {
  if (!when || when.type === "now" || !when.at) return "сейчас";
  const date = new Date(when.at);
  if (Number.isNaN(date.getTime())) return "сейчас";
  const target = cityParts(date, tz);
  const base = cityParts(now, tz);
  const time = `${pad(target.hour)}:${pad(target.minute)}`;
  const dayDiff = Math.round(
    (Date.UTC(target.year, target.month - 1, target.day) -
      Date.UTC(base.year, base.month - 1, base.day)) /
      86_400_000
  );
  if (dayDiff === 0) return `сегодня в ${time}`;
  if (dayDiff === 1) return `завтра в ${time}`;
  if (dayDiff === 2) return `послезавтра в ${time}`;
  const day = `${pad(target.day)}.${pad(target.month)}`;
  return `${target.year === base.year ? day : `${day}.${target.year}`} в ${time}`;
};

module.exports = {
  DEFAULT_TZ,
  cityParts,
  zonedToUtc,
  parseCityDateTime,
  formatCityTime,
  formatWhen,
  isValidTimeZone,
};
