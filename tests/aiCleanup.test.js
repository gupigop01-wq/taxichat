// The AI thread is a status line, not a log: every sweep leaves the greeting
// plus one bubble about an order that is still in flight.
process.env.AI_ENABLED = "0";

const request = require("supertest");
const mongoose = require("mongoose");
const app = require("../app");
const Message = require("../models/Message");
const Order = require("../models/Order");
const AiSession = require("../models/AiSession");
const { cleanupAiChats } = require("../services/ai/cleanup");
const { connectTestDb, disconnectTestDb } = require("./db");
const { setupPilotCity, createOrder } = require("./orderSetup");

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;

beforeAll(async () => {
  await connectTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

const openChat = async (world) => {
  const res = await request(app)
    .get(`/api/ai/chat?cityId=${world.city._id}&role=passenger`)
    .set("Cookie", world.passenger.cookie);
  expect(res.status).toBe(200);
  return res.body.data.chatId;
};

const addMessage = (chatId, body, { at, meta } = {}) =>
  Message.create({
    chatId,
    senderType: "bot",
    kind: "text",
    body,
    meta,
    ...(at && { createdAt: at }),
  });

describe("AI chat cleanup", () => {
  let world;

  beforeEach(async () => {
    world = await setupPilotCity(app);
  });

  it("leaves only the greeting when no order is in flight", async () => {
    const chatId = await openChat(world);
    const old = await addMessage(chatId, "старый ответ", {
      at: new Date(Date.now() - 15 * DAY),
    });
    const fresh = await addMessage(chatId, "свежий ответ", {
      at: new Date(Date.now() - MIN),
    });

    const summary = await cleanupAiChats();

    const messages = await Message.find({ chatId }).select("body meta").lean();
    expect(messages).toHaveLength(1);
    expect(messages[0].meta?.welcome).toBe(true);
    expect(summary.messages).toBe(2);
    expect(summary.removed[String(chatId)]).toEqual(
      expect.arrayContaining([String(old._id), String(fresh._id)])
    );
  });

  it("keeps a single bubble for an active order however many events it had", async () => {
    const chatId = await openChat(world);
    const created = await createOrder(app, world.passenger, world.city);
    const orderId = String(created.body.data.order._id);
    const publish = await addMessage(chatId, "заказ опубликован", {
      at: new Date(Date.now() - 4 * MIN),
      meta: { kind: "order_event", orderId, event: "publish", status: "PUBLISHED" },
    });
    const offer = await addMessage(chatId, "отклик водителя", {
      at: new Date(Date.now() - 3 * MIN),
      meta: { kind: "order_event", orderId, event: "offer", status: "PUBLISHED" },
    });
    const assign = await addMessage(chatId, "водитель назначен", {
      at: new Date(Date.now() - 1 * MIN),
      meta: { kind: "order_event", orderId, event: "assign", status: "ASSIGNED" },
    });

    const summary = await cleanupAiChats();

    const left = await Message.find({ chatId }).select("body meta").lean();
    expect(left).toHaveLength(2);
    expect(left.filter((item) => item.meta?.welcome)).toHaveLength(1);
    expect(left.find((item) => !item.meta?.welcome)._id).toEqual(assign._id);
    expect(summary.removed[String(chatId)]).toEqual(
      expect.arrayContaining([String(publish._id), String(offer._id)])
    );
    expect(summary.removed[String(chatId)]).not.toContain(String(assign._id));
  });

  it("drops every trace of a finished order, even its finish message", async () => {
    const chatId = await openChat(world);
    const created = await createOrder(app, world.passenger, world.city);
    const orderId = String(created.body.data.order._id);
    await Order.updateOne(
      { _id: orderId },
      { $set: { status: "CANCELLED" } },
      { timestamps: false }
    );
    await addMessage(chatId, "заказ опубликован", {
      at: new Date(Date.now() - 2 * MIN),
      meta: { kind: "order_event", orderId, event: "publish", status: "PUBLISHED" },
    });
    await addMessage(chatId, "заказ отменён", {
      at: new Date(Date.now() - 1 * MIN),
      meta: { kind: "order_event", orderId, event: "cancel", status: "CANCELLED" },
    });

    await cleanupAiChats();

    const left = await Message.find({ chatId }).select("body meta").lean();
    expect(left).toHaveLength(1);
    expect(left[0].meta?.welcome).toBe(true);
  });

  it("keeps the newest answer instead of the status it answered", async () => {
    const chatId = await openChat(world);
    const created = await createOrder(app, world.passenger, world.city);
    const orderId = String(created.body.data.order._id);
    await addMessage(chatId, "заказ опубликован", {
      at: new Date(Date.now() - 3 * MIN),
      meta: { kind: "order_event", orderId, event: "publish", status: "PUBLISHED" },
    });
    const answer = await addMessage(chatId, "Назначил Иван на заказ", {
      at: new Date(Date.now() - 1 * MIN),
      meta: { orderId },
    });

    await cleanupAiChats();

    const left = await Message.find({ chatId, "meta.welcome": { $ne: true } })
      .select("body meta")
      .lean();
    expect(left).toHaveLength(1);
    expect(left[0]._id).toEqual(answer._id);
  });

  it("recognises a legacy order card by its ObjectId", async () => {
    const chatId = await openChat(world);
    const created = await createOrder(app, world.passenger, world.city);
    const orderId = String(created.body.data.order._id);
    const card = await addMessage(chatId, "Доступные заказы", {
      at: new Date(Date.now() - 1 * MIN),
      meta: { orderId: new mongoose.Types.ObjectId(orderId), status: "PUBLISHED" },
    });

    await cleanupAiChats();

    const left = await Message.find({ chatId, "meta.welcome": { $ne: true } })
      .select("body")
      .lean();
    expect(left).toHaveLength(1);
    expect(left[0]._id).toEqual(card._id);
  });

  it("prunes a thread immediately when the order is cancelled", async () => {
    const created = await createOrder(app, world.passenger, world.city);
    const orderId = String(created.body.data.order._id);
    const offerRes = await request(app)
      .post(`/api/orders/${orderId}/offers`)
      .set("Cookie", world.drivers[0].cookie)
      .send({ priceText: "350 ₽", etaMin: 7 });
    expect(offerRes.status).toBe(201);

    const cancelled = await request(app)
      .post(`/api/orders/${orderId}/cancel`)
      .set("Cookie", world.dispatcher.cookie)
      .send({ reason: "Нет свободных машин" });
    expect(cancelled.status).toBe(200);

    const passengerChat = await request(app)
      .get(`/api/ai/chat?cityId=${world.city._id}&role=passenger`)
      .set("Cookie", world.passenger.cookie);
    const passengerEvents = passengerChat.body.data.messages.filter(
      (item) =>
        item.meta?.kind === "order_event" &&
        String(item.meta.orderId) === orderId
    );
    expect(passengerEvents).toHaveLength(1);
    expect(passengerEvents[0].meta.event).toBe("cancel");

    const dispatcherChat = await request(app)
      .get(`/api/ai/chat?cityId=${world.city._id}&role=dispatcher`)
      .set("Cookie", world.dispatcher.cookie);
    const staffEvents = dispatcherChat.body.data.messages.filter(
      (item) =>
        item.meta?.kind === "order_event" &&
        String(item.meta.orderId) === orderId
    );
    expect(staffEvents).toHaveLength(1);
    expect(staffEvents[0].meta.event).toBe("cancel");
  });

  it("clears a confirmation nobody answered in half an hour", async () => {
    await openChat(world);
    const session = await AiSession.findOne({
      userId: world.passenger.user._id,
      role: "passenger",
    });
    session.pending = {
      tool: "cancel_order",
      args: {},
      summary: "Отменить заказ",
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    };
    await session.save();

    await cleanupAiChats();

    const fresh = await AiSession.findById(session._id);
    expect(fresh.pending).toBeNull();
  });
});
