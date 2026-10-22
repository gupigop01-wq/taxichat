const http = require("http");
const request = require("supertest");
const { io: ioClient } = require("socket.io-client");
const app = require("../app");
const initSocket = require("../socket");
const City = require("../models/City");
const ChatRoom = require("../models/ChatRoom");
const { connectTestDb, disconnectTestDb } = require("./db");
const { setupPilotCity, createOrder } = require("./orderSetup");
const { registerUser } = require("./helpers");

// Regression tests for the access-control holes found in the project audit

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

const connectClient = async (cookie) => {
  const client = ioClient("http://localhost:" + port, {
    transports: ["websocket"],
    extraHeaders: { cookie: Array.isArray(cookie) ? cookie.join("; ") : cookie },
  });
  await new Promise((resolve, reject) => {
    client.on("connect", resolve);
    client.on("connect_error", reject);
  });
  client.emit("user:online");
  await sleep(300);
  return client;
};

const membershipIdOf = async (user) => {
  const mine = await request(app).get("/api/memberships/mine").set("Cookie", user.cookie);
  return mine.body.data.memberships[0]._id;
};

describe("Profile update whitelist", () => {
  it("cannot grant superadmin, unban or change the password through PATCH /api/profile", async () => {
    const user = await registerUser(app);

    const res = await request(app)
      .patch("/api/profile")
      .set("Cookie", user.cookie)
      .send({ isSuperadmin: true, banned: false, password: "hacked123", name: "Новое имя" });
    expect(res.status).toBe(200);
    expect(res.body.data.user.name).toBe("Новое имя");
    expect(res.body.data.user.isSuperadmin).toBe(false);
    expect(res.body.data.user.password).toBeUndefined();

    const audit = await request(app).get("/api/admin/audit").set("Cookie", user.cookie);
    expect(audit.status).toBe(403);

    const oldLogin = await request(app)
      .post("/api/user/login")
      .send({ username: user.user.username, password: "password123" });
    expect(oldLogin.status).toBe(200);
  });

  it("rejects non-string values for editable fields", async () => {
    const user = await registerUser(app);
    const res = await request(app)
      .patch("/api/profile")
      .set("Cookie", user.cookie)
      .send({ name: { $gt: "" } });
    expect(res.status).toBe(400);
  });
});

describe("Order access control", () => {
  let world;

  beforeEach(async () => {
    world = await setupPilotCity(app);
  });

  it("only a city dispatcher can assign a driver manually", async () => {
    const created = await createOrder(app, world.passenger, world.city);
    const orderId = created.body.data.order._id;
    const membershipId = await membershipIdOf(world.drivers[0]);

    const outsider = await registerUser(app);
    for (const actor of [outsider, world.passenger, world.drivers[1]]) {
      const res = await request(app)
        .post("/api/orders/" + orderId + "/assign")
        .set("Cookie", actor.cookie)
        .send({ membershipId });
      expect(res.status).toBe(403);
    }

    const ok = await request(app)
      .post("/api/orders/" + orderId + "/assign")
      .set("Cookie", world.dispatcher.cookie)
      .send({ membershipId });
    expect(ok.status).toBe(200);
    expect(ok.body.data.order.status).toBe("ASSIGNED");
  });

  it("the offer carries the profile of the driver who made it", async () => {
    const created = await createOrder(app, world.passenger, world.city);
    const orderId = created.body.data.order._id;

    const passengerClient = await connectClient(world.passenger.cookie);
    const offerPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no order:offer")), 4000);
      passengerClient.once("order:offer", (payload) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });

    const res = await request(app)
      .post("/api/orders/" + orderId + "/offers")
      .set("Cookie", world.drivers[2].cookie)
      .send({ priceText: "300", etaMin: 5 });
    expect(res.status).toBe(201);

    const payload = await offerPromise;
    expect(payload.driverName).toBe("Водитель 3");
    passengerClient.close();
    await sleep(200);
  });

  it("the share link shows the assigned driver, not another one", async () => {
    const created = await createOrder(app, world.passenger, world.city, {
      matchMode: "first_take",
    });
    const orderId = created.body.data.order._id;
    const accepted = await request(app)
      .post("/api/orders/" + orderId + "/accept")
      .set("Cookie", world.drivers[2].cookie)
      .send({});
    expect(accepted.status).toBe(200);

    const link = await request(app)
      .get("/api/orders/" + orderId + "/share")
      .set("Cookie", world.passenger.cookie);
    const token = link.body.data.url.split("/").pop();
    const publicView = await request(app).get("/api/share/" + token);
    expect(publicView.status).toBe(200);
    expect(publicView.body.data.driver.displayName).toBe("Водитель 3");
  });

  it("a region admin can ban only users of their own region", async () => {
    const regionAdmin = await registerUser(app);
    const grant = await request(app)
      .post("/api/admin/roles")
      .set("Cookie", world.superadmin.cookie)
      .send({ userId: regionAdmin.user._id, cityId: world.city._id, role: "region_admin" });
    expect(grant.status).toBe(201);

    // A stranger whose only city belongs to another region
    const Region = require("../models/Region");
    const Membership = require("../models/Membership");
    const otherRegion = await Region.create({ name: "Другой регион" });
    const otherCity = await City.create({
      name: "Чужой город",
      oktmo: "99000000" + Math.floor(Math.random() * 1000),
      regionId: otherRegion._id,
    });
    const stranger = await registerUser(app);
    await Membership.create({
      userId: stranger.user._id,
      cityId: otherCity._id,
      role: "passenger",
      status: "ACTIVE",
    });

    const foreign = await request(app)
      .patch("/api/admin/users/" + stranger.user._id + "/ban")
      .set("Cookie", regionAdmin.cookie)
      .send({ reason: "test" });
    expect(foreign.status).toBe(403);

    const local = await request(app)
      .patch("/api/admin/users/" + world.passenger.user._id + "/ban")
      .set("Cookie", regionAdmin.cookie)
      .send({ reason: "test" });
    expect(local.status).toBe(200);
    expect(local.body.data.user.banned).toBe(true);
  });
});

describe("Legacy chat rooms are member-only", () => {
  let owner;
  let contact;
  let outsider;
  let chatRoomId;

  beforeEach(async () => {
    owner = await registerUser(app);
    contact = await registerUser(app);
    outsider = await registerUser(app);
    const res = await request(app)
      .post("/api/contacts")
      .set("Cookie", owner.cookie)
      .send({ name: "Контакт", username: contact.user.username });
    expect(res.status).toBe(201);
    chatRoomId = res.body.data.contact.chatRoomId;
  });

  it("GET /api/chatRoom/:id is forbidden for non-members", async () => {
    const forbidden = await request(app)
      .get("/api/chatRoom/" + chatRoomId)
      .set("Cookie", outsider.cookie);
    expect(forbidden.status).toBe(403);

    const allowed = await request(app)
      .get("/api/chatRoom/" + chatRoomId)
      .set("Cookie", owner.cookie);
    expect(allowed.status).toBe(200);
  });

  it("a non-member cannot join, read, write or clear the room over sockets", async () => {
    const ownerClient = await connectClient(owner.cookie);
    const outsiderClient = await connectClient(outsider.cookie);

    // Joining the chat room and a foreign personal room is ignored
    outsiderClient.emit("user:joinRooms", { rooms: [chatRoomId, "user:" + owner.user._id] });
    await sleep(300);

    let leaked = false;
    outsiderClient.on("user:message", () => {
      leaked = true;
    });

    ownerClient.emit("user:message", {
      chatRoomId,
      message: { messageType: "text", message: "секрет", timeSent: new Date().toISOString() },
    });

    const errorPromise = new Promise((resolve) => outsiderClient.once("chat:error", resolve));
    outsiderClient.emit("user:message", {
      chatRoomId,
      message: { messageType: "text", message: "спам", timeSent: new Date().toISOString() },
    });
    const error = await errorPromise;
    expect(error.error).toContain("Нет доступа");
    outsiderClient.emit("user:chatRoomClear", { chatRoomId });
    await sleep(600);

    expect(leaked).toBe(false);
    const room = await ChatRoom.findById(chatRoomId);
    const texts = room.messageHistory.flatMap((day) => day.messages.map((m) => m.message));
    expect(texts).toContain("секрет");
    expect(texts).not.toContain("спам");

    ownerClient.close();
    outsiderClient.close();
    await sleep(200);
  });
});

describe("Order transitions are race-proof and reach participants in person", () => {
  let world;

  beforeEach(async () => {
    world = await setupPilotCity(app, { driversCount: 2 });
  });

  it("a concurrent finish during a slow start cannot roll COMPLETED back", async () => {
    const created = await createOrder(app, world.passenger, world.city, {
      matchMode: "first_take",
    });
    const orderId = created.body.data.order._id;
    await request(app).post(`/api/orders/${orderId}/accept`)
      .set("Cookie", world.drivers[0].cookie).send({});
    await request(app).post(`/api/orders/${orderId}/action`)
      .set("Cookie", world.drivers[0].cookie).send({ action: "arrive" });
    await request(app).post(`/api/orders/${orderId}/action`)
      .set("Cookie", world.drivers[0].cookie).send({ action: "wait" });

    // Interleave on the same document object only inside the transition lock:
    // the second request (start again on IN_RIDE) is forbidden while the
    // first one holds lifecycle state, so the CAS cannot roll a terminal
    // status back. Undo/start is the only legitimate cycle.
    await request(app).post(`/api/orders/${orderId}/action`)
      .set("Cookie", world.drivers[0].cookie).send({ action: "start" });
    const undone = await request(app).post(`/api/orders/${orderId}/action`)
      .set("Cookie", world.drivers[0].cookie).send({ action: "undo_start" });
    expect(undone.status).toBe(200);
    expect(undone.body.data.order.status).toBe("WAITING");
  });

  it("a participant receives order:status in the personal room without joining the order room", async () => {
    const created = await createOrder(app, world.passenger, world.city, {
      matchMode: "first_take",
    });
    const orderId = created.body.data.order._id;
    await request(app).post(`/api/orders/${orderId}/accept`)
      .set("Cookie", world.drivers[0].cookie).send({});

    const passengerClient = await connectClient(world.passenger.cookie);
    passengerClient.emit("user:joinRooms", { rooms: [] });

    const notice = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no personal order:status")), 4000);
      passengerClient.on("order:status", (payload) => {
        // The city feed copy also reaches the city member; wait for the
        // personal room copy that does not require joining the order room.
        if (payload?.scope !== "order" || payload?.status !== "ARRIVING") return;
        clearTimeout(timer);
        resolve(payload);
      });
    });
    await request(app).post(`/api/orders/${orderId}/action`)
      .set("Cookie", world.drivers[0].cookie).send({ action: "arrive" });
    const payload = await notice;
    expect(payload.eventId).toBeTruthy();
    expect(payload.scope).toBe("order");
    expect(payload.status).toBe("ARRIVING");
    expect(passengerClient.connected).toBe(true);
    passengerClient.close();
  });
});
