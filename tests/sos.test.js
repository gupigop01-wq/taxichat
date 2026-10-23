const request = require("supertest");
const app = require("../app");
const Complaint = require("../models/Complaint");
const User = require("../models/User");
const { connectTestDb, disconnectTestDb } = require("./db");
const { setupPilotCity, createOrder } = require("./orderSetup");

beforeAll(async () => {
  await connectTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

const raiseSos = async (world, orderId) =>
  request(app)
    .post(`/api/orders/${orderId}/sos`)
    .set("Cookie", world.passenger.cookie)
    .send({});

describe("SOS center of the city dispatcher", () => {
  let world;
  let order;

  beforeEach(async () => {
    world = await setupPilotCity(app);
    const created = await createOrder(app, world.passenger, world.city, { matchMode: "first_take" });
    order = created.body.data.order;
  });

  it("shows the signal to the dispatcher with the caller's phone", async () => {
    await User.findByIdAndUpdate(world.passenger.user._id, { phone: "+79021112233" });
    const raised = await raiseSos(world, order._id);
    expect(raised.status).toBe(201);

    const list = await request(app)
      .get(`/api/dispatch/${world.city._id}/sos`)
      .set("Cookie", world.dispatcher.cookie);
    expect(list.status).toBe(200);
    const [signal] = list.body.data.signals;
    expect(signal.status).toBe("OPEN");
    expect(String(signal.orderId)).toBe(String(order._id));
    expect(signal.phone).toBe("+79021112233");
    expect(signal.reporter.name).toBe(world.passenger.user.name);
  });

  it("does not show the sos of another city", async () => {
    await raiseSos(world, order._id);
    const foreign = await request(app)
      .get(`/api/dispatch/${new (require("mongoose").Types.ObjectId)()}/sos`)
      .set("Cookie", world.dispatcher.cookie);
    expect(foreign.status).toBe(403);
  });

  it("hides signals from a passenger and from a driver", async () => {
    await raiseSos(world, order._id);
    for (const actor of [world.passenger, world.drivers[0]]) {
      const res = await request(app)
        .get(`/api/dispatch/${world.city._id}/sos`)
        .set("Cookie", actor.cookie);
      expect(res.status).toBe(403);
    }
  });

  it("takes the signal once and closes it with a note", async () => {
    const raised = await raiseSos(world, order._id);
    const complaintId = raised.body.data.complaint._id;

    const taken = await request(app)
      .post(`/api/dispatch/sos/${complaintId}/take`)
      .set("Cookie", world.dispatcher.cookie);
    expect(taken.status).toBe(200);
    expect(taken.body.data.signal.status).toBe("IN_REVIEW");
    expect(taken.body.data.signal.takenBy.name).toBe(world.dispatcher.user.name);

    // Second dispatcher must not steal the handler
    const admin = await request(app)
      .post(`/api/dispatch/sos/${complaintId}/take`)
      .set("Cookie", world.superadmin.cookie);
    expect(admin.status).toBe(200);
    expect(String(admin.body.data.signal.takenBy._id)).toBe(String(world.dispatcher.user._id));

    const missingNote = await request(app)
      .patch(`/api/dispatch/sos/${complaintId}`)
      .set("Cookie", world.dispatcher.cookie)
      .send({ outcome: "resolved", resolution: "" });
    expect(missingNote.status).toBe(400);

    const closed = await request(app)
      .patch(`/api/dispatch/sos/${complaintId}`)
      .set("Cookie", world.dispatcher.cookie)
      .send({ outcome: "resolved", resolution: "Связались, всё в порядке" });
    expect(closed.status).toBe(200);
    expect(closed.body.data.signal.status).toBe("RESOLVED");

    const stored = await Complaint.findById(complaintId);
    expect(stored.resolution).toBe("Связались, всё в порядке");
    expect(stored.resolvedBy).toBeTruthy();

    // Closed signals leave the dispatcher's working list
    const list = await request(app)
      .get(`/api/dispatch/${world.city._id}/sos`)
      .set("Cookie", world.dispatcher.cookie);
    expect(list.body.data.signals).toHaveLength(0);

    // Closing twice is refused
    const again = await request(app)
      .patch(`/api/dispatch/sos/${complaintId}`)
      .set("Cookie", world.dispatcher.cookie)
      .send({ outcome: "dismissed", resolution: "Повторно" });
    expect(again.status).toBe(409);
  });

  it("records the caller's phone on the SOS when the account has one", async () => {
    await User.findByIdAndUpdate(world.passenger.user._id, { phone: "+79025556677" });
    await raiseSos(world, order._id);
    const complaint = await Complaint.findOne({ orderId: order._id, type: "sos" });
    expect(complaint.phone).toBe("+79025556677");
  });
});

describe("passenger phone", () => {
  it("is saved to the account when an order carries it", async () => {
    const world = await setupPilotCity(app);
    const created = await request(app)
      .post("/api/orders")
      .set("Cookie", world.passenger.cookie)
      .send({ cityId: world.city._id, route: "Вокзал → Рынок", phone: "8 (902) 111-22-33" });
    expect(created.status).toBe(201);
    const stored = await User.findById(world.passenger.user._id);
    expect(stored.phone).toBe("+79021112233");
  });

  it("rejects a malformed number", async () => {
    const world = await setupPilotCity(app);
    const created = await request(app)
      .post("/api/orders")
      .set("Cookie", world.passenger.cookie)
      .send({ cityId: world.city._id, route: "Вокзал → Рынок", phone: "12345" });
    expect(created.status).toBe(400);
  });
});

describe("contact phones in the order view", () => {
  it("gives both phones to the dispatcher and keeps the passenger phone from the driver", async () => {
    const world = await setupPilotCity(app);
    await User.findByIdAndUpdate(world.passenger.user._id, { phone: "+79021112233" });
    const created = await createOrder(app, world.passenger, world.city, { matchMode: "first_take" });
    const orderId = created.body.data.order._id;
    await request(app)
      .post(`/api/orders/${orderId}/accept`)
      .set("Cookie", world.drivers[0].cookie)
      .send({});

    const forDispatcher = await request(app)
      .get(`/api/orders/${orderId}`)
      .set("Cookie", world.dispatcher.cookie);
    expect(forDispatcher.status).toBe(200);
    expect(forDispatcher.body.data.order.passenger.phone).toBe("+79021112233");
    expect(forDispatcher.body.data.order.driver.phone).toBeTruthy();

    const forDriver = await request(app)
      .get(`/api/orders/${orderId}`)
      .set("Cookie", world.drivers[0].cookie);
    expect(forDriver.status).toBe(200);
    expect(forDriver.body.data.order.passenger.phone).toBeUndefined();

    const forPassenger = await request(app)
      .get(`/api/orders/${orderId}`)
      .set("Cookie", world.passenger.cookie);
    expect(forPassenger.body.data.order.passenger?.phone).toBeUndefined();
  });
});

describe("city dispatch line", () => {
  it("lets the city dispatcher set the public number and shows it to everyone", async () => {
    const world = await setupPilotCity(app);
    const saved = await request(app)
      .patch(`/api/dispatch/${world.city._id}/dispatch-phone`)
      .set("Cookie", world.dispatcher.cookie)
      .send({ phone: "8 (902) 555-66-77", note: "Круглосуточно" });
    expect(saved.status).toBe(200);
    expect(saved.body.data.settings.dispatchPhone).toBe("+79025556677");
    expect(saved.body.data.settings.dispatchPhoneNote).toBe("Круглосуточно");

    const cities = await request(app).get("/api/geo/cities?query=Слюдянка");
    const city = cities.body.data.cities.find((item) => String(item._id) === String(world.city._id));
    expect(city.dispatchPhone).toBe("+79025556677");
    expect(city.dispatchPhoneNote).toBe("Круглосуточно");
  });

  it("rejects a malformed number and outsiders", async () => {
    const world = await setupPilotCity(app);
    const bad = await request(app)
      .patch(`/api/dispatch/${world.city._id}/dispatch-phone`)
      .set("Cookie", world.dispatcher.cookie)
      .send({ phone: "123" });
    expect(bad.status).toBe(400);

    const outsider = await request(app)
      .patch(`/api/dispatch/${world.city._id}/dispatch-phone`)
      .set("Cookie", world.passenger.cookie)
      .send({ phone: "+79025556677" });
    expect(outsider.status).toBe(403);
  });
});
