// The AI dispatcher thread must mirror what happens to an order anywhere in
// the app: order card buttons, driver lifecycle, dispatcher actions. The feed
// message carries meta.actions so the chat can run the next step itself.
process.env.AI_ENABLED = "0";

const request = require("supertest");
const app = require("../app");
const { connectTestDb, disconnectTestDb } = require("./db");
const { setupPilotCity, createOrder } = require("./orderSetup");

beforeAll(async () => {
  await connectTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe("AI order feed", () => {
  let world;

  beforeEach(async () => {
    world = await setupPilotCity(app);
  });

  const chat = async (cookie, role) => {
    const res = await request(app)
      .get(`/api/ai/chat?cityId=${world.city._id}&role=${role}`)
      .set("Cookie", cookie);
    expect(res.status).toBe(200);
    return res.body.data.messages;
  };

  const feedFor = (messages, orderId, event) =>
    messages.filter(
      (item) =>
        item.meta?.kind === "order_event" &&
        String(item.meta.orderId) === String(orderId) &&
        (!event || item.meta.event === event)
    );

  it("tells the dispatcher about a new order with a cancel button", async () => {
    const created = await createOrder(app, world.passenger, world.city);
    expect(created.status).toBe(201);
    const orderId = created.body.data.order._id;

    const messages = await chat(world.dispatcher.cookie, "dispatcher");
    const news = feedFor(messages, orderId, "publish");
    expect(news).toHaveLength(1);
    expect(news[0].body).toContain("#" + String(orderId).slice(-6));
    expect(news[0].body).toContain("ищет водителя");
    const cancel = news[0].meta.actions.find((item) => item.key === "cancel");
    expect(cancel.path).toBe(`/api/orders/${orderId}/cancel`);
  });

  it("attaches an offer button to a new order for the driver on the line", async () => {
    const Membership = require("../models/Membership");
    const DriverProfile = require("../models/DriverProfile");
    const membership = await Membership.findOne({
      userId: world.drivers[0].user._id,
      role: "driver",
    });
    await DriverProfile.updateOne({ membershipId: membership._id }, { $set: { shift: "online" } });

    const created = await createOrder(app, world.passenger, world.city);
    const orderId = created.body.data.order._id;

    const messages = await chat(world.drivers[0].cookie, "driver");
    const news = feedFor(messages, orderId, "publish");
    expect(news).toHaveLength(1);
    expect(news[0].body).toContain("ищет водителя");
    // The chat button replaces the old "откликнитесь за 300" text hint
    expect(news[0].body).not.toContain("Откликнитесь");
    expect(news[0].meta.actions).toEqual([
      expect.objectContaining({ key: "offer", label: "Откликнуться", type: "offer" }),
    ]);

    // Once the driver answers, the button must not come back after a reload:
    // the thread keeps a confirmation instead of the now useless publish bubble
    const offerRes = await request(app)
      .post(`/api/orders/${orderId}/offers`)
      .set("Cookie", world.drivers[0].cookie)
      .send({ priceText: "300 ₽", etaMin: 5 });
    expect(offerRes.status).toBe(201);

    const after = await chat(world.drivers[0].cookie, "driver");
    expect(feedFor(after, orderId, "publish")).toHaveLength(0);
    const sent = feedFor(after, orderId, "offer_sent");
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toContain("Отклик отправлен");
    expect(sent[0].body).toContain("300 ₽");
    expect(sent[0].meta.actions ?? []).toHaveLength(0);
  });

  it("gives a scheduled order a one-tap booking button", async () => {
    const Membership = require("../models/Membership");
    const DriverProfile = require("../models/DriverProfile");
    const membership = await Membership.findOne({
      userId: world.drivers[0].user._id,
      role: "driver",
    });
    await DriverProfile.updateOne({ membershipId: membership._id }, { $set: { shift: "online" } });

    const created = await createOrder(app, world.passenger, world.city, {
      whenType: "scheduled",
      whenAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    });
    const orderId = created.body.data.order._id;

    const messages = await chat(world.drivers[0].cookie, "driver");
    const news = feedFor(messages, orderId, "publish");
    expect(news).toHaveLength(1);
    const book = news[0].meta.actions.find((item) => item.key === "book");
    expect(book).toMatchObject({ label: "Забронировать", path: `/api/orders/${orderId}/book` });

    // The path stored in the button is the real endpoint
    const booked = await request(app)
      .post(book.path)
      .set("Cookie", world.drivers[0].cookie)
      .send({});
    expect(booked.status).toBe(200);
    expect(booked.body.data.order.status).toBe("BOOKED");

    // The booked message replaces the publish bubble and offers the next step
    const after = await chat(world.drivers[0].cookie, "driver");
    expect(feedFor(after, orderId, "publish")).toHaveLength(0);
    const bookedMsg = feedFor(after, orderId, "book");
    expect(bookedMsg).toHaveLength(1);
    expect(bookedMsg[0].meta.actions.map((item) => item.key)).toEqual(
      expect.arrayContaining(["activate"])
    );
  });

  it("stays silent for a driver who is off the line", async () => {
    const created = await createOrder(app, world.passenger, world.city);
    const orderId = created.body.data.order._id;

    const messages = await chat(world.drivers[1].cookie, "driver");
    expect(feedFor(messages, orderId, "publish")).toHaveLength(0);
  });

  it("drops the announcement once the ride goes to another driver", async () => {
    const Membership = require("../models/Membership");
    const DriverProfile = require("../models/DriverProfile");
    for (const driver of world.drivers) {
      const membership = await Membership.findOne({ userId: driver.user._id, role: "driver" });
      await DriverProfile.updateOne({ membershipId: membership._id }, { $set: { shift: "online" } });
    }

    const created = await createOrder(app, world.passenger, world.city);
    const orderId = created.body.data.order._id;
    const offerRes = await request(app)
      .post(`/api/orders/${orderId}/offers`)
      .set("Cookie", world.drivers[0].cookie)
      .send({ priceText: "300 ₽", etaMin: 5 });
    const accepted = await request(app)
      .post(`/api/orders/${orderId}/accept`)
      .set("Cookie", world.passenger.cookie)
      .send({ offerId: String(offerRes.body.data.offer._id) });
    expect(accepted.status).toBe(200);

    // The winner keeps the assignment, the bystander loses the stale notice
    const winnerMessages = await chat(world.drivers[0].cookie, "driver");
    expect(feedFor(winnerMessages, orderId, "assign")).toHaveLength(1);
    expect(feedFor(winnerMessages, orderId, "publish")).toHaveLength(0);

    const bystanderMessages = await chat(world.drivers[1].cookie, "driver");
    expect(feedFor(bystanderMessages, orderId)).toHaveLength(0);
  });

  it("mirrors a dispatcher cancel into the passenger and driver threads", async () => {
    const created = await createOrder(app, world.passenger, world.city);
    const orderId = created.body.data.order._id;

    const cancelled = await request(app)
      .post(`/api/orders/${orderId}/cancel`)
      .set("Cookie", world.dispatcher.cookie)
      .send({ reason: "Нет свободных машин" });
    expect(cancelled.status).toBe(200);

    const passengerMessages = await chat(world.passenger.cookie, "passenger");
    const events = feedFor(passengerMessages, orderId, "cancel");
    expect(events).toHaveLength(1);
    expect(events[0].body).toContain("отменён");
    expect(events[0].body).toContain("Нет свободных машин");
    expect(events[0].meta.actions ?? []).toHaveLength(0);

    const driverMessages = await chat(world.drivers[0].cookie, "driver");
    expect(feedFor(driverMessages, orderId, "cancel")).toHaveLength(0);
  });

  it("shows offers and the assigned driver in the passenger thread", async () => {
    const created = await createOrder(app, world.passenger, world.city);
    const orderId = created.body.data.order._id;

    const offerRes = await request(app)
      .post(`/api/orders/${orderId}/offers`)
      .set("Cookie", world.drivers[0].cookie)
      .send({ priceText: "350 ₽", etaMin: 7 });
    expect(offerRes.status).toBe(201);

    let messages = await chat(world.passenger.cookie, "passenger");
    const offers = feedFor(messages, orderId, "offer");
    expect(offers).toHaveLength(1);
    expect(offers[0].body).toContain("350 ₽");
    expect(offers[0].meta.actions[0].key).toBe("accept");

    const accepted = await request(app)
      .post(`/api/orders/${orderId}/accept`)
      .set("Cookie", world.passenger.cookie)
      .send({ offerId: String(offerRes.body.data.offer._id) });
    expect(accepted.status).toBe(200);

    messages = await chat(world.passenger.cookie, "passenger");
    const assigned = feedFor(messages, orderId, "assign");
    expect(assigned).toHaveLength(1);
    expect(assigned[0].body).toContain("Водитель назначен");
    expect(assigned[0].meta.actions.map((item) => item.key)).toContain("cancel");

    // The driver's own thread shows the same assignment with his next step
    const driverMessages = await chat(world.drivers[0].cookie, "driver");
    const driverAssigned = feedFor(driverMessages, orderId, "assign");
    expect(driverAssigned).toHaveLength(1);
    const arrive = driverAssigned[0].meta.actions.find((item) => item.key === "arrive");
    expect(arrive.body).toEqual({ action: "arrive" });
  });

  it("mirrors the driver lifecycle into the passenger and staff threads", async () => {
    const created = await createOrder(app, world.passenger, world.city);
    const orderId = created.body.data.order._id;
    const offerRes = await request(app)
      .post(`/api/orders/${orderId}/offers`)
      .set("Cookie", world.drivers[0].cookie)
      .send({ priceText: "300 ₽", etaMin: 5 });
    const accepted = await request(app)
      .post(`/api/orders/${orderId}/accept`)
      .set("Cookie", world.passenger.cookie)
      .send({ offerId: String(offerRes.body.data.offer._id) });
    expect(accepted.status).toBe(200);

    const arrived = await request(app)
      .post(`/api/orders/${orderId}/action`)
      .set("Cookie", world.drivers[0].cookie)
      .send({ action: "arrive" });
    expect(arrived.status).toBe(200);

    const passengerMessages = await chat(world.passenger.cookie, "passenger");
    const arriving = feedFor(passengerMessages, orderId, "arrive");
    expect(arriving).toHaveLength(1);
    expect(arriving[0].body).toContain("Водитель выехал к вам");
    expect(arriving[0].meta.actions.map((item) => item.key)).toContain("cancel");

    const dispatcherMessages = await chat(world.dispatcher.cookie, "dispatcher");
    const staff = feedFor(dispatcherMessages, orderId, "arrive");
    expect(staff).toHaveLength(1);
    expect(staff[0].body).toContain("Водитель выехал");
  });
});
