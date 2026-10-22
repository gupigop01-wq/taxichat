const Agenda = require("agenda");
const handlers = require("./handlers");

let agenda = null;

const PREORDER_GRACE_MS = 15 * 60 * 1000;

// Scheduling helpers used by controllers and the state machine; they no-op
// while Agenda is not initialized (e.g. in tests)
const scheduleOrderJobs = async (order) => {
  if (!agenda) return;

  if (order.when?.type === "scheduled" && order.when?.at) {
    // Activate or fan out at the lead time; remind assigned drivers at T-10.
    const leadMinutes = 30;
    const city = await require("../models/City").findById(order.cityId).select("settings");
    const lead = (city?.settings?.preorderLeadMinutes ?? leadMinutes) * 60 * 1000;
    const activateAt = new Date(order.when.at).getTime() - lead;
    const reminderAt = new Date(order.when.at).getTime() - 10 * 60 * 1000;

    await agenda.schedule(
      new Date(Math.max(Date.now(), activateAt)),
      "preorder:activate",
      { orderId: String(order._id) }
    );
    await agenda.schedule(
      new Date(Math.max(Date.now(), reminderAt)),
      "preorder:reminder",
      { orderId: String(order._id) }
    );
    // A preorder nobody booked expires shortly after its time; the handler
    // only touches orders still PUBLISHED, so bookings are unaffected
    await agenda.schedule(
      new Date(Math.max(Date.now(), new Date(order.when.at).getTime() + PREORDER_GRACE_MS)),
      "order:expire",
      { orderId: String(order._id) }
    );
    return;
  }

  await scheduleCascade(order);
  await agenda.schedule(
    order.expiresAt ?? new Date(Date.now() + 300 * 1000),
    "order:expire",
    { orderId: String(order._id) }
  );
};

const scheduleCascade = async (order) => {
  if (!agenda) return;
  const city = await require("../models/City").findById(order.cityId).select("settings");
  const timeouts = city?.settings?.cascadeTimeouts ?? {};
  // Zone-less orders (route-as-text) go favorites -> city directly
  const steps = order.fromZone
    ? [
        ["favorites", 0],
        ["zone", timeouts.favorites ?? 20],
        ["neighbors", timeouts.zone ?? 60],
        ["city", timeouts.neighbors ?? 120],
      ]
    : [
        ["favorites", 0],
        ["city", timeouts.favorites ?? 20],
      ];
  for (const [step, delaySec] of steps) {
    await agenda.schedule(
      new Date(Date.now() + delaySec * 1000),
      "order:cascade",
      { orderId: String(order._id), step }
    );
  }
};

const scheduleWaitingTimer = async (order, waitingMinutes) => {
  if (!agenda) return;
  await agenda.schedule(
    new Date(Date.now() + waitingMinutes * 60 * 1000),
    "order:waitingTimeout",
    { orderId: String(order._id) }
  );
};

// Booking can happen after the lead-time activation job has already run.
const scheduleBookingActivation = async (order) => {
  if (!agenda || order.when?.type !== "scheduled" || !order.when?.at) return;
  await agenda.schedule(
    new Date(Math.max(Date.now(), new Date(order.when.at).getTime())),
    "preorder:activate",
    { orderId: String(order._id), bookingOnly: true }
  );
};

const initJobs = async (mongoUri) => {
  agenda = new Agenda({
    db: { address: mongoUri, collection: "agendaJobs" },
    processEvery: "15 seconds",
  });

  agenda.define("order:cascade", { concurrency: 5 }, (job) =>
    handlers.runCascadeStep(job.attrs.data)
  );
  agenda.define("order:expire", { concurrency: 5 }, (job) =>
    handlers.runOrderExpire(job.attrs.data)
  );
  agenda.define("order:waitingTimeout", { concurrency: 5 }, (job) =>
    handlers.runWaitingTimeout(job.attrs.data)
  );
  agenda.define("preorder:activate", { concurrency: 5 }, (job) =>
    handlers.runPreorderActivate(job.attrs.data)
  );
  agenda.define("preorder:reminder", { concurrency: 5 }, (job) =>
    handlers.runPreorderReminder(job.attrs.data)
  );
  agenda.define("driver:heartbeatSweep", (job) => handlers.runHeartbeatSweep());
  agenda.define("city:recalcStatus", (job) => handlers.runCityStatusRecalc());
  agenda.define("chat:closeDirect", (job) => handlers.runDirectChatCleanup());

  await agenda.start();

  // Recurring maintenance jobs
  await agenda.every("30 seconds", "driver:heartbeatSweep");
  await agenda.every("5 minutes", "city:recalcStatus");
  await agenda.every("5 minutes", "chat:closeDirect");

  return agenda;
};

const getAgenda = () => agenda;

module.exports = {
  initJobs,
  getAgenda,
  scheduleOrderJobs,
  scheduleCascade,
  scheduleWaitingTimer,
  scheduleBookingActivation,
};
