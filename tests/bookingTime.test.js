// Bookings are wall-clock events of the city, not of the server: "завтра
// 07:00" in Irkutsk is 23:00Z of the previous day, not 04:00Z (Moscow) and
// certainly not 07:00Z (which reads 15:00 in Irkutsk).
process.env.AI_ENABLED = "0";

const app = require("../app");
const agent = require("../services/ai/agent");
const Membership = require("../models/Membership");
const Order = require("../models/Order");
const {
  parseCityDateTime,
  formatWhen,
  cityParts,
} = require("../services/time");
const { tzForRegion } = require("../services/timezones");
const { cleanBookingRoute } = require("../services/ai/router");
const { connectTestDb, disconnectTestDb } = require("./db");
const { setupPilotCity } = require("./orderSetup");

const TZ = "Asia/Irkutsk";
const pad = (value) => String(value).padStart(2, "0");

const tomorrowWall = (hour, minute = 0) => {
  const base = cityParts(new Date(), TZ);
  const day = new Date(Date.UTC(base.year, base.month - 1, base.day + 1));
  return `${day.getUTCFullYear()}-${pad(day.getUTCMonth() + 1)}-${pad(
    day.getUTCDate()
  )}T${pad(hour)}:${pad(minute)}`;
};

beforeAll(async () => {
  await connectTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe("city time zones", () => {
  it("maps Russian regions to their own IANA zones", () => {
    expect(tzForRegion("Иркутская область")).toBe("Asia/Irkutsk");
    expect(tzForRegion("Иркутская")).toBe("Asia/Irkutsk");
    expect(tzForRegion("Республика Бурятия")).toBe("Asia/Irkutsk");
    expect(tzForRegion("Камчатский край")).toBe("Asia/Kamchatka");
    expect(tzForRegion("Калининградская область")).toBe("Europe/Kaliningrad");
    expect(tzForRegion("Омская область")).toBe("Asia/Omsk");
    expect(tzForRegion("Неизвестная область")).toBeNull();
  });

  it("reads a bare model timestamp on the city clock", () => {
    expect(parseCityDateTime("2026-10-26T07:00", TZ).toISOString()).toBe(
      "2026-10-25T23:00:00.000Z"
    );
    expect(parseCityDateTime("2026-10-26 07:00", TZ).toISOString()).toBe(
      "2026-10-25T23:00:00.000Z"
    );
    expect(parseCityDateTime("2026-10-26T07:00", "Europe/Moscow").toISOString()).toBe(
      "2026-10-26T04:00:00.000Z"
    );
    // An explicit offset is authoritative
    expect(parseCityDateTime("2026-10-26T07:00:00+08:00", TZ).toISOString()).toBe(
      "2026-10-25T23:00:00.000Z"
    );
  });

  it("renders the same instant on the city clock", () => {
    const at = "2026-10-25T23:00:00.000Z";
    const now = new Date("2026-10-25T06:00:00Z");
    expect(formatWhen({ type: "scheduled", at }, TZ, now)).toBe("завтра в 07:00");
    expect(formatWhen({ type: "scheduled", at }, "Europe/Moscow", now)).toBe(
      "завтра в 02:00"
    );
  });

  it("strips a booking phrase that leaked into the route", () => {
    expect(
      cleanBookingRoute("от Бронь на завтра 07:00 Пушкина 8 до Ленина 7")
    ).toBe("от Пушкина 8 до Ленина 7");
    // A street number is not a clock
    expect(cleanBookingRoute("от 5-я Советская 10 до Ленина 7")).toBe(
      "от 5-я Советская 10 до Ленина 7"
    );
  });
});

describe("AI booking through the city clock", () => {
  let world;

  beforeEach(async () => {
    world = await setupPilotCity(app);
  });

  it("stores a bare whenAt as Irkutsk wall time and keeps the route clean", async () => {
    const memberships = await Membership.find({ userId: world.passenger.user._id });
    const ctx = {
      user: { _id: world.passenger.user._id },
      userId: world.passenger.user._id,
      city: world.city,
      cityId: world.city._id,
      role: "passenger",
      memberships,
      session: { lastOrderId: null },
    };

    const wall = tomorrowWall(7);
    const result = await agent.executeTool(ctx, "create_order", {
      route: "от Бронь на завтра 07:00 Пушкина 8 до Ленина 7",
      whenAt: wall,
    });

    const order = await Order.findById(result.orderId);
    expect(order.when.type).toBe("scheduled");
    expect(order.when.at.toISOString()).toBe(
      parseCityDateTime(wall, TZ).toISOString()
    );
    expect(cityParts(order.when.at, TZ).hour).toBe(7);
    expect(order.from.text).toBe("от Пушкина 8 до Ленина 7");
    expect(result.text).toMatch(/07:00/);
  });

  it("rejects a booking time in the past", async () => {
    const memberships = await Membership.find({ userId: world.passenger.user._id });
    const ctx = {
      user: { _id: world.passenger.user._id },
      userId: world.passenger.user._id,
      city: world.city,
      cityId: world.city._id,
      role: "passenger",
      memberships,
      session: { lastOrderId: null },
    };

    await expect(
      agent.executeTool(ctx, "create_order", {
        route: "от вокзала до центра",
        whenAt: "2020-01-01T07:00:00+08:00",
      })
    ).rejects.toThrow(/уже прошло/i);
  });
});
