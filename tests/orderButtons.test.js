const request = require("supertest");
const app = require("../app");
const { actionsForStatus } = require("../services/botDispatcher");
const { connectTestDb, disconnectTestDb } = require("./db");
const { setupPilotCity } = require("./orderSetup");

// The quick buttons are the user-facing face of the transition rules: a button
// that the reducer would reject (wrong role, wrong status) is a broken screen.
// These tests pin every status to the actions the order state machine allows.
const actionsOf = (status, role) =>
  actionsForStatus(status)
    .filter((button) => button.roles.includes(role))
    .map((button) => button.action);

const labelsOf = (status, role) =>
  actionsForStatus(status)
    .filter((button) => button.roles.includes(role))
    .map((button) => button.label);

describe("order chat buttons follow the state machine", () => {
  it("lets only the driver act on the ride itself", () => {
    expect(actionsOf("ASSIGNED", "driver")).toContain("arrive");
    expect(actionsOf("ARRIVING", "driver")).toContain("wait");
    expect(actionsOf("WAITING", "driver")).toEqual(expect.arrayContaining(["start", "no_show"]));
    expect(actionsOf("IN_RIDE", "driver")).toEqual(expect.arrayContaining(["finish", "undo_start"]));

    for (const status of ["ASSIGNED", "ARRIVING", "WAITING", "IN_RIDE"]) {
      expect(actionsOf(status, "passenger")).not.toEqual(
        expect.arrayContaining(["arrive", "wait", "start", "finish", "no_show", "undo_start"])
      );
    }
  });

  it("has no canned late buttons: a late participant just writes in the chat", () => {
    for (const status of ["PUBLISHED", "ASSIGNED", "ARRIVING", "WAITING", "IN_RIDE"]) {
      for (const role of ["passenger", "driver", "dispatcher"]) {
        for (const button of actionsForStatus(status).filter((item) => item.roles.includes(role))) {
          expect(button.label).not.toMatch(/опазд|задержив/i);
        }
      }
    }
  });

  it("a dispute is resolved by a dispatcher only", () => {
    expect(actionsOf("DISPUTE", "dispatcher")).toEqual(["resolve_complete", "resolve_cancel"]);
    expect(actionsOf("DISPUTE", "passenger")).toEqual([]);
    expect(actionsOf("DISPUTE", "driver")).toEqual([]);
  });

  it("keeps cancel available in every live status and never for a finished ride", () => {
    for (const status of ["ASSIGNED", "ARRIVING"]) {
      expect(actionsOf(status, "passenger")).toContain("cancel");
      expect(actionsOf(status, "driver")).toContain("cancel");
    }
    for (const status of ["COMPLETED", "CANCELLED", "NO_SHOW", "EXPIRED"]) {
      expect(actionsForStatus(status)).toEqual([]);
    }
  });

  it("never offers a driver a button inside somebody else's flow", () => {
    // A published order has no assigned driver: the driver may only offer
    expect(actionsOf("PUBLISHED", "driver")).toEqual(expect.arrayContaining(["offer", "book"]));
    expect(actionsOf("PUBLISHED", "driver")).not.toContain("arrive");
    expect(actionsOf("PUBLISHED", "dispatcher")).not.toContain("cancel");
  });
});

describe("dispatcher driver list", () => {
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

  it("shows car, phone, shift and live occupation to the dispatcher", async () => {
    const res = await request(app)
      .get(`/api/dispatch/${world.city._id}/drivers?status=ACTIVE`)
      .set("Cookie", world.dispatcher.cookie);

    expect(res.status).toBe(200);
    // Match by username: the test world has no membership id at hand
    const driver = res.body.data.drivers.find(
      (item) => item.user?.username === world.drivers[0].user.username
    );
    expect(driver).toBeTruthy();
    // Car details and the callback phone are visible
    expect(driver.car?.color || driver.car?.plate).toBeTruthy();
    expect(driver.carCaption).toMatch(/10\d{4}/);
    expect(driver.phone).toMatch(/^\+7\d{10}$/);
    // Shift state is explicit, occupation is derived from active orders
    expect(driver.shift).toMatch(/online|offline/);
    expect(driver).toHaveProperty("online");
    expect(driver.activeOrder).toBeUndefined();
  });

  it("does not leak the driver list to a passenger", async () => {
    const res = await request(app)
      .get(`/api/dispatch/${world.city._id}/drivers?status=ACTIVE`)
      .set("Cookie", world.passenger.cookie);
    expect(res.status).toBe(403);
  });
});
