// Calendar day of a city in its own timezone (a shift follows the city,
// not the server or the phone). `at` defaults to now.
const dayRange = (tz, at = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz || "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value ?? 0);

  // Date.UTC gives the wall-clock time of the city as if it were UTC; the
  // difference from `at` is the zone offset, so subtracting it returns the
  // real instant of local midnight
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  const offset = wall - Math.floor(at.getTime() / 1000) * 1000;
  const startMs = Date.UTC(get("year"), get("month") - 1, get("day")) - offset;
  return { start: new Date(startMs), end: new Date(startMs + 24 * 60 * 60 * 1000) };
};

module.exports = { dayRange };
