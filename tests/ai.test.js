// The AI dispatcher must answer without a model for standard commands and go
// through the same state machine as the REST API. AI is switched off here so
// the tests do not depend on a running llama-server; the deterministic router
// covers every scenario.
process.env.AI_ENABLED = "0";

const request = require("supertest");
const app = require("../app");
const Order = require("../models/Order");
const Offer = require("../models/Offer");
const DriverProfile = require("../models/DriverProfile");
const Message = require("../models/Message");
const { connectTestDb, disconnectTestDb } = require("./db");
const { setupPilotCity, createOrder } = require("./orderSetup");

beforeAll(async () => {
  await connectTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe("AI dispatcher chat", () => {
  let world;

  beforeEach(async () => {
    world = await setupPilotCity(app);
  });

  const getChat = (cookie, role, cityId = world.city._id) =>
    request(app)
      .get(`/api/ai/chat?cityId=${cityId}&role=${role}`)
      .set("Cookie", cookie);

  const send = (cookie, role, text, cityId = world.city._id) =>
    request(app)
      .post("/api/ai/messages")
      .set("Cookie", cookie)
      .send({ cityId, role, text });

  const confirm = (cookie, role, approve, cityId = world.city._id) =>
    request(app)
      .post("/api/ai/confirm")
      .set("Cookie", cookie)
      .send({ cityId, role, approve });

  const driverOnline = () =>
    DriverProfile.findOne({ displayName: "Водитель 1" });

  it("creates one thread per user, city and role and rejects foreign roles", async () => {
    const first = await getChat(world.passenger.cookie, "passenger");
    expect(first.status).toBe(200);
    expect(first.body.data.messages).toHaveLength(1);
    expect(first.body.data.messages[0].senderType).toBe("bot");
    expect(first.body.data.messages[0].body).toMatch(/^🚕/);
    expect(first.body.data.messages[0].meta.quick.length).toBeGreaterThan(0);
    expect(typeof first.body.data.ai.keyCount).toBe("number");
    expect(JSON.stringify(first.body.data.ai)).not.toMatch(/gsk_/);

    const second = await getChat(world.passenger.cookie, "passenger");
    expect(second.body.data.chatId).toBe(first.body.data.chatId);
    expect(second.body.data.messages).toHaveLength(1);

    const driverChatForPassenger = await getChat(world.passenger.cookie, "driver");
    expect(driverChatForPassenger.status).toBe(403);

    const dispatcherChatForDriver = await getChat(world.drivers[0].cookie, "dispatcher");
    expect(dispatcherChatForDriver.status).toBe(403);
  });

  it("passenger orders a car by plain text: order is published immediately", async () => {
    const res = await send(
      world.passenger.cookie,
      "passenger",
      "нужна машина от вокзала до центра"
    );

    expect(res.status).toBe(200);
    expect(res.body.data.text).toContain("Заказ создан");
    expect(res.body.data.text).toMatch(/^🆕/);
    expect(res.body.data.orderId).toBeTruthy();

    const order = await Order.findById(res.body.data.orderId);
    expect(order).toBeTruthy();
    expect(order.status).toBe("PUBLISHED");
    expect(String(order.passengerId)).toBe(String(world.passenger.user._id));
    expect(order.from.text).toBe("от вокзала до центра");

    const messages = await Message.find({ chatId: res.body.data.chatId }).sort({
      createdAt: 1,
    });
    expect(messages).toHaveLength(3);
    expect(messages[1].body).toBe("нужна машина от вокзала до центра");
    expect(messages[2].senderType).toBe("bot");
  });

  it("driver goes on shift, sees the feed and sends an offer through the chat", async () => {
    await createOrder(app, world.passenger, world.city, {
      route: "От ЖД вокзала до Центра",
    });

    const shift = await send(world.drivers[0].cookie, "driver", "на линии");
    expect(shift.status).toBe(200);
    expect(shift.body.data.text).toContain("Вы на линии");
    expect(shift.body.data.text).toMatch(/^🟢/);
    const profile = await driverOnline();
    expect(profile.shift).toBe("online");

    const feed = await send(world.drivers[0].cookie, "driver", "доступные заказы");
    expect(feed.body.data.text).toContain("Доступные заказы");
    expect(feed.body.data.text).toContain("От ЖД вокзала до Центра");

    const offer = await send(
      world.drivers[0].cookie,
      "driver",
      "откликнусь 300 р, 5 минут"
    );
    expect(offer.status).toBe(200);
    expect(offer.body.data.text).toContain("Отклик отправлен");
    expect(offer.body.data.text).toMatch(/^📨/);

    const createdOffer = await Offer.findOne({
      orderId: feed.body.data.orderId,
      driverId: world.drivers[0].user._id,
    });
    expect(createdOffer).toBeTruthy();
    expect(createdOffer.priceText).toBe("300 ₽");
    expect(createdOffer.etaMin).toBe(5);
  });

  it("accepting an offer requires confirmation and then assigns the driver", async () => {
    const created = await createOrder(app, world.passenger, world.city);
    const orderId = created.body.data.order._id;

    const offerRes = await request(app)
      .post(`/api/orders/${orderId}/offers`)
      .set("Cookie", world.drivers[0].cookie)
      .send({ priceText: "350 ₽", etaMin: 7 });
    expect(offerRes.status).toBe(201);

    const list = await send(world.passenger.cookie, "passenger", "отклики");
    expect(list.body.data.text).toContain("350 ₽");

    const accept = await send(world.passenger.cookie, "passenger", "прими первый");
    expect(accept.status).toBe(200);
    expect(accept.body.data.confirm).toBeTruthy();
    expect(accept.body.data.confirm.summary).toContain("Назначить");

    // Nothing changed until the person presses "Подтвердить"
    let order = await Order.findById(orderId);
    expect(order.status).toBe("PUBLISHED");

    const approved = await confirm(world.passenger.cookie, "passenger", true);
    expect(approved.status).toBe(200);
    expect(approved.body.data.text).toContain("Водитель назначен");

    order = await Order.findById(orderId);
    expect(order.status).toBe("ASSIGNED");
    expect(String(order.driverId)).toBe(String(world.drivers[0].user._id));
    expect(order.priceAgreed).toBe("350 ₽");

    const offer = await Offer.findOne({ orderId, driverId: world.drivers[0].user._id });
    expect(offer.status).toBe("ACCEPTED");
  });

  it("declining a confirmation changes nothing", async () => {
    const created = await createOrder(app, world.passenger, world.city);
    const orderId = created.body.data.order._id;

    const cancel = await send(world.passenger.cookie, "passenger", "отмени заказ");
    expect(cancel.body.data.confirm).toBeTruthy();

    const declined = await confirm(world.passenger.cookie, "passenger", false);
    expect(declined.status).toBe(200);
    expect(declined.body.data.text).toContain("отменил");

    const order = await Order.findById(orderId);
    expect(order.status).toBe("PUBLISHED");
  });

  it("dispatcher sees the city and assigns a driver by name after confirmation", async () => {
    const created = await createOrder(app, world.passenger, world.city);
    const orderId = created.body.data.order._id;
    const shortId = String(orderId).slice(-6);

    const snapshot = await send(world.dispatcher.cookie, "dispatcher", "обстановка");
    expect(snapshot.status).toBe(200);
    expect(snapshot.body.data.text).toContain("ищут водителя");

    const assign = await send(
      world.dispatcher.cookie,
      "dispatcher",
      `назначь Водитель 1 на заказ #${shortId}`
    );
    expect(assign.status).toBe(200);
    expect(assign.body.data.confirm).toBeTruthy();

    const approved = await confirm(world.dispatcher.cookie, "dispatcher", true);
    expect(approved.status).toBe(200);
    expect(approved.body.data.text).toContain("Назначил");

    const order = await Order.findById(orderId);
    expect(order.status).toBe("ASSIGNED");
    expect(String(order.driverId)).toBe(String(world.drivers[0].user._id));
  });

  it("falls back politely when free text cannot be routed and the model is off", async () => {
    const res = await send(
      world.passenger.cookie,
      "passenger",
      "расскажи анекдот про кота"
    );
    expect(res.status).toBe(200);
    expect(res.body.data.text).toContain("Не понял");
    expect(res.body.data.quick.length).toBeGreaterThan(0);
  });
});
