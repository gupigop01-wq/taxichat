const request = require("supertest");
const app = require("../app");
const Chat = require("../models/Chat");
const Message = require("../models/Message");
const Order = require("../models/Order");
const City = require("../models/City");
const User = require("../models/User");
const DriverProfile = require("../models/DriverProfile");
const { connectTestDb, disconnectTestDb } = require("./db");
const { setupPilotCity, createOrder } = require("./orderSetup");
const { registerUser } = require("./helpers");

beforeAll(async () => {
  await connectTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe("Orders and the state machine", () => {
  let world;

  beforeEach(async () => {
    world = await setupPilotCity(app);
  });

  const createBroadcastOrder = async (overrides = {}) =>
    createOrder(app, world.passenger, world.city, overrides);

  it("passenger publishes an order: PUBLISHED, chat created, route visible to him", async () => {
    const res = await createBroadcastOrder();

    expect(res.status).toBe(201);
    const order = res.body.data.order;
    expect(order.status).toBe("PUBLISHED");
    expect(order.from?.text).toBe("От ЖД вокзала до Центра");
    expect(order.chatId).toBeTruthy();
    expect(order.statusLog.map((entry) => entry.status)).toContain("PUBLISHED");

    const chat = await Chat.findById(order.chatId);
    expect(chat.type).toBe("order");
    const systemMessage = await Message.findOne({ chatId: order.chatId, kind: "system" });
    expect(systemMessage.body).toBe("Заказ опубликован");
  });

  it("driver sees the card without exact addresses and without the passenger name", async () => {
    const created = await createBroadcastOrder();
    const orderId = created.body.data.order._id;

    const listRes = await request(app)
      .get(`/api/orders?cityId=${world.city._id}&status=PUBLISHED`)
      .set("Cookie", world.drivers[0].cookie);
    expect(listRes.status).toBe(200);
    const card = listRes.body.data.orders.find((order) => order._id === orderId);
    expect(card).toBeDefined();
    expect(card.exactFrom).toBeUndefined();
    expect(card.exactTo).toBeUndefined();
    expect(card.passengerId).toBeUndefined();

    const getRes = await request(app)
      .get(`/api/orders/${orderId}`)
      .set("Cookie", world.drivers[0].cookie);
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.order.exactFrom).toBeUndefined();
    expect(getRes.body.data.order.passengerId).toBeUndefined();
  });

  it("scheduled broadcast orders are immediately visible to drivers for booking", async () => {
    const created = await createOrder(app, world.passenger, world.city, {
      whenType: "scheduled",
      whenAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
    });
    const scheduledOrder = created.body.data.order;
    expect(scheduledOrder.status).toBe("PUBLISHED");

    // The card IS in the drivers' feeds immediately (booking)
    const feed = await request(app)
      .get(`/api/orders?cityId=${world.city._id}&status=PUBLISHED`)
      .set("Cookie", world.drivers[0].cookie);
    expect(
      feed.body.data.orders.some((order) => order._id === scheduledOrder._id)
    ).toBe(true);

    // Driver books it — status BOOKED, driverId set
    const booked = await request(app)
      .post(`/api/orders/${scheduledOrder._id}/book`)
      .set("Cookie", world.drivers[0].cookie);
    expect(booked.status).toBe(200);
    expect(booked.body.data.order.status).toBe("BOOKED");
    expect(String(booked.body.data.order.driverId)).toBe(
      String(world.drivers[0].user._id)
    );

    // Passenger sees the booking
    const mine = await request(app)
      .get(`/api/orders?cityId=${world.city._id}`)
      .set("Cookie", world.passenger.cookie);
    const own = mine.body.data.orders.find(
      (order) => order._id === scheduledOrder._id
    );
    expect(own.status).toBe("BOOKED");

    // Another driver cannot book an already booked order
    const foreignBook = await request(app)
      .post(`/api/orders/${scheduledOrder._id}/book`)
      .set("Cookie", world.drivers[1].cookie);
    expect(foreignBook.status).toBe(409);

    // The booking driver activates it when the time comes
    const activated = await request(app)
      .post(`/api/orders/${scheduledOrder._id}/activate`)
      .set("Cookie", world.drivers[0].cookie);
    expect(activated.status).toBe(200);
    expect(activated.body.data.order.status).toBe("ASSIGNED");
  });

  it("unread message counts appear in lists and clear after marking read", async () => {
    const created = await createBroadcastOrder({ matchMode: "first_take" });
    const orderId = created.body.data.order._id;
    await request(app)
      .post(`/api/orders/${orderId}/accept`)
      .set("Cookie", world.drivers[0].cookie)
      .send({});

    // Driver sends two messages to the passenger
    for (const body of ["Подъезжаю", "У входа"]) {
      await request(app)
        .post(`/api/orders/${orderId}/messages`)
        .set("Cookie", world.drivers[0].cookie)
        .send({ body });
    }

    const listBefore = await request(app)
      .get(`/api/orders?cityId=${world.city._id}`)
      .set("Cookie", world.passenger.cookie);
    const card = listBefore.body.data.orders.find((order) => order._id === orderId);
    expect(card.unreadCount).toBe(2);

    const single = await request(app)
      .get(`/api/orders/${orderId}`)
      .set("Cookie", world.passenger.cookie);
    expect(single.body.data.order.unreadCount).toBe(2);

    // Passenger opens the chat: messages get marked read
    await request(app)
      .post(`/api/orders/${orderId}/read`)
      .set("Cookie", world.passenger.cookie)
      .send({});

    const listAfter = await request(app)
      .get(`/api/orders?cityId=${world.city._id}`)
      .set("Cookie", world.passenger.cookie);
    const cardAfter = listAfter.body.data.orders.find((order) => order._id === orderId);
    expect(cardAfter.unreadCount).toBe(0);

    // The outsider never gets counts
    const outsider = await registerUser(app);
    const denied = await request(app)
      .post(`/api/orders/${orderId}/read`)
      .set("Cookie", outsider.cookie)
      .send({});
    expect(denied.status).toBe(403);
  });

  it("outsider has no access to the order", async () => {
    const created = await createBroadcastOrder();
    const outsider = await registerUser(app);

    const res = await request(app)
      .get(`/api/orders/${created.body.data.order._id}`)
      .set("Cookie", outsider.cookie);
    expect(res.status).toBe(403);
  });

  it("first-take race gives exactly one winner", async () => {
    const created = await createBroadcastOrder({ matchMode: "first_take" });
    const orderId = created.body.data.order._id;

    const [first, second] = await Promise.all([
      request(app)
        .post(`/api/orders/${orderId}/accept`)
        .set("Cookie", world.drivers[0].cookie)
        .send({}),
      request(app)
        .post(`/api/orders/${orderId}/accept`)
        .set("Cookie", world.drivers[1].cookie)
        .send({}),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);

    const order = await Order.findById(orderId);
    expect(order.status).toBe("ASSIGNED");
    const winners = [first, second].filter((res) => res.status === 200);
    expect(String(order.driverId)).toBe(String(winners[0].body.data.order.driverId));
  });

  it("forbidden transitions are rejected", async () => {
    const created = await createBroadcastOrder({ matchMode: "first_take" });
    const orderId = created.body.data.order._id;

    const accepted = await request(app)
      .post(`/api/orders/${orderId}/accept`)
      .set("Cookie", world.drivers[0].cookie)
      .send({});
    expect(accepted.status).toBe(200);

    // Cannot start the ride before arriving and waiting
    const earlyStart = await request(app)
      .post(`/api/orders/${orderId}/action`)
      .set("Cookie", world.drivers[0].cookie)
      .send({ action: "start" });
    expect(earlyStart.status).toBe(409);

    // Only the assigned driver can act
    const wrongDriver = await request(app)
      .post(`/api/orders/${orderId}/action`)
      .set("Cookie", world.drivers[1].cookie)
      .send({ action: "arrive" });
    expect(wrongDriver.status).toBe(403);
  });

  it("offers flow: driver offers, passenger accepts, driver phone revealed", async () => {
    const created = await createBroadcastOrder();
    const orderId = created.body.data.order._id;

    const offerRes = await request(app)
      .post(`/api/orders/${orderId}/offers`)
      .set("Cookie", world.drivers[0].cookie)
      .send({ priceText: "350 руб", etaMin: 5 });
    expect(offerRes.status).toBe(201);

    const offersList = await request(app)
      .get(`/api/orders/${orderId}/offers`)
      .set("Cookie", world.passenger.cookie);
    expect(offersList.status).toBe(200);
    expect(offersList.body.data.offers).toHaveLength(1);
    expect(offersList.body.data.offers[0].carCaption).toBeTruthy();

    const accepted = await request(app)
      .post(`/api/orders/${orderId}/accept`)
      .set("Cookie", world.passenger.cookie)
      .send({ offerId: offersList.body.data.offers[0]._id });
    expect(accepted.status).toBe(200);
    expect(accepted.body.data.order.status).toBe("ASSIGNED");
    expect(accepted.body.data.order.priceAgreed).toBe("350 руб");
    expect(accepted.body.data.order.driver.phone).toBe("+79000000010");

    // The assigned driver sees the route, passenger identity and name
    const driverView = await request(app)
      .get(`/api/orders/${orderId}`)
      .set("Cookie", world.drivers[0].cookie);
    expect(driverView.body.data.order.from?.text).toBe("От ЖД вокзала до Центра");
    expect(driverView.body.data.order.passengerId).toBeDefined();
    expect(driverView.body.data.order.passenger.name).toBe("Тестовый Пользователь");

    // The other drivers still do not
    const otherDriverView = await request(app)
      .get(`/api/orders/${orderId}`)
      .set("Cookie", world.drivers[1].cookie);
    expect(otherDriverView.body.data.order.exactFrom).toBeUndefined();
  });

  it("skips an offer whose driver account is gone instead of failing", async () => {
    const created = await createBroadcastOrder();
    const orderId = created.body.data.order._id;

    for (const index of [0, 1]) {
      const offerRes = await request(app)
        .post(`/api/orders/${orderId}/offers`)
        .set("Cookie", world.drivers[index].cookie)
        .send({ priceText: `${300 + index * 50} руб`, etaMin: 5 + index });
      expect(offerRes.status).toBe(201);
    }

    await User.findByIdAndDelete(world.drivers[1].user._id);

    const offersList = await request(app)
      .get(`/api/orders/${orderId}/offers`)
      .set("Cookie", world.passenger.cookie);
    expect(offersList.status).toBe(200);
    expect(offersList.body.data.offers).toHaveLength(1);
    expect(offersList.body.data.offers[0].driverName).toBeTruthy();
  });

  it("in offers mode a driver must send an offer instead of taking the order", async () => {
    const created = await createBroadcastOrder();
    const res = await request(app)
      .post(`/api/orders/${created.body.data.order._id}/accept`)
      .set("Cookie", world.drivers[0].cookie)
      .send({});
    expect(res.status).toBe(409);
  });

  it("full lifecycle: assign, arrive, wait, start, undo, start, finish", async () => {
    const created = await createBroadcastOrder({ matchMode: "first_take" });
    const orderId = created.body.data.order._id;
    const driverCookie = world.drivers[0].cookie;

    await request(app).post(`/api/orders/${orderId}/accept`).set("Cookie", driverCookie).send({});

    const act = (action, cookie = driverCookie) =>
      request(app)
        .post(`/api/orders/${orderId}/action`)
        .set("Cookie", cookie)
        .send({ action });

    expect((await act("arrive")).body.data.order.status).toBe("ARRIVING");
    expect((await act("wait")).body.data.order.status).toBe("WAITING");
    expect((await act("start")).body.data.order.status).toBe("IN_RIDE");
    expect((await act("undo_start")).body.data.order.status).toBe("WAITING");
    expect((await act("start")).body.data.order.status).toBe("IN_RIDE");
    const finished = await act("finish");
    expect(finished.body.data.order.status).toBe("COMPLETED");

    const systemBodies = (await Message.find({ chatId: created.body.data.order.chatId }).sort({ createdAt: 1 })).map(
      (message) => message.body
    );
    expect(systemBodies).toContain("Водитель выехал");
    expect(systemBodies).toContain("Водитель на месте");
    expect(systemBodies).toContain("Поездка началась");
    expect(systemBodies).toContain("Водитель отменил начало поездки");
    expect(systemBodies).toContain("Поездка завершена");

    // Driver returns online after finishing
    const profile = await DriverProfile.findOne({ userId: world.drivers[0].user._id });
    expect(profile.shift).toBe("online");
  });

  it("paid waiting starts after the city's free window and freezes on start", async () => {
    await City.findByIdAndUpdate(world.city._id, {
      "settings.waitingMinutes": 2,
      "settings.waitingPricePerMin": 7,
    });

    const created = await createBroadcastOrder({ matchMode: "first_take" });
    const orderId = created.body.data.order._id;
    const driverCookie = world.drivers[0].cookie;
    await request(app).post(`/api/orders/${orderId}/accept`).set("Cookie", driverCookie).send({});

    const act = (action) =>
      request(app)
        .post(`/api/orders/${orderId}/action`)
        .set("Cookie", driverCookie)
        .send({ action });

    await act("arrive");
    const waited = await act("wait");
    expect(waited.status).toBe(200);
    expect(waited.body.data.order.waiting).toMatchObject({
      freeMinutes: 2,
      pricePerMin: 7,
      paidMinutes: 0,
      fee: 0,
      endedAt: null,
    });

    // The free window is over: 30 seconds into the paid one
    const stored = await Order.findById(orderId);
    stored.waiting.startedAt = new Date(Date.now() - 150 * 1000);
    stored.markModified("waiting");
    await stored.save();

    const started = await act("start");
    expect(started.status).toBe(200);
    expect(started.body.data.order.waiting).toMatchObject({ paidMinutes: 1, fee: 7 });
    expect(started.body.data.order.waiting.endedAt).toBeTruthy();

    const bodies = (
      await Message.find({ chatId: created.body.data.order.chatId }).sort({ createdAt: 1 })
    ).map((message) => message.body);
    expect(bodies).toContain("Бесплатное ожидание 2 мин, далее 7 ₽/мин");
    expect(bodies).toContain("Платное ожидание: 1 мин × 7 ₽ = 7 ₽");

    // The passenger sees the same frozen fee
    const passengerView = await request(app)
      .get(`/api/orders/${orderId}`)
      .set("Cookie", world.passenger.cookie);
    expect(passengerView.body.data.order.waiting.fee).toBe(7);

    // A mistaken start is undone: the interval in ride is not charged again
    const undone = await act("undo_start");
    expect(undone.body.data.order.waiting.endedAt).toBeNull();
    const restarted = await act("start");
    expect(restarted.body.data.order.waiting.fee).toBe(7);
  });

  it("paid waiting applies to bookings as well", async () => {
    await City.findByIdAndUpdate(world.city._id, {
      "settings.waitingMinutes": 1,
      "settings.waitingPricePerMin": 3,
    });

    const created = await createOrder(app, world.passenger, world.city, {
      whenType: "scheduled",
      whenAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    });
    const orderId = created.body.data.order._id;
    const driverCookie = world.drivers[0].cookie;

    await request(app).post(`/api/orders/${orderId}/book`).set("Cookie", driverCookie).send({});
    await request(app).post(`/api/orders/${orderId}/activate`).set("Cookie", driverCookie).send({});

    const act = (action) =>
      request(app)
        .post(`/api/orders/${orderId}/action`)
        .set("Cookie", driverCookie)
        .send({ action });
    await act("arrive");
    const pressedAt = Date.now();
    const waited = await act("wait");
    expect(waited.body.data.order.waiting).toMatchObject({
      freeMinutes: 1,
      pricePerMin: 3,
      paidMinutes: 0,
      fee: 0,
    });

    // The driver checked in early: the free window is anchored to the booked
    // time, so the check-in itself neither starts nor charges anything
    const stored = await Order.findById(orderId);
    const bookedAt = new Date(stored.when.at).getTime();
    const anchoredAt = new Date(waited.body.data.order.waiting.startedAt).getTime();
    expect(anchoredAt).toBe(bookedAt);
    expect(anchoredAt).toBeGreaterThan(pressedAt);

    const bodies = (
      await Message.find({ chatId: created.body.data.order.chatId }).sort({ createdAt: 1 })
    ).map((message) => message.body);
    expect(bodies.some((body) => body.includes("начнётся по брони"))).toBe(true);

    // Once the booked time and the free window are over, billing is normal
    stored.waiting.startedAt = new Date(Date.now() - 90 * 1000);
    stored.markModified("waiting");
    await stored.save();

    const started = await act("start");
    expect(started.body.data.order.waiting).toMatchObject({ paidMinutes: 1, fee: 3 });
  });

  it("cancel requires a reason and records it", async () => {
    const created = await createBroadcastOrder();
    const orderId = created.body.data.order._id;

    const noReason = await request(app)
      .post(`/api/orders/${orderId}/cancel`)
      .set("Cookie", world.passenger.cookie)
      .send({});
    expect(noReason.status).toBe(400);

    const cancelled = await request(app)
      .post(`/api/orders/${orderId}/cancel`)
      .set("Cookie", world.passenger.cookie)
      .send({ reason: "Передумал" });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.order.status).toBe("CANCELLED");

    const messages = await Message.find({ chatId: created.body.data.order.chatId });
    expect(messages.some((message) => message.body.includes("Передумал"))).toBe(true);
  });

  it("dispatcher assigns a driver manually and sees exact addresses", async () => {
    const created = await createBroadcastOrder();
    const orderId = created.body.data.order._id;

    const queue = await request(app)
      .get(`/api/orders?cityId=${world.city._id}`)
      .set("Cookie", world.dispatcher.cookie);
    expect(queue.status).toBe(200);
    const card = queue.body.data.orders.find((order) => order._id === orderId);
    expect(card.from?.text).toBe("От ЖД вокзала до Центра");

    const mine = await request(app)
      .get("/api/memberships/mine")
      .set("Cookie", world.drivers[0].cookie);
    const membershipId = mine.body.data.memberships[0]._id;

    const assigned = await request(app)
      .post(`/api/orders/${orderId}/assign`)
      .set("Cookie", world.dispatcher.cookie)
      .send({ membershipId });
    expect(assigned.status).toBe(200);
    expect(assigned.body.data.order.status).toBe("ASSIGNED");
    expect(assigned.body.data.order.driver.phone).toBeTruthy();
  });

  it("a driver of another city cannot see or offer on the order", async () => {
    const created = await createBroadcastOrder();
    const orderId = created.body.data.order._id;

    const outsiderDriver = await registerUser(app);
    const Zone = require("../models/Zone");
    const City = require("../models/City");
    const samara = await City.findOne({ name: "Култук" });
    const samaraZones = await Zone.find({ cityId: samara._id }).sort({ name: 1 });
    await request(app)
      .post("/api/memberships")
      .set("Cookie", outsiderDriver.cookie)
      .send({
        cityId: samara._id,
        role: "driver",
        displayName: "Самарский",
        phone: "+79009999999",
        car: { color: "Красный", plate: "999" },
        zones: [samaraZones[0]._id.toString()],
      });

    const view = await request(app)
      .get(`/api/orders/${orderId}`)
      .set("Cookie", outsiderDriver.cookie);
    expect(view.status).toBe(403);

    const offer = await request(app)
      .post(`/api/orders/${orderId}/offers`)
      .set("Cookie", outsiderDriver.cookie)
      .send({ priceText: "100", etaMin: 10 });
    expect(offer.status).toBe(403);
  });

  it("dispute adds dispatchers to the chat", async () => {
    const created = await createBroadcastOrder({ matchMode: "first_take" });
    const orderId = created.body.data.order._id;
    await request(app)
      .post(`/api/orders/${orderId}/accept`)
      .set("Cookie", world.drivers[0].cookie)
      .send({});

    const res = await request(app)
      .post(`/api/orders/${orderId}/dispute`)
      .set("Cookie", world.passenger.cookie)
      .send({ reason: "Водитель едет не туда" });
    expect(res.status).toBe(200);
    expect(res.body.data.order.status).toBe("DISPUTE");

    const chat = await Chat.findById(created.body.data.order.chatId);
    expect(chat.members.some((member) => String(member) === String(world.dispatcher.user._id))).toBe(true);
  });

  it("order chat supports text messages between participants", async () => {
    const created = await createBroadcastOrder({ matchMode: "first_take" });
    const orderId = created.body.data.order._id;
    await request(app)
      .post(`/api/orders/${orderId}/accept`)
      .set("Cookie", world.drivers[0].cookie)
      .send({});

    const sent = await request(app)
      .post(`/api/orders/${orderId}/messages`)
      .set("Cookie", world.passenger.cookie)
      .send({ body: "Жду у подъезда" });
    expect(sent.status).toBe(201);

    const history = await request(app)
      .get(`/api/orders/${orderId}/messages`)
      .set("Cookie", world.drivers[0].cookie);
    expect(history.status).toBe(200);
    const texts = history.body.data.messages.filter((message) => message.kind === "text");
    expect(texts.some((message) => message.body === "Жду у подъезда")).toBe(true);
  });
});
