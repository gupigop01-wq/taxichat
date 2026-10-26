// Fast lane of the dispatcher: bookings must be parsed in the city's own
// timezone and must never turn into a ride "right now" by mistake.
const { route, parseWhen, hasBookingIntent } = require("../services/ai/router");

const TZ = "Asia/Irkutsk";
const passenger = { role: "passenger", city: { tz: TZ } };

const localParts = (iso, tz = TZ) => {
  const fmt = new Intl.DateTimeFormat("ru-RU", {
    timeZone: tz,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date(iso)).map((part) => [part.type, part.value])
  );
  return `${parts.day}.${parts.month} ${parts.hour}:${parts.minute}`;
};

const tomorrowAt = (hour, minute) => {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const day = new Date(`${today}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  const date = day.toISOString().slice(0, 10).split("-");
  return `${date[2]}.${date[1]} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
};

describe("AI router bookings", () => {
  it("creates an immediate order when no time is mentioned", () => {
    const result = route(passenger, "нужна машина от вокзала до центра");
    expect(result.tool).toBe("create_order");
    expect(result.args.route).toBe("от вокзала до центра");
    expect(result.args.whenAt).toBeUndefined();
  });

  it("books for tomorrow in the city timezone and keeps the route clean", () => {
    const result = route(passenger, "завтра в 8:30 от вокзала до центра");
    expect(result.tool).toBe("create_order");
    expect(result.args.route).toBe("от вокзала до центра");
    expect(localParts(result.args.whenAt)).toBe(tomorrowAt(8, 30));
  });

  it("books at an explicit clock time without a date word", () => {
    // Pin the clock: a fixed wall time from the original test ("15:00") became
    // "past" every afternoon and made the suite fail by time of day
    jest.useFakeTimers({ now: new Date("2026-10-25T05:00:00Z") }); // 13:00 Irkutsk
    try {
      const result = route(passenger, "от вокзала до центра на 15:00");
      expect(result.tool).toBe("create_order");
      expect(result.args.route).toBe("от вокзала до центра");
      expect(localParts(result.args.whenAt).endsWith("15:00")).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it("asks for the time instead of ordering a ride right now", () => {
    const result = route(passenger, "забронируй от вокзала до центра");
    expect(result.tool).toBeUndefined();
    expect(result.reply).toMatch(/время/i);
  });

  it("asks for the route when only the time is given", () => {
    const result = route(passenger, "завтра в 8:30");
    expect(result.tool).toBeUndefined();
    expect(result.reply).toMatch(/куда/i);
  });

  it("treats a duration as an ordinary ride, not a booking", () => {
    expect(hasBookingIntent("нужна машина на 15 минут")).toBe(false);
    const result = route(passenger, "нужна машина от вокзала до центра на 15 минут");
    expect(result.tool).toBe("create_order");
    expect(result.args.whenAt).toBeUndefined();
  });

  it("accepts an address pair without an opening preposition", () => {
    const result = route(passenger, "Ленина 10 до Пушкина 8");
    expect(result.tool).toBe("create_order");
    expect(result.args.route).toBe("от Ленина 10 до Пушкина 8");
  });

  it("does not invent a route from a destination-only phrase", () => {
    const result = route(passenger, "нужна машина до центра");
    expect(result.tool).toBeUndefined();
    expect(result.reply).toMatch(/маршрут|Куда/i);
  });

  it("converts wall time in Irkutsk to UTC", () => {
    const now = new Date("2026-10-25T05:00:00Z"); // 13:00 in Irkutsk
    expect(parseWhen("завтра в 8:30", { now, tz: TZ }).at.toISOString()).toBe(
      "2026-10-26T00:30:00.000Z"
    );
    expect(parseWhen("сегодня к 18:00", { now, tz: TZ }).at.toISOString()).toBe(
      "2026-10-25T10:00:00.000Z"
    );
    expect(parseWhen("через 2 часа", { now, tz: TZ }).at.toISOString()).toBe(
      "2026-10-25T07:00:00.000Z"
    );
  });

  it("rejects a time that already passed and an impossible hour", () => {
    const now = new Date("2026-10-25T12:00:00Z"); // 20:00 in Irkutsk
    expect(parseWhen("сегодня в 18:00", { now, tz: TZ }).error).toBe("past");
    expect(parseWhen("завтра в 25:00", { now, tz: TZ }).error).toBe("notime");
  });
});
