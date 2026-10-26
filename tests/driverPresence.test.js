const http = require("http");
const request = require("supertest");
const { io: ioClient } = require("socket.io-client");
const app = require("../app");
const initSocket = require("../socket");
const Membership = require("../models/Membership");
const DriverProfile = require("../models/DriverProfile");
const { connectTestDb, disconnectTestDb } = require("./db");
const { setupPilotCity } = require("./orderSetup");

// Regression tests: a driver taken off the line by a dispatcher cannot come
// back by simply asking for a shift — the reason has to be acknowledged.

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
  const client = ioClient(`http://localhost:${port}`, {
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

const waitFor = (client, event, timeoutMs = 3000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    client.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

describe("driver taken off the line by a dispatcher", () => {
  let world;
  let membershipId;
  let driverClient;

  beforeEach(async () => {
    world = await setupPilotCity(app);
    const membership = await Membership.findOne({
      userId: world.drivers[0].user._id,
      role: "driver",
    });
    membershipId = membership._id;
    await DriverProfile.findOneAndUpdate(
      { membershipId },
      { shift: "online", lastSeen: new Date() },
      { upsert: true }
    );
    driverClient = await connectClient(world.drivers[0].cookie);
  });

  afterEach(() => {
    driverClient?.close();
  });

  const forceOffline = (reason = "Жалобы пассажиров") =>
    request(app)
      .patch(`/api/dispatch/${world.city._id}/drivers/${membershipId}/offline`)
      .set("Cookie", world.dispatcher.cookie)
      .send({ reason });

  it("cannot go back online without confirming the reason", async () => {
    const pushed = waitFor(driverClient, "driver:offline");
    expect((await forceOffline()).status).toBe(200);
    expect((await pushed).reason).toBe("Жалобы пассажиров");

    // A plain "online" is refused: the note is still there
    const refused = waitFor(driverClient, "driver:offline");
    driverClient.emit("driver:shift", { shift: "online" });
    const response = await refused;
    expect(response.needsConfirmation).toBe(true);
    expect(response.reason).toBe("Жалобы пассажиров");

    await sleep(200);
    const afterRefusal = await DriverProfile.findOne({ membershipId });
    expect(afterRefusal.shift).toBe("offline");
    expect(afterRefusal.shiftNote).toBe("Жалобы пассажиров");
  });

  it("goes back online after the driver confirms and clears the note", async () => {
    await forceOffline("Нарушение формы");
    const changed = waitFor(driverClient, "driver:presence");
    driverClient.emit("driver:shift", { shift: "online", confirmBack: true });
    const payload = await changed;
    expect(payload.shift).toBe("online");

    await sleep(200);
    const profile = await DriverProfile.findOne({ membershipId });
    expect(profile.shift).toBe("online");
    expect(profile.shiftNote).toBe(null);
    expect(profile.shiftChangedBy ?? null).toBe(null);
  });

  it("a heartbeat does not bring the driver back on the line", async () => {
    await forceOffline("Проверка документов");
    driverClient.emit("driver:heartbeat");
    await sleep(300);

    const profile = await DriverProfile.findOne({ membershipId });
    expect(profile.shift).toBe("offline");
    expect(profile.shiftNote).toBe("Проверка документов");
  });

  it("the REST settings endpoint honours the same lock", async () => {
    await forceOffline("Решение диспетчера");

    const denied = await request(app)
      .patch("/api/drivers/me/settings")
      .set("Cookie", world.drivers[0].cookie)
      .send({ cityId: String(world.city._id), acceptDirectCalls: true, shift: "online" });
    expect(denied.status).toBe(409);
    expect((await DriverProfile.findOne({ membershipId })).shift).toBe("offline");

    const confirmed = await request(app)
      .patch("/api/drivers/me/settings")
      .set("Cookie", world.drivers[0].cookie)
      .send({
        cityId: String(world.city._id),
        acceptDirectCalls: true,
        shift: "online",
        confirmBack: true,
      });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data.profile.shift).toBe("online");
    expect(confirmed.body.data.profile.shiftNote ?? null).toBe(null);
  });
});
