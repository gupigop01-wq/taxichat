const request = require("supertest");
const app = require("../app");
const { connectTestDb, disconnectTestDb } = require("./db");
const { registerUser } = require("./helpers");
const pushService = require("../utilities/pushService");

jest.mock("web-push", () => ({
  setVapidDetails: jest.fn(),
  sendNotification: jest.fn().mockResolvedValue({ statusCode: 201 }),
}), { virtual: true });

const credentialKeys = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"];
const savedEnvironment = Object.fromEntries(
  ["NODE_ENV", ...credentialKeys].map((key) => [key, process.env[key]])
);
beforeAll(async () => {
  await connectTestDb();
  process.env.VAPID_PUBLIC_KEY = "BTestPublic";
  process.env.VAPID_PRIVATE_KEY = "TestPrivate";
});
afterAll(async () => {
  await disconnectTestDb();
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
beforeEach(() => {
  const webpush = require("web-push");
  webpush.sendNotification.mockReset().mockResolvedValue({ statusCode: 201 });
  pushService.configure();
});

const goodSubscription = {
  endpoint: "https://push.example/sub-1",
  keys: { p256dh: "p256dhkey", auth: "authkey" },
};

describe("push subscriptions API", () => {
  it("exposes the VAPID public key when configured", async () => {
    const response = await request(app).get("/api/push/vapid-public");
    expect(response.status).toBe(200);
    expect(response.body.data.publicKey).toBe("BTestPublic");
  });

  it("requires authentication to subscribe and unsubscribe", async () => {
    expect((await request(app).post("/api/push/subscribe").send(goodSubscription)).status).toBe(401);
    expect((await request(app).post("/api/push/unsubscribe").send({ endpoint: "x" })).status).toBe(401);
  });

  it("saves a subscription and reports it is ready to receive pushes", async () => {
    const session = await registerUser(app);
    const response = await request(app).post("/api/push/subscribe").set("Cookie", session.cookie)
      .send(goodSubscription);
    expect(response.status).toBe(201);

    const result = await pushService.sendPushToUser(session.user._id, { title: "Тест", body: "Проверка" });
    expect(result.sent).toBe(1);
    const webpush = require("web-push");
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
    const [, body] = webpush.sendNotification.mock.calls[0];
    expect(JSON.parse(body).title).toBe("Тест");
  });

  it("subscribing twice refreshes the keys without duplicating endpoints", async () => {
    const session = await registerUser(app);
    for (const auth of ["authkey-1", "authkey-2"]) {
      const response = await request(app).post("/api/push/subscribe").set("Cookie", session.cookie)
        .send({ ...goodSubscription, keys: { p256dh: "key", auth } });
      expect(response.status).toBe(201);
    }
    const PushSubscription = require("../models/PushSubscription");
    expect(await PushSubscription.countDocuments({ "endpoint": goodSubscription.endpoint })).toBe(1);
  });

  it("prunes dead subscriptions on 404/410 from the push service", async () => {
    const session = await registerUser(app);
    await request(app).post("/api/push/subscribe").set("Cookie", session.cookie).send(goodSubscription);
    const webpush = require("web-push");
    webpush.sendNotification.mockRejectedValueOnce(Object.assign(new Error("gone"), { statusCode: 410 }));
    const result = await pushService.sendPushToUser(session.user._id, { title: "x" });
    expect(result.failed).toBe(1);
    const PushSubscription = require("../models/PushSubscription");
    expect(await PushSubscription.countDocuments({ "endpoint": goodSubscription.endpoint })).toBe(0);
  });

  it("skips pushes gracefully without configuration", async () => {
    pushService.__resetConfiguredForTests();
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    const session = await registerUser(app);
    await request(app).post("/api/push/subscribe").set("Cookie", session.cookie).send(goodSubscription);
    const result = await pushService.sendPushToUser(session.user._id, { title: "x" });
    expect(result).toEqual({ sent: 0, skipped: "push-not-configured" });
  });
});

describe("new order fan-out", () => {
  const subscribe = async (userId) => {
    const PushSubscription = require("../models/PushSubscription");
    await PushSubscription.create({
      userId,
      endpoint: `https://push.example/${userId}`,
      keys: goodSubscription.keys,
    });
  };

  it("notifies on-the-go drivers plus the dispatcher and region admin of the city", async () => {
    process.env.VAPID_PUBLIC_KEY = "BTestPublic";
    process.env.VAPID_PRIVATE_KEY = "TestPrivate";
    pushService.__resetConfiguredForTests();
    pushService.configure();
    const City = require("../models/City");
    const Membership = require("../models/Membership");
    const city =
      (await City.findOne({ name: "Слюдянка" })) ||
      (await City.create({ name: "Слюдянка", oktmo: "25" + Date.now() }));
    const people = {};
    for (const role of ["driver", "dispatcher", "region_admin"]) {
      const session = await registerUser(app);
      people[role] = session.user._id;
      await Membership.create({ userId: session.user._id, cityId: city._id, role, status: "ACTIVE" });
      await subscribe(session.user._id);
    }

    const result = await pushService.notifyNewOrder(
      { _id: "000000000000000000000001", cityId: city._id, from: { text: "Вокзал" }, to: { text: "Рынок" } },
      {}
    );

    expect(result.drivers.sent).toBe(1);
    expect(result.staff.sent).toBe(2);
    const webpush = require("web-push");
    const endpoints = webpush.sendNotification.mock.calls.map(([subscription]) => subscription.endpoint);
    for (const userId of Object.values(people)) {
      expect(endpoints).toContain(`https://push.example/${userId}`);
    }
  });
});

