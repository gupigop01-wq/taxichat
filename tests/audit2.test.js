const http = require("http");
const request = require("supertest");
const { io: ioClient } = require("socket.io-client");

// Agenda connects in its constructor, before start(); never construct it here.
jest.mock("agenda", () => jest.fn().mockImplementation(() => ({
  define: jest.fn(),
  start: jest.fn().mockResolvedValue(),
  every: jest.fn().mockResolvedValue(),
  schedule: jest.fn().mockResolvedValue(),
})));

const app = require("../app");
const initSocket = require("../socket");
const City = require("../models/City");
const Order = require("../models/Order");
const Offer = require("../models/Offer");
const Region = require("../models/Region");
const Membership = require("../models/Membership");
const { connectTestDb, disconnectTestDb } = require("./db");
const { setupPilotCity, createOrder } = require("./orderSetup");
const { registerUser } = require("./helpers");

// Regression tests for audit items 6-11 (token exposure, disputes, booking
// race, offers, complaints scope, ratings, auto-approve, bans, preorders)

let httpServer;
let ioInstance;
let port;

beforeAll(async () => {
  await connectTestDb();
  httpServer = http.createServer(app);
  ioInstance = initSocket(httpServer);
  await new Promise((resolve) => httpServer.listen(0, resolve));
  port = httpServer.address().port;
}, 15000);

afterAll(async () => {
  if (ioInstance) ioInstance.close();
  httpServer.closeAllConnections?.();
  await new Promise((resolve) => httpServer.close(resolve));
  await new Promise((resolve) => setTimeout(resolve, 300));
  await disconnectTestDb();
}, 15000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const takeOrder = async (world, driver = world.drivers[0]) => {
  const created = await createOrder(app, world.passenger, world.city, { matchMode: "first_take" });
  const orderId = created.body.data.order._id;
  const accepted = await request(app)
    .post(`/api/orders/${orderId}/accept`)
    .set("Cookie", driver.cookie)
    .send({});
  expect(accepted.status).toBe(200);
  return orderId;
};

describe("Auth responses", () => {
  it("do not expose the JWT in the response body", async () => {
    const username = `tok_${Date.now()}`;
    const reg = await request(app).post("/api/user/register").send({
      name: "Тест",
      username,
      password: "Bombila2026",
      confirmPassword: "Bombila2026",
    });
    expect(reg.status).toBe(201);
    expect(reg.body.data.token).toBeUndefined();
    expect(reg.headers["set-cookie"].join(";")).toMatch(/telegramToken=/);

    const login = await request(app)
      .post("/api/user/login")
      .send({ username, password: "Bombila2026" });
    expect(login.status).toBe(200);
    expect(login.body.data.token).toBeUndefined();
    expect(login.body.data.user.password).toBeUndefined();
  });
});

describe("Orders: disputes, booking, offers", () => {
  let world;

  beforeEach(async () => {
    world = await setupPilotCity(app);
  });

  it("a city dispatcher resolves a dispute and frees the driver", async () => {
    const orderId = await takeOrder(world);
    const disputed = await request(app)
      .post(`/api/orders/${orderId}/dispute`)
      .set("Cookie", world.passenger.cookie)
      .send({ reason: "Не туда едет" });
    expect(disputed.body.data.order.status).toBe("DISPUTE");

    for (const actor of [world.passenger, world.drivers[0], world.drivers[1]]) {
      const denied = await request(app)
        .post(`/api/orders/${orderId}/resolve`)
        .set("Cookie", actor.cookie)
        .send({ outcome: "cancel" });
      expect(denied.status).toBe(403);
    }

    const resolved = await request(app)
      .post(`/api/orders/${orderId}/resolve`)
      .set("Cookie", world.dispatcher.cookie)
      .send({ outcome: "cancel", reason: "Пассажир прав" });
    expect(resolved.status).toBe(200);
    expect(resolved.body.data.order.status).toBe("CANCELLED");

    const DriverProfile = require("../models/DriverProfile");
    const membership = await Membership.findOne({ userId: world.drivers[0].user._id, role: "driver" });
    const profile = await DriverProfile.findOne({ membershipId: membership._id });
    expect(profile.shift).toBe("online");

    const again = await request(app)
      .post(`/api/orders/${orderId}/resolve`)
      .set("Cookie", world.dispatcher.cookie)
      .send({ outcome: "complete" });
    expect(again.status).toBe(409);
  });

  it("two drivers booking at once: exactly one wins, bookedAt is stored", async () => {
    const created = await createOrder(app, world.passenger, world.city, {
      whenType: "scheduled",
      whenAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
    });
    const orderId = created.body.data.order._id;

    const results = await Promise.all(
      world.drivers.map((driver) =>
        request(app).post(`/api/orders/${orderId}/book`).set("Cookie", driver.cookie)
      )
    );
    const winners = results.filter((res) => res.status === 200);
    expect(winners).toHaveLength(1);
    expect(results.filter((res) => res.status === 409)).toHaveLength(world.drivers.length - 1);

    const stored = await Order.findById(orderId);
    expect(stored.status).toBe("BOOKED");
    expect(String(stored.driverId)).toBe(String(winners[0].body.data.order.driverId));
    expect(stored.bookedAt).toBeInstanceOf(Date);
    expect(stored.statusLog.filter((entry) => entry.status === "BOOKED")).toHaveLength(1);
  });

  it("a declined offer or a busy driver's offer cannot be accepted", async () => {
    const created = await createOrder(app, world.passenger, world.city);
    const orderId = created.body.data.order._id;
    const offerRes = await request(app)
      .post(`/api/orders/${orderId}/offers`)
      .set("Cookie", world.drivers[1].cookie)
      .send({ priceText: "300", etaMin: 5 });
    expect(offerRes.status).toBe(201);
    const offerId = offerRes.body.data.offer._id;

    // Driver 2 meanwhile takes another order and becomes busy
    await takeOrder(world, world.drivers[1]);
    const busy = await request(app)
      .post(`/api/orders/${orderId}/accept`)
      .set("Cookie", world.passenger.cookie)
      .send({ offerId });
    expect(busy.status).toBe(409);

    await Offer.updateOne({ _id: offerId }, { $set: { status: "DECLINED" } });
    const declined = await request(app)
      .post(`/api/orders/${orderId}/accept`)
      .set("Cookie", world.passenger.cookie)
      .send({ offerId });
    expect(declined.status).toBe(409);
    expect((await Order.findById(orderId)).status).toBe("PUBLISHED");
  });

  it("a region admin sees only complaints of their region", async () => {
    const regionAdmin = await registerUser(app);
    await request(app)
      .post("/api/admin/roles")
      .set("Cookie", world.superadmin.cookie)
      .send({ userId: regionAdmin.user._id, cityId: world.city._id, role: "region_admin" });

    const orderId = await takeOrder(world);
    const local = await request(app)
      .post("/api/complaints")
      .set("Cookie", world.passenger.cookie)
      .send({ orderId, type: "behavior", text: "Грубил" });
    expect(local.status).toBe(201);

    const otherRegion = await Region.create({ name: "Дальний регион" });
    const otherCity = await City.create({
      name: "Дальний город",
      oktmo: "98000000" + Math.floor(Math.random() * 1000),
      regionId: otherRegion._id,
    });
    const stranger = await registerUser(app, { cityId: String(otherCity._id) });
    const foreign = await request(app)
      .post("/api/complaints")
      .set("Cookie", stranger.cookie)
      .send({ type: "other", text: "Чужая жалоба" });
    expect(foreign.status).toBe(201);

    const list = await request(app)
      .get("/api/admin/complaints")
      .set("Cookie", regionAdmin.cookie);
    expect(list.status).toBe(200);
    const ids = list.body.data.complaints.map((item) => item._id);
    expect(ids).toContain(local.body.data.complaint._id);
    expect(ids).not.toContain(foreign.body.data.complaint._id);

    const review = await request(app)
      .patch(`/api/admin/complaints/${foreign.body.data.complaint._id}`)
      .set("Cookie", regionAdmin.cookie)
      .send({ status: "DISMISSED" });
    expect(review.status).toBe(404);

    const all = await request(app)
      .get("/api/admin/complaints")
      .set("Cookie", world.superadmin.cookie);
    expect(all.body.data.complaints.map((item) => item._id)).toContain(
      foreign.body.data.complaint._id
    );
  });

  it("auto-approve with an occupied car pair leaves no active driver", async () => {
    await City.updateOne({ _id: world.city._id }, { $set: { "settings.autoApproveDrivers": true } });
    const DriverProfile = require("../models/DriverProfile");
    const existingMembership = await Membership.findOne({
      userId: world.drivers[0].user._id,
      role: "driver",
    });
    const existing = await DriverProfile.findOne({ membershipId: existingMembership._id });

    const copycat = await registerUser(app);
    const res = await request(app)
      .post("/api/memberships")
      .set("Cookie", copycat.cookie)
      .send({
        cityId: world.city._id,
        role: "driver",
        displayName: "Двойник",
        phone: "+79009998877",
        car: { color: existing.car.color, plate: existing.car.plate },
      });
    expect(res.status).toBe(409);
    expect(await Membership.exists({ userId: copycat.user._id, role: "driver" })).toBeNull();
    expect(await DriverProfile.exists({ phone: "+79009998877" })).toBeNull();
  });

  it("a banned user's live socket is disconnected and cannot reconnect", async () => {
    const client = ioClient("http://localhost:" + port, {
      transports: ["websocket"],
      reconnection: false,
      extraHeaders: { cookie: world.passenger.cookie.join("; ") },
    });
    await new Promise((resolve, reject) => {
      client.on("connect", resolve);
      client.on("connect_error", reject);
    });
    client.emit("user:online");
    await sleep(300);

    const dropped = new Promise((resolve) => client.on("disconnect", resolve));
    const ban = await request(app)
      .patch(`/api/admin/users/${world.passenger.user._id}/ban`)
      .set("Cookie", world.superadmin.cookie)
      .send({ reason: "test" });
    expect(ban.status).toBe(200);
    await Promise.race([dropped, sleep(2000).then(() => { throw new Error("socket not dropped"); })]);
    client.close();

    // A reconnect is admitted only anonymously: no personal rooms
    const { getIo } = require("../utilities/sockets");
    const again = ioClient("http://localhost:" + port, {
      transports: ["websocket"],
      reconnection: false,
      extraHeaders: { cookie: world.passenger.cookie.join("; ") },
    });
    await new Promise((resolve) => again.on("connect", resolve));
    again.emit("user:online");
    await sleep(300);
    const rooms = await getIo().in(`user:${world.passenger.user._id}`).fetchSockets();
    expect(rooms).toHaveLength(0);
    again.close();
    await sleep(100);
  });
});

describe("Ratings", () => {
  it("an invalid user id returns 400, not 500", async () => {
    const user = await registerUser(app);
    const res = await request(app).get("/api/drivers/not-an-id/rating").set("Cookie", user.cookie);
    expect(res.status).toBe(400);
  });
});

describe("Preorder scheduling", () => {
  let agenda;

  beforeEach(async () => {
    agenda = await require("../jobs/index").initJobs("mongodb://unused/test");
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("activation comes before the reminder and an unbooked preorder expires", async () => {
    const jobs = require("../jobs/index");
    const scheduled = [];
    agenda.schedule.mockImplementation(async (at, name, data) => scheduled.push({ at, name, data }));

    const city = await City.create({ name: "Город предзаказа", oktmo: "97" + Date.now() });
    const whenAt = new Date(Date.now() + 3 * 60 * 60 * 1000);
    await jobs.scheduleOrderJobs({
      _id: "507f1f77bcf86cd799439011",
      cityId: city._id,
      when: { type: "scheduled", at: whenAt },
    });

    const byName = Object.fromEntries(scheduled.map((job) => [job.name, job.at.getTime()]));
    expect(byName["preorder:activate"]).toBeLessThan(byName["preorder:reminder"]);
    expect(byName["preorder:reminder"]).toBeLessThan(whenAt.getTime());
    expect(byName["order:expire"]).toBeGreaterThan(whenAt.getTime());
    expect(require("agenda")).toHaveBeenCalledWith(expect.objectContaining({
      db: { address: "mongodb://unused/test", collection: "agendaJobs" },
    }));
  });

  it.each([-25, 5])("a booking at offset %i minutes gets a final activation opportunity", async (offsetMinutes) => {
    const world = await setupPilotCity(app);
    const handlers = require("../jobs/handlers");
    const Chat = require("../models/Chat");
    const whenAt = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const created = await createOrder(app, world.passenger, world.city, {
      whenType: "scheduled",
      whenAt: whenAt.toISOString(),
    });
    expect(created.status).toBe(201);
    const orderId = created.body.data.order._id;
    const leadJob = agenda.schedule.mock.calls.find(
      ([, name, data]) => name === "preorder:activate" && data.orderId === orderId
    );
    expect(leadJob[0].getTime()).toBe(whenAt.getTime() - 30 * 60 * 1000);
    await handlers.runPreorderActivate(leadJob[2]);

    const bookingTime = whenAt.getTime() + offsetMinutes * 60 * 1000;
    jest.spyOn(Date, "now").mockReturnValue(bookingTime);
    const booked = await request(app)
      .post(`/api/orders/${orderId}/book`)
      .set("Cookie", world.drivers[0].cookie);
    expect(booked.status).toBe(200);
    expect(booked.body.data.order.status).toBe("BOOKED");
    const finalJob = agenda.schedule.mock.calls.find(
      ([, name, data]) => name === "preorder:activate" && data.orderId === orderId && data.bookingOnly
    );
    expect(finalJob[0].getTime()).toBe(Math.max(bookingTime, whenAt.getTime()));

    await Promise.all([
      handlers.runPreorderActivate(finalJob[2]),
      handlers.runPreorderActivate(finalJob[2]),
    ]);
    await handlers.runPreorderActivate(finalJob[2]);
    const activated = await Order.findById(orderId);
    expect(activated.status).toBe("ASSIGNED");
    expect(activated.activatedAt).toBeInstanceOf(Date);
    expect(activated.statusLog.filter((entry) => entry.status === "ASSIGNED")).toHaveLength(1);
    const chat = await Chat.findById(activated.chatId);
    expect(chat.members.map(String)).toContain(String(world.drivers[0].user._id));
  });

  it("a final activation neither publishes nor fans out an unbooked order", async () => {
    const world = await setupPilotCity(app);
    const handlers = require("../jobs/handlers");
    const created = await createOrder(app, world.passenger, world.city, {
      whenType: "scheduled",
      whenAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    const orderId = created.body.data.order._id;
    const scheduledCount = agenda.schedule.mock.calls.length;
    for (const status of ["PUBLISHED", "DRAFT", "CANCELLED"]) {
      await Order.updateOne({ _id: orderId }, { $set: { status } });
      await handlers.runPreorderActivate({ orderId, bookingOnly: true });
      expect((await Order.findById(orderId)).status).toBe(status);
      expect(agenda.schedule).toHaveBeenCalledTimes(scheduledCount);
    }
  });
});

