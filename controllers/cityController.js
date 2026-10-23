const { z } = require("zod");
const City = require("../models/City");
const ApiError = require("../utilities/errors");
const catchAsyncError = require("../utilities/catchAsyncError");
const { validateBody } = require("../utilities/catchAsyncError");
const { logAudit } = require("../utilities/audit");
const { regionAdminCityIds, loadMemberships } = require("../utilities/rbac");
const { normalizePhone } = require("../utilities/phone");

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
});

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
