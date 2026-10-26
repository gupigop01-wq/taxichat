const request = require("supertest");
const app = require("../app");
const Order = require("../models/Order");
const Rating = require("../models/Rating");
const Complaint = require("../models/Complaint");
const User = require("../models/User");
const City = require("../models/City");
const Membership = require("../models/Membership");
const mongoose = require("mongoose");
const { connectTestDb, disconnectTestDb } = require("./db");
const { setupPilotCity, createOrder } = require("./orderSetup");
const { registerUser } = require("./helpers");

beforeAll(async () => {
  await connectTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

const completeOrder = async (order, driverCookie) => {
  const orderId = order._id;
  for (const action of ["arrive", "wait", "start", "finish"]) {
    await request(app)
      .post(`/api/orders/${orderId}/action`)
      .set("Cookie", driverCookie)
      .send({ action });
  }
};

describe("Ratings", () => {
  let world;
  let order;

  beforeEach(async () => {
    world = await setupPilotCity(app);
    const created = await createOrder(app, world.passenger, world.city, {
      matchMode: "first_take",
    });
    order = created.body.data.order;
    await request(app)
      .post(`/api/orders/${order._id}/accept`)
      .set("Cookie", world.drivers[0].cookie)
      .send({});
    await completeOrder(order, world.drivers[0].cookie);
  });

  it("passenger rates the driver after completion; rating is cached on the profile", async () => {
    const res = await request(app)
      .post(`/api/orders/${order._id}/rating`)
      .set("Cookie", world.passenger.cookie)
      .send({ stars: 5, comment: "Отличная поездка" });
    expect(res.status).toBe(201);

    const driverRating = await request(app)
      .get(`/api/drivers/${world.drivers[0].user._id}/rating`)
      .set("Cookie", world.passenger.cookie);
    expect(driverRating.body.data.rating).toBe(5);
    expect(driverRating.body.data.count).toBe(1);

    // Free-drivers list shows the cached rating
    const list = await request(app)
      .get(`/api/cities/${world.city._id}/free-drivers`)
      .set("Cookie", world.passenger.cookie);
    const entry = list.body.data.drivers.find(
      (driver) => String(driver.driverId) === String(world.drivers[0].user._id)
    );
    if (entry) {
      expect(entry.rating).toBe(5);
    }
  });

  it("double rating is rejected", async () => {
    await request(app)
      .post(`/api/orders/${order._id}/rating`)
      .set("Cookie", world.passenger.cookie)
      .send({ stars: 4 });

    const second = await request(app)
      .post(`/api/orders/${order._id}/rating`)
      .set("Cookie", world.passenger.cookie)
      .send({ stars: 4 });
    expect(second.status).toBe(409);
  });

  it("an outsider cannot rate and stars are validated", async () => {
    const outsider = await registerUser(app);
    const res = await request(app)
      .post(`/api/orders/${order._id}/rating`)
      .set("Cookie", outsider.cookie)
      .send({ stars: 5 });
    expect(res.status).toBe(403);

    const badStars = await request(app)
      .post(`/api/orders/${order._id}/rating`)
      .set("Cookie", world.passenger.cookie)
      .send({ stars: 9 });
    expect(badStars.status).toBe(400);
  });

  it("uncompleted orders cannot be rated", async () => {
    const created = await createOrder(app, world.passenger, world.city);
    const res = await request(app)
      .post(`/api/orders/${created.body.data.order._id}/rating`)
      .set("Cookie", world.passenger.cookie)
      .send({ stars: 5 });
    expect(res.status).toBe(409);
  });
});

describe("Complaints and SOS", () => {
  let world;
  let order;

  beforeEach(async () => {
    world = await setupPilotCity(app);
    const created = await createOrder(app, world.passenger, world.city, {
      matchMode: "first_take",
    });
    order = created.body.data.order;
    await request(app)
      .post(`/api/orders/${order._id}/accept`)
      .set("Cookie", world.drivers[0].cookie)
      .send({});
  });

  it("SOS notifies dispatchers and is visible to the region admin", async () => {
    const res = await request(app)
      .post(`/api/orders/${order._id}/sos`)
      .set("Cookie", world.passenger.cookie)
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.data.complaint.type).toBe("sos");

    const listed = await request(app)
      .get("/api/admin/complaints?type=sos")
      .set("Cookie", world.superadmin.cookie);
    expect(listed.status).toBe(200);
    expect(listed.body.data.complaints).toHaveLength(1);
  });

  it("SOS is rejected for outsiders", async () => {
    const outsider = await registerUser(app);
    const res = await request(app)
      .post(`/api/orders/${order._id}/sos`)
      .set("Cookie", outsider.cookie)
      .send({});
    expect(res.status).toBe(403);
  });

  it("a complaint is created and can be resolved by an admin", async () => {
    const created = await request(app)
      .post("/api/complaints")
      .set("Cookie", world.passenger.cookie)
      .send({
        orderId: order._id,
        targetUserId: String(world.drivers[0].user._id),
        type: "behavior",
        text: "Водитель был груб",
      });
    expect(created.status).toBe(201);

    const resolved = await request(app)
      .patch(`/api/admin/complaints/${created.body.data.complaint._id}`)
      .set("Cookie", world.superadmin.cookie)
      .send({ status: "RESOLVED", resolution: "Проведена беседа" });
    expect(resolved.status).toBe(200);
    expect(resolved.body.data.complaint.status).toBe("RESOLVED");
  });

  it("a referenced order must belong to the reporter before its city is returned", async () => {
    const outsider = await registerUser(app);
    for (const orderId of [order._id, String(new mongoose.Types.ObjectId())]) {
      const denied = await request(app)
        .post("/api/complaints")
        .set("Cookie", outsider.cookie)
        .send({ orderId, type: "other", text: "Private order probe" });
      expect(denied.status).toBe(404);
      expect(denied.body.message).toBe("Заказ не найден");
      expect(denied.body.data).toBeUndefined();
    }
    expect(await Complaint.countDocuments()).toBe(0);

    const driverComplaint = await request(app)
      .post("/api/complaints")
      .set("Cookie", world.drivers[0].cookie)
      .send({ orderId: order._id, type: "behavior", text: "Participant complaint" });
    expect(driverComplaint.status).toBe(201);
    expect(driverComplaint.body.data.complaint.cityId).toBe(String(world.city._id));
  });

  it("an invalid referenced order id is rejected before saving a complaint", async () => {
    const res = await request(app)
      .post("/api/complaints")
      .set("Cookie", world.passenger.cookie)
      .send({ orderId: "not-an-id", type: "other", text: "Invalid order" });
    expect(res.status).toBe(400);
    expect(await Complaint.countDocuments()).toBe(0);
  });

  it("uses the single valid active membership city when the home city is missing", async () => {
    const otherCity = await City.findOne({ _id: { $ne: world.city._id } });
    await Membership.create([
      { userId: world.passenger.user._id, cityId: world.city._id, role: "driver", status: "ACTIVE" },
      { userId: world.passenger.user._id, cityId: otherCity._id, role: "passenger", status: "PENDING" },
      { userId: world.passenger.user._id, cityId: new mongoose.Types.ObjectId(), role: "passenger", status: "ACTIVE" },
    ]);
    const created = await request(app)
      .post("/api/complaints")
      .set("Cookie", world.passenger.cookie)
      .send({ type: "other", text: "No home city" });
    expect(created.status).toBe(201);
    expect(created.body.data.complaint.cityId).toBe(String(world.city._id));
  });

  it("rejects an ambiguous city or a reporter without any active membership", async () => {
    const otherCity = await City.findOne({ _id: { $ne: world.city._id } });
    await Membership.create({
      userId: world.passenger.user._id,
      cityId: otherCity._id,
      role: "passenger",
      status: "ACTIVE",
    });
    const waiting = await registerUser(app);
    await Membership.create({
      userId: waiting.user._id,
      cityId: world.city._id,
      role: "driver",
      status: "PENDING",
    });
    for (const reporter of [world.passenger, waiting]) {
      const rejected = await request(app)
        .post("/api/complaints")
        .set("Cookie", reporter.cookie)
        .send({ type: "other", text: "Unrouteable complaint" });
      expect(rejected.status).toBe(400);
    }
    expect(await Complaint.countDocuments()).toBe(0);
  });

  it("lists legacy local complaints read-only and backfills only an authorized review", async () => {
    const admin = await registerUser(app);
    await Membership.create({ userId: admin.user._id, cityId: world.city._id, role: "region_admin", status: "ACTIVE" });
    const otherCity = await City.create({
      name: "Foreign complaint city",
      oktmo: "99" + Date.now(),
      regionId: new mongoose.Types.ObjectId(),
    });
    const foreignOrder = await Order.create({ passengerId: world.passenger.user._id, cityId: otherCity._id });
    await User.updateOne({ _id: world.passenger.user._id }, { $set: { homeCityId: world.city._id } });
    const local = await Complaint.create({ reporterId: world.passenger.user._id, orderId: order._id, type: "sos", text: "Legacy local order" });
    const foreign = await Complaint.create({ reporterId: world.passenger.user._id, orderId: foreignOrder._id, type: "sos", text: "Legacy foreign order" });
    const home = await Complaint.create({ reporterId: world.passenger.user._id, cityId: null, type: "other", text: "Legacy home city" });
    const membership = await Complaint.create({ reporterId: world.drivers[1].user._id, type: "other", text: "Legacy membership city" });
    const orphan = await Complaint.create({ reporterId: new mongoose.Types.ObjectId(), type: "other", text: "Deleted reporter" });
    await Membership.create({ userId: world.drivers[2].user._id, cityId: otherCity._id, role: "passenger", status: "ACTIVE" });
    const ambiguous = await Complaint.create({ reporterId: world.drivers[2].user._id, type: "other", text: "Ambiguous legacy city" });
    const before = await Complaint.find().lean();

    const listed = await request(app).get("/api/admin/complaints").set("Cookie", admin.cookie);
    expect(listed.status).toBe(200);
    const ids = listed.body.data.complaints.map((item) => item._id);
    expect(ids).toEqual(expect.arrayContaining([local, home, membership].map((item) => String(item._id))));
    expect(ids).not.toContain(String(foreign._id));
    expect(ids).not.toContain(String(orphan._id));
    expect(ids).not.toContain(String(ambiguous._id));
    expect(listed.body.data.complaints.every((item) => item.cityId === String(world.city._id))).toBe(true);
    expect(await Complaint.find().lean()).toEqual(before);

    const denied = await request(app)
      .patch(`/api/admin/complaints/${foreign._id}`)
      .set("Cookie", admin.cookie)
      .send({ status: "DISMISSED" });
    expect(denied.status).toBe(404);
    expect(await Complaint.find().lean()).toEqual(before);

    const all = await request(app).get("/api/admin/complaints").set("Cookie", world.superadmin.cookie);
    expect(all.body.data.complaints.find((item) => item._id === String(foreign._id)).cityId).toBe(String(otherCity._id));
    expect(all.body.data.complaints.map((item) => item._id)).toContain(String(ambiguous._id));
    expect(await Complaint.find().lean()).toEqual(before);

    const reviewed = await request(app)
      .patch(`/api/admin/complaints/${local._id}`)
      .set("Cookie", admin.cookie)
      .send({ status: "RESOLVED", resolution: "Legacy complaint reviewed" });
    expect(reviewed.status).toBe(200);
    expect(reviewed.body.data.complaint.cityId).toBe(String(world.city._id));
    expect((await Complaint.findById(local._id)).cityId.toString()).toBe(String(world.city._id));
    expect((await Complaint.findById(foreign._id)).cityId).toBeUndefined();
    expect((await Complaint.findById(home._id)).cityId).toBeNull();
    expect((await Complaint.findById(membership._id)).cityId).toBeUndefined();
  });

  it("scopes legacy complaints before applying the 200-row list limit", async () => {
    const admin = await registerUser(app);
    await Membership.create({ userId: admin.user._id, cityId: world.city._id, role: "region_admin", status: "ACTIVE" });
    const otherCity = await City.create({
      name: "Foreign complaint city",
      oktmo: "99" + Date.now(),
      regionId: new mongoose.Types.ObjectId(),
    });
    const foreignOrder = await Order.create({ passengerId: world.passenger.user._id, cityId: otherCity._id });
    const local = await Complaint.create({
      reporterId: world.passenger.user._id,
      orderId: order._id,
      type: "other",
      text: "Old local complaint",
      createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });
    await Complaint.insertMany(Array.from({ length: 201 }, () => ({
      reporterId: world.passenger.user._id,
      orderId: foreignOrder._id,
      type: "other",
      text: "Newer foreign complaint",
    })));
    const listed = await request(app).get("/api/admin/complaints?type=other&status=OPEN").set("Cookie", admin.cookie);
    expect(listed.status).toBe(200);
    expect(listed.body.data.complaints.map((item) => item._id)).toEqual([String(local._id)]);
    expect(await Complaint.countDocuments({ cityId: { $exists: true } })).toBe(0);
  });
});

describe("Bans and share links", () => {
  let world;

  beforeEach(async () => {
    world = await setupPilotCity(app);
  });

  it("late cancel adds a penalty point and the threshold auto-bans", async () => {
    const created = await createOrder(app, world.passenger, world.city, {
      matchMode: "first_take",
    });
    const orderId = created.body.data.order._id;
    await request(app)
      .post(`/api/orders/${orderId}/accept`)
      .set("Cookie", world.drivers[0].cookie)
      .send({});

    const cancelled = await request(app)
      .post(`/api/orders/${orderId}/cancel`)
      .set("Cookie", world.passenger.cookie)
      .send({ reason: "Передумал" });
    expect(cancelled.status).toBe(200);

    const meRes = await request(app).get("/api/user/me").set("Cookie", world.passenger.cookie);
    expect(meRes.body.data.user.penaltyPoints).toBe(1);
    expect(meRes.body.data.user.banned).toBe(false);

    // Cancel before assignment does not add points
    const early = await createOrder(app, world.passenger, world.city);
    await request(app)
      .post(`/api/orders/${early.body.data.order._id}/cancel`)
      .set("Cookie", world.passenger.cookie)
      .send({ reason: "Ошибка" });
    const meAfterEarly = await request(app)
      .get("/api/user/me")
      .set("Cookie", world.passenger.cookie);
    expect(meAfterEarly.body.data.user.penaltyPoints).toBe(1);
  });

  it("superadmin can ban a user; banned users cannot log in or use the API", async () => {
    const victim = await registerUser(app);

    const banned = await request(app)
      .patch(`/api/admin/users/${victim.user._id}/ban`)
      .set("Cookie", world.superadmin.cookie)
      .send({ reason: "Мошенничество" });
    expect(banned.status).toBe(200);
    expect(banned.body.data.user.banned).toBe(true);

    const login = await request(app)
      .post("/api/user/login")
      .send({ username: victim.user.username, password: "Bombila2026" });
    expect(login.status).toBe(403);
    expect(login.body.message).toContain("заблокирован");

    const apiAccess = await request(app)
      .get("/api/user/me")
      .set("Cookie", victim.cookie);
    // /api/user/me защищён route-level protect
    expect(apiAccess.status).toBe(403);

    // Unban restores access
    await request(app)
      .patch(`/api/admin/users/${victim.user._id}/ban`)
      .set("Cookie", world.superadmin.cookie)
      .send({ banned: false });
    const restored = await request(app)
      .get("/api/user/me")
      .set("Cookie", victim.cookie);
    expect(restored.status).toBe(200);
  });

  it("the innocent side of a cancel is not penalised", async () => {
    const User = require("../models/User");
    const Order = require("../models/Order");

    // The driver waited for the whole no-show window and the passenger never
    // showed up: only the passenger is at fault
    const noShowOrder = async () => {
      const created = await createOrder(app, world.passenger, world.city, { matchMode: "first_take" });
      const orderId = created.body.data.order._id;
      await request(app).post(`/api/orders/${orderId}/accept`).set("Cookie", world.drivers[0].cookie).send({});
      for (const action of ["arrive", "wait"]) {
        await request(app).post(`/api/orders/${orderId}/action`).set("Cookie", world.drivers[0].cookie).send({ action });
      }
      return orderId;
    };

    const waitedLongEnough = async (orderId) => {
      // Move the waiting snapshot and log entry past the city free window
      const order = await Order.findById(orderId);
      const at = new Date(Date.now() - 11 * 60 * 1000);
      const entry = order.statusLog.find((item) => item.status === "WAITING");
      entry.at = at;
      order.markModified("statusLog");
      if (order.waiting?.startedAt) order.waiting.startedAt = at;
      await order.save();
    };

    // Driver cancels right after marking "waiting": he is still at fault
    const early = await noShowOrder();
    const earlyCancel = await request(app)
      .post(`/api/orders/${early}/cancel`)
      .set("Cookie", world.drivers[0].cookie)
      .send({ reason: "Не хочу ждать" });
    expect(earlyCancel.status).toBe(200);
    const rushyDriver = await User.findById(world.drivers[0].user._id);
    expect(rushyDriver.penaltyPoints).toBe(1);

    // Waiting window expired: the driver leaves without a penalty
    await User.findByIdAndUpdate(world.drivers[0].user._id, { penaltyPoints: 0, penaltyAt: undefined });
    const orderId = await noShowOrder();
    await waitedLongEnough(orderId);
    const cancelled = await request(app)
      .post(`/api/orders/${orderId}/cancel`)
      .set("Cookie", world.drivers[0].cookie)
      .send({ reason: "Пассажир не вышел" });
    expect(cancelled.status).toBe(200);

    const driver = await User.findById(world.drivers[0].user._id);
    expect(driver.penaltyPoints).toBe(0);

    // The passenger cancelling while the driver is already waiting is at fault
    const waitingOrder = await noShowOrder();
    await request(app)
      .post(`/api/orders/${waitingOrder}/cancel`)
      .set("Cookie", world.passenger.cookie)
      .send({ reason: "Передумал" });
    const passenger = await User.findById(world.passenger.user._id);
    expect(passenger.penaltyPoints).toBe(1);
  });

  it("penalty points fade after full days without new penalties", async () => {
    const User = require("../models/User");
    const user = await User.findById(world.passenger.user._id);
    user.penaltyPoints = 6;
    user.penaltyAt = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
    await user.save();

    const created = await createOrder(app, world.passenger, world.city, { matchMode: "first_take" });
    const orderId = created.body.data.order._id;
    await request(app).post(`/api/orders/${orderId}/accept`).set("Cookie", world.drivers[0].cookie).send({});
    await request(app)
      .post(`/api/orders/${orderId}/cancel`)
      .set("Cookie", world.passenger.cookie)
      .send({ reason: "Передумал" });

    // 6 points - 4 quiet days + 1 new point
    const after = await User.findById(world.passenger.user._id);
    expect(after.penaltyPoints).toBe(3);
    expect(after.banned).toBe(false);
  });

  it("an automatic ban is temporary and lifts itself after its term", async () => {
    const User = require("../models/User");
    const user = await User.findById(world.passenger.user._id);
    user.penaltyPoints = 9;
    user.banned = true;
    user.banUntil = new Date(Date.now() - 60 * 1000);
    user.banReason = "Автобан за повторные отмены после назначения";
    await user.save();

    const login = await request(app)
      .post("/api/user/login")
      .send({ username: user.username, password: "Bombila2026" });
    expect(login.status).toBe(200);

    const after = await User.findById(user._id);
    expect(after.banned).toBe(false);
    expect(after.penaltyPoints).toBe(0);
    expect(after.banUntil).toBeUndefined();
  });

  it("share link exposes only route, status and car caption", async () => {
    const created = await createOrder(app, world.passenger, world.city, {
      matchMode: "first_take",
    });
    const orderId = created.body.data.order._id;
    await request(app)
      .post(`/api/orders/${orderId}/accept`)
      .set("Cookie", world.drivers[0].cookie)
      .send({});

    const link = await request(app)
      .get(`/api/orders/${orderId}/share`)
      .set("Cookie", world.passenger.cookie);
    expect(link.status).toBe(200);
    const token = link.body.data.url.split("/").pop();

    const publicView = await request(app).get(`/api/share/${token}`);
    expect(publicView.status).toBe(200);
    expect(publicView.body.data.status).toBe("ASSIGNED");
    expect(publicView.body.data.from).toBe("От ЖД вокзала до Центра");
    expect(publicView.body.data.driver.carCaption).toBeTruthy();
    // No phone numbers or exact addresses are exposed
    expect(publicView.body.data.driver.phone).toBeUndefined();
    expect(publicView.body.data.exactFrom).toBeUndefined();
  });

  it("share link is participant-only and unknown tokens 404", async () => {
    const created = await createOrder(app, world.passenger, world.city);
    const outsider = await registerUser(app);
    const link = await request(app)
      .get(`/api/orders/${created.body.data.order._id}/share`)
      .set("Cookie", outsider.cookie);
    expect(link.status).toBe(403);

    const missing = await request(app).get("/api/share/nonexistent-token");
    expect(missing.status).toBe(404);
  });
});

