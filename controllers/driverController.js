const { z } = require("zod");
const mongoose = require("mongoose");
const DriverProfile = require("../models/DriverProfile");
const ApiError = require("../utilities/errors");
const catchAsyncError = require("../utilities/catchAsyncError");
const { validateBody } = require("../utilities/catchAsyncError");
const { requireMembership, loadMemberships } = require("../utilities/rbac");
const { carCaption } = require("../utilities/drivers");
const User = require("../models/User");
const { normalizePhone } = require("../utilities/phone");
const { logAudit } = require("../utilities/audit");
const { applyShiftChange } = require("../services/driverShiftService");

const settingsSchema = z.object({
  cityId: z.string().min(1, "Не указан город"),
  acceptDirectCalls: z.boolean({
    errorMap: () => ({ message: "acceptDirectCalls должен быть true или false" }),
  }),
  // Optional: the profile screen may switch the shift over REST too. The same
  // dispatcher-removal lock as in the socket path applies.
  shift: z.enum(["online", "offline"]).optional(),
  confirmBack: z.boolean().optional(),
});

exports.settingsSchema = settingsSchema;

// The driver edits his own card: the name passengers see, the callback phone
// and the car. Anything unrelated to the profile is rejected.
const profileSchema = z
  .object({
    cityId: z.string().min(1, "Не указан город"),
    displayName: z.string().trim().min(1, "Укажите имя").max(40, "Имя слишком длинное").optional(),
    phone: z.string().trim().max(30, "Телефон слишком длинный").optional(),
    about: z.string().trim().max(160, "О себе — не больше 160 символов").optional(),
    car: z
      .object({
        color: z.string().trim().min(1, "Укажите цвет").max(20),
        plate: z.string().trim().min(1, "Укажите номер").max(12),
        brand: z.string().trim().max(20).optional(),
      })
      .optional(),
  })
  .refine(
    (data) => data.displayName || data.phone || data.car || data.about !== undefined,
    { message: "Нет изменений" }
  );

exports.profileSchema = profileSchema;

// PATCH /api/drivers/me/profile — the driver keeps his own card up to date
exports.updateMyProfile = [
  loadMemberships,
  validateBody(profileSchema),
  requireMembership({ role: "driver", cityFrom: "body" }),
  catchAsyncError(async (req, res) => {
    const { displayName, phone, about, car } = req.body;
    const profile = await DriverProfile.findOne({ membershipId: req.membership._id });
    if (!profile) throw new ApiError(404, "Анкета водителя не найдена");

    const changed = {};
    if (displayName !== undefined && displayName !== profile.displayName) {
      profile.displayName = displayName;
      changed.displayName = displayName;
    }
    if (about !== undefined && about !== profile.about) {
      profile.about = about;
      changed.about = about;
    }
    if (phone !== undefined) {
      const normalized = normalizePhone(phone);
      if (!normalized)
        throw new ApiError(400, "Телефон укажите в формате +7 902 111-22-33");
      const taken = await DriverProfile.findOne({
        phone: normalized,
        _id: { $ne: profile._id },
      }).select("_id");
      if (taken) throw new ApiError(409, "Этот телефон уже указан у другого водителя");
      if (normalized !== profile.phone) {
        profile.phone = normalized;
        changed.phone = normalized;
      }
      // One phone per account: the account card follows the driver card
      const user = await User.findById(req.user._id);
      if (user && user.phone !== normalized) {
        user.phone = normalized;
        await user.save();
      }
    }
    if (car) {
      const nextCar = {
        color: car.color,
        plate: car.plate,
        ...(car.brand !== undefined && { brand: car.brand }),
      };
      const same =
        nextCar.color === profile.car?.color &&
        nextCar.plate === profile.car?.plate &&
        (nextCar.brand ?? "") === (profile.car?.brand ?? "");
      if (!same) {
        profile.car = nextCar;
        changed.car = nextCar;
      }
    }

    if (Object.keys(changed).length === 0) {
      return res.json({
        status: "success",
        data: { profile: { ...profile.toObject(), carCaption: carCaption(profile.car ?? {}) } },
      });
    }

    await profile.save();
    await logAudit({
      actorId: req.user._id,
      action: "driver.profileUpdated",
      targetType: "DriverProfile",
      targetId: profile._id,
      payload: changed,
    });

    res.json({
      status: "success",
      data: { profile: { ...profile.toObject(), carCaption: carCaption(profile.car ?? {}) } },
    });
  }),
];

// GET /api/drivers/me?cityId=
exports.getMyDriverProfile = [
  loadMemberships,
  catchAsyncError(async (req, res) => {
    const { cityId } = req.query;
    const memberships = (req.memberships ?? []).filter(
      (item) =>
        item.role === "driver" &&
        item.status === "ACTIVE" &&
        (!cityId || String(item.cityId?._id ?? item.cityId) === String(cityId))
    );

    const profiles = await DriverProfile.find({
      membershipId: { $in: memberships.map((item) => item._id) },
    });

    res.json({
      status: "success",
      data: {
        profiles: profiles.map((profile) => ({
          ...profile.toObject(),
          carCaption: carCaption(profile.car ?? {}),
        })),
      },
    });
  }),
];

// PATCH /api/drivers/me/settings — { acceptDirectCalls } for a city membership
exports.updateMySettings = [
  loadMemberships,
  validateBody(settingsSchema),
  requireMembership({ role: "driver", cityFrom: "body" }),
  catchAsyncError(async (req, res) => {
    const { acceptDirectCalls, shift, confirmBack } = req.body;

    const profile = await DriverProfile.findOne({ membershipId: req.membership._id });
    if (!profile) throw new ApiError(404, "Анкета водителя не найдена");

    profile.acceptDirectCalls = acceptDirectCalls;
    await profile.save();

    let updated = profile;
    if (shift) {
      const result = await applyShiftChange({
        userId: req.user._id,
        shift,
        confirmBack: confirmBack === true,
      });
      if (result.reason === "locked")
        throw new ApiError(
          409,
          `Диспетчер снял вас с линии: ${result.profile.shiftNote}. Подтвердите возврат.`
        );
      if (!result.ok) throw new ApiError(403, "Нет активной анкеты водителя");
      updated = result.profile;
    }

    res.json({
      status: "success",
      data: { profile: { ...updated.toObject(), carCaption: carCaption(updated.car ?? {}) } },
    });
  }),
];
