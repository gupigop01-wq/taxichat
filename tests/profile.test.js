const request = require("supertest");
const app = require("../app");
const User = require("../models/User");
const DriverProfile = require("../models/DriverProfile");
const { connectTestDb, disconnectTestDb } = require("./db");
const { setupPilotCity } = require("./orderSetup");

// The personal card of a person is editable at any time: name, contact phone
// and the short "about" line. The login stays fixed.
describe("account card", () => {
  let world;

  beforeAll(async () => {
    await connectTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  beforeEach(async () => {
    world = await setupPilotCity(app);
  });

  it("lets a passenger change name, phone and about", async () => {
    const res = await request(app)
      .patch("/api/user/me")
      .set("Cookie", world.passenger.cookie)
      .send({ name: "Анна Новая", phone: "8 (902) 555-44-33", bio: "Люблю тихую музыку" });

    expect(res.status).toBe(200);
    expect(res.body.data.user.name).toBe("Анна Новая");
    expect(res.body.data.user.phone).toBe("+79025554433");
    expect(res.body.data.user.bio).toBe("Люблю тихую музыку");

    // The change is persisted, not only echoed
    const stored = await User.findById(world.passenger.user._id);
    expect(stored.name).toBe("Анна Новая");
    expect(stored.phone).toBe("+79025554433");
  });

  it("validates the phone and the about length", async () => {
    const badPhone = await request(app)
      .patch("/api/user/me")
      .set("Cookie", world.passenger.cookie)
      .send({ phone: "12345" });
    expect(badPhone.status).toBe(400);

    const longBio = await request(app)
      .patch("/api/user/me")
      .set("Cookie", world.passenger.cookie)
      .send({ bio: "х".repeat(101) });
    expect(longBio.status).toBe(400);
  });

  it("never changes the login or the role through the card", async () => {
    const res = await request(app)
      .patch("/api/user/me")
      .set("Cookie", world.passenger.cookie)
      .send({ username: "hacked", isSuperadmin: true, name: "Анна" });
    expect(res.status).toBe(200);
    const stored = await User.findById(world.passenger.user._id);
    expect(stored.username).toBe(world.passenger.user.username);
    expect(stored.isSuperadmin).toBe(false);
  });

  it("requires a session", async () => {
    const res = await request(app).patch("/api/user/me").send({ name: "X" });
    expect(res.status).toBe(401);
  });
});

describe("driver card", () => {
  let world;

  beforeAll(async () => {
    await connectTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  beforeEach(async () => {
    world = await setupPilotCity(app);
  });

  it("lets the driver update the name passengers see and the car", async () => {
    const driver = world.drivers[0];

    const res = await request(app)
      .patch("/api/drivers/me/profile")
      .set("Cookie", driver.cookie)
      .send({
        cityId: String(world.city._id),
        displayName: "Иван Обновлённый",
        about: "Стаж 12 лет",
        car: { color: "Красный", plate: "А777АА", brand: "Kia" },
      });

    expect(res.status).toBe(200);
    expect(res.body.data.profile.displayName).toBe("Иван Обновлённый");
    expect(res.body.data.profile.carCaption).toBe("Красный А777АА Kia");

    const stored = await DriverProfile.findOne({ phone: "+79000000010" });
    expect(stored.displayName).toBe("Иван Обновлённый");
    expect(stored.about).toBe("Стаж 12 лет");
    expect(stored.car.plate).toBe("А777АА");
  });

  it("returns the car caption after saving without changes", async () => {
    const driver = world.drivers[2];
    const res = await request(app)
      .patch("/api/drivers/me/profile")
      .set("Cookie", driver.cookie)
      .send({ cityId: String(world.city._id), about: "Всё по делу" });
    expect(res.status).toBe(200);
    // Color and plate were set by the application, so the caption is not empty
    expect(res.body.data.profile.carCaption).toMatch(/\d{6}/);
  });

  it("keeps one phone per driver and syncs it to the account", async () => {
    const driver = world.drivers[1];
    const res = await request(app)
      .patch("/api/drivers/me/profile")
      .set("Cookie", driver.cookie)
      .send({ cityId: String(world.city._id), phone: "+79009990011" });
    expect(res.status).toBe(200);

    const user = await User.findById(driver.user._id);
    expect(user.phone).toBe("+79009990011");

    // The same number cannot be taken by another driver
    const clash = await request(app)
      .patch("/api/drivers/me/profile")
      .set("Cookie", world.drivers[0].cookie)
      .send({ cityId: String(world.city._id), phone: "+79009990011" });
    expect(clash.status).toBe(409);
  });

  it("rejects a non-driver", async () => {
    const res = await request(app)
      .patch("/api/drivers/me/profile")
      .set("Cookie", world.passenger.cookie)
      .send({ cityId: String(world.city._id), displayName: "X" });
    expect([403, 404]).toContain(res.status);
  });
});

describe("leaving a role", () => {
  let world;

  beforeAll(async () => {
    await connectTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  beforeEach(async () => {
    world = await setupPilotCity(app);
  });

  it("removes an inactive passenger role", async () => {
    const memberships = await request(app)
      .get("/api/memberships/mine")
      .set("Cookie", world.passenger.cookie);
    const passengerRole = memberships.body.data.memberships.find(
      (item) => item.role === "passenger"
    );

    const res = await request(app)
      .post(`/api/memberships/${passengerRole._id}`)
      .set("Cookie", world.passenger.cookie)
      .send({ leave: true });
    expect(res.status).toBe(200);

    const after = await request(app)
      .get("/api/memberships/mine")
      .set("Cookie", world.passenger.cookie);
    expect(
      after.body.data.memberships.some((item) => String(item._id) === String(passengerRole._id))
    ).toBe(false);
  });

  it("refuses to leave a driver role with a live ride", async () => {
    const { createOrder } = require("./orderSetup");
    const driver = world.drivers[0];
    const created = await createOrder(app, world.passenger, world.city, { matchMode: "first_take" });
    await request(app)
      .post(`/api/orders/${created.body.data.order._id}/accept`)
      .set("Cookie", driver.cookie)
      .send({});

    const memberships = await request(app)
      .get("/api/memberships/mine")
      .set("Cookie", driver.cookie);
    const driverRole = memberships.body.data.memberships.find((item) => item.role === "driver");

    const res = await request(app)
      .post(`/api/memberships/${driverRole._id}`)
      .set("Cookie", driver.cookie)
      .send({ leave: true });
    expect(res.status).toBe(409);
  });
});

describe("one role per city", () => {
  let world;

  beforeAll(async () => {
    await connectTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  beforeEach(async () => {
    world = await setupPilotCity(app);
  });

  const mine = async (cookie) => {
    const res = await request(app).get("/api/memberships/mine").set("Cookie", cookie);
    return res.body.data.memberships;
  };

  it("replaces the passenger role when the person applies as a driver", async () => {
    const person = world.passenger;
    const before = await mine(person.cookie);
    expect(before.map((item) => item.role)).toEqual(["passenger"]);

    const applied = await request(app)
      .post("/api/memberships")
      .set("Cookie", person.cookie)
      .send({
        cityId: String(world.city._id),
        role: "driver",
        displayName: "Анна За рулём",
        phone: "+79007770011",
        car: { color: "Синий", plate: "А001АА" },
      });
    expect(applied.status).toBe(201);

    const after = await mine(person.cookie);
    // The passenger role is gone: the person is a driver-in-review, not both
    expect(after.map((item) => item.role).sort()).toEqual(["driver"]);
  });

  it("approving a dispatcher application removes the passenger role", async () => {
    const person = world.passenger;
    const applied = await request(app)
      .post("/api/applications")
      .set("Cookie", person.cookie)
      .send({ cityId: String(world.city._id), type: "dispatcher" });
    expect(applied.status).toBe(201);

    const approved = await request(app)
      .patch(`/api/admin/applications/${applied.body.data.application._id}`)
      .set("Cookie", world.superadmin.cookie)
      .send({ decision: "approve" });
    expect(approved.status).toBe(200);

    const after = await mine(person.cookie);
    expect(after.map((item) => item.role)).toEqual(["dispatcher"]);
    expect(after[0].status).toBe("ACTIVE");
  });

  it("approving a driver application removes the passenger role too", async () => {
    const person = world.passenger;
    const applied = await request(app)
      .post("/api/memberships")
      .set("Cookie", person.cookie)
      .send({
        cityId: String(world.city._id),
        role: "driver",
        displayName: "Анна За рулём",
        phone: "+79007770022",
        car: { color: "Синий", plate: "А002АА" },
      });
    await request(app)
      .patch(`/api/dispatch/drivers/${applied.body.data.membership._id}`)
      .set("Cookie", world.superadmin.cookie)
      .send({ decision: "approve" });

    const after = await mine(person.cookie);
    expect(after.map((item) => item.role)).toEqual(["driver"]);
  });

  it("keeps a driver with a live ride from switching to passenger", async () => {
    const { createOrder } = require("./orderSetup");
    const driver = world.drivers[0];
    const created = await createOrder(app, world.passenger, world.city, { matchMode: "first_take" });
    await request(app)
      .post(`/api/orders/${created.body.data.order._id}/accept`)
      .set("Cookie", driver.cookie)
      .send({});

    const res = await request(app)
      .post("/api/memberships")
      .set("Cookie", driver.cookie)
      .send({ cityId: String(world.city._id), role: "passenger" });
    expect(res.status).toBe(409);
  });
});
