const { z } = require("zod");
const City = require("../models/City");
const ApiError = require("../utilities/errors");
const catchAsyncError = require("../utilities/catchAsyncError");
const { validateBody } = require("../utilities/catchAsyncError");
const { logAudit } = require("../utilities/audit");
const { regionAdminCityIds, loadMemberships } = require("../utilities/rbac");
const { normalizePhone } = require("../utilities/phone");
const Membership = require("../models/Membership");
const DriverProfile = require("../models/DriverProfile");
const Order = require("../models/Order");
const pushService = require("../utilities/pushService");
const { emitOrderEvents } = require("../utilities/sockets");

// City settings are split by who owns the decision:
//  - city line and waiting time are operational: the city dispatchers keep
//    them current, the region admin may also change them;
//  - match mode and contact filtering are policy: region admin / superadmin.
const canEditCityOps = async (req, cityId) => {
  if (req.user?.isSuperadmin) return true;
  const ownCity = (req.memberships ?? []).some(
    (item) =>
      item.role === "dispatcher" &&
      item.status === "ACTIVE" &&
      String(item.cityId?._id ?? item.cityId) === String(cityId)
  );
  if (ownCity) return true;
  return (await regionAdminCityIds(req))?.includes(String(cityId)) === true;
};

const settingsView = (city) => ({
  cityId: city._id,
  dispatchPhone: city.settings?.dispatchPhone ?? null,
  dispatchPhoneNote: city.settings?.dispatchPhoneNote ?? "",
  // Timers a shift can change without touching policy
  waitingMinutes: city.settings?.waitingMinutes ?? 10,
  preorderLeadMinutes: city.settings?.preorderLeadMinutes ?? 30,
  directOrderTimeoutMin: city.settings?.directOrderTimeoutMin ?? 10,
  cascadeTimeouts: {
    favorites: city.settings?.cascadeTimeouts?.favorites ?? 20,
    zone: city.settings?.cascadeTimeouts?.zone ?? 60,
    neighbors: city.settings?.cascadeTimeouts?.neighbors ?? 120,
    city: city.settings?.cascadeTimeouts?.city ?? 300,
    expire: city.settings?.cascadeTimeouts?.expire ?? 600,
  },
});

const timersSchema = z.object({
  waitingMinutes: z.number().int().min(1, "Минимум 1 минута").max(60, "Максимум 60 минут").optional(),
  preorderLeadMinutes: z.number().int().min(5).max(240).optional(),
  directOrderTimeoutMin: z.number().int().min(1).max(120).optional(),
  cascadeTimeouts: z
    .object({
      favorites: z.number().int().min(0).max(600).optional(),
      zone: z.number().int().min(0).max(1800).optional(),
      neighbors: z.number().int().min(0).max(3600).optional(),
      city: z.number().int().min(0).max(3600).optional(),
      expire: z.number().int().min(60, "Заказ не может истекать раньше минуты").max(7200).optional(),
    })
    .optional(),
});
exports.timersSchema = timersSchema;

// PATCH /api/dispatch/:cityId/timers — waiting and cascade timers
exports.setCityTimers = [
  loadMemberships,
  validateBody(timersSchema),
  catchAsyncError(async (req, res) => {
    if (!(await canEditCityOps(req, req.params.cityId)))
      throw new ApiError(403, "Недостаточно прав в этом городе");
    const city = await City.findById(req.params.cityId);
    if (!city) throw new ApiError(404, "Город не найден");

    city.settings = city.settings ?? {};
    const { waitingMinutes, preorderLeadMinutes, directOrderTimeoutMin, cascadeTimeouts } = req.body;
    if (waitingMinutes !== undefined) city.settings.waitingMinutes = waitingMinutes;
    if (preorderLeadMinutes !== undefined) city.settings.preorderLeadMinutes = preorderLeadMinutes;
    if (directOrderTimeoutMin !== undefined) city.settings.directOrderTimeoutMin = directOrderTimeoutMin;
    if (cascadeTimeouts) {
      city.settings.cascadeTimeouts = {
        ...(city.settings.cascadeTimeouts?.toObject?.() ?? city.settings.cascadeTimeouts ?? {}),
        ...cascadeTimeouts,
      };
    }
    city.markModified("settings");
    await city.save();

    await logAudit({
      actorId: req.user._id,
      action: "city.timersChanged",
      targetType: "City",
      targetId: city._id,
      payload: req.body,
    });

    res.json({ status: "success", data: { settings: settingsView(city) } });
  }),
];

const dispatchPhoneSchema = z.object({
  phone: z.string().trim().max(30).nullable().optional(),
  note: z.string().trim().max(80).optional(),
});
exports.dispatchPhoneSchema = dispatchPhoneSchema;

// GET /api/dispatch/:cityId/settings — current operational settings
exports.getCitySettings = [
  loadMemberships,
  catchAsyncError(async (req, res) => {
    if (!(await canEditCityOps(req, req.params.cityId)))
      throw new ApiError(403, "Недостаточно прав в этом городе");
    const city = await City.findById(req.params.cityId);
    if (!city) throw new ApiError(404, "Город не найден");
    res.json({ status: "success", data: { settings: settingsView(city) } });
  }),
];

// PATCH /api/dispatch/:cityId/dispatch-phone — the number passengers call
exports.setDispatchPhone = [
  loadMemberships,
  validateBody(dispatchPhoneSchema),
  catchAsyncError(async (req, res) => {
    if (!(await canEditCityOps(req, req.params.cityId)))
      throw new ApiError(403, "Недостаточно прав в этом городе");
    const city = await City.findById(req.params.cityId);
    if (!city) throw new ApiError(404, "Город не найден");

    const raw = req.body.phone ?? "";
    const normalized = raw ? normalizePhone(raw) : null;
    if (raw && !normalized)
      throw new ApiError(400, "Телефон укажите в формате +7 902 111-22-33");

    city.settings = city.settings ?? {};
    city.settings.dispatchPhone = normalized;
    if (req.body.note !== undefined) city.settings.dispatchPhoneNote = req.body.note;
    city.markModified("settings");
    await city.save();

    await logAudit({
      actorId: req.user._id,
      action: "city.dispatchPhoneChanged",
      targetType: "City",
      targetId: city._id,
      payload: { phone: normalized, note: city.settings.dispatchPhoneNote },
    });

    res.json({ status: "success", data: { settings: settingsView(city) } });
  }),
];

const forceOfflineSchema = z.object({
  reason: z.string().trim().min(3, "Укажите причину").max(200),
});

// PATCH /api/dispatch/:cityId/drivers/:membershipId/offline — a dispatcher
// takes the driver off the line; the active order (if any) stays with him.
exports.forceDriverOffline = [
  loadMemberships,
  validateBody(forceOfflineSchema),
  catchAsyncError(async (req, res) => {
    const { cityId, membershipId } = req.params;
    if (!(await canEditCityOps(req, cityId)))
      throw new ApiError(403, "Недостаточно прав в этом городе");

    const membership = await Membership.findOne({
      _id: membershipId,
      cityId,
      role: "driver",
      status: "ACTIVE",
    });
    if (!membership) throw new ApiError(404, "Водитель не найден в этом городе");

    const profile =
      (await DriverProfile.findOne({ membershipId: membership._id })) ??
      (await DriverProfile.create({ membershipId: membership._id }));
    profile.shift = "offline";
    profile.lastSeen = new Date();
    profile.shiftNote = req.body.reason;
    profile.shiftChangedBy = req.user._id;
    profile.shiftChangedAt = new Date();
    await profile.save();

    const activeOrder = await Order.findOne({
      driverId: membership.userId,
      status: { $in: ["ASSIGNED", "ARRIVING", "WAITING", "IN_RIDE"] },
    }).select("_id status");
    if (activeOrder) {
      // The driver keeps the order but cannot take new ones until back online
      await Order.updateOne({ _id: activeOrder._id }, { $set: { driverOfflineNote: req.body.reason } });
    }

    // Tell the driver and the city dashboard at once
    emitOrderEvents([
      { room: `user:${membership.userId}`, event: "driver:offline", payload: { reason: req.body.reason } },
      { room: `city:${cityId}`, event: "driver:presence", payload: { driverId: String(membership.userId), shift: "offline" } },
    ]);
    void pushService
      .sendPushToUser(membership.userId, {
        kind: "shift",
        title: "Диспетчер снял вас с линии",
        body: `Причина: ${req.body.reason}`,
        tag: "bombila-live",
        renotify: true,
        url: "/",
      })
      .catch(() => undefined);

    await logAudit({
      actorId: req.user._id,
      action: "dispatch.driverOffline",
      targetType: "Membership",
      targetId: membership._id,
      payload: { reason: req.body.reason, activeOrderId: activeOrder?._id ?? null },
    });

    res.json({
      status: "success",
      data: { membershipId: membership._id, shift: "offline", activeOrderId: activeOrder?._id ?? null },
    });
  }),
];
