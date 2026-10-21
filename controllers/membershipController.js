const { z } = require("zod");
const mongoose = require("mongoose");
const City = require("../models/City");
const Zone = require("../models/Zone");
const Membership = require("../models/Membership");
const DriverProfile = require("../models/DriverProfile");
const User = require("../models/User");
const ApiError = require("../utilities/errors");
const catchAsyncError = require("../utilities/catchAsyncError");
const { validateBody } = require("../utilities/catchAsyncError");
const { logAudit } = require("../utilities/audit");
const { recalcCityStatus } = require("../utilities/cityStatus");
const { normalizePhone } = require("../utilities/drivers");

const carSchema = z.object({
  color: z.string().trim().min(1, "Укажите цвет автомобиля").max(30, "Цвет слишком длинный"),
  plate: z
    .string()
    .trim()
    .min(1, "Укажите номер автомобиля")
    .max(12, "Номер не длиннее 12 символов"),
  brand: z.string().trim().max(30, "Марка слишком длинная").optional(),
});

const createMembershipSchema = z
  .object({
    cityId: z.string().min(1, "Не указан город"),
    role: z.enum(["passenger", "driver"], {
      errorMap: () => ({ message: "Роль должна быть passenger или driver" }),
    }),
    displayName: z.string().trim().min(1, "Укажите имя водителя").max(50).optional(),
    phone: z.string().optional(),
    car: carSchema.optional(),
    // Зоны больше не обязательны: лента городская, маршрут — текстом
    zones: z.array(z.string()).max(5, "Не больше 5 зон").optional(),
  })
  .superRefine((data, ctx) => {
    if (data.role !== "driver") return;
    if (!data.displayName)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Укажите имя водителя", path: ["displayName"] });
    if (!data.phone)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Укажите телефон", path: ["phone"] });
    if (!data.car)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Укажите автомобиль", path: ["car"] });
  });

const updateMembershipSchema = z.object({
  zones: z.array(z.string()).min(1, "Выберите от 1 до 5 зон").max(5, "Выберите от 1 до 5 зон").optional(),
});

const homeCitySchema = z.object({
  cityId: z.string().min(1, "Не указан город"),
});

exports.createMembershipSchema = createMembershipSchema;
exports.updateMembershipSchema = updateMembershipSchema;
exports.homeCitySchema = homeCitySchema;

const validateZonesBelongToCity = async (cityId, zoneIds) => {
  const validZones = await Zone.find({ _id: { $in: zoneIds }, cityId }).select("_id");
  if (validZones.length !== zoneIds.length)
    throw new ApiError(400, "Некоторые зоны не относятся к выбранному городу");
  return validZones.map((zone) => zone._id);
};

// POST /api/memberships — become a passenger or submit a driver questionnaire
exports.createMembership = [
  validateBody(createMembershipSchema),
  catchAsyncError(async (req, res) => {
    const { cityId, role } = req.body;

    const city = await City.findById(cityId);
    if (!city) throw new ApiError(404, "Город не найден");

    const existing = await Membership.findOne({ userId: req.user._id, cityId, role });
    if (existing) {
      throw new ApiError(
        409,
        role === "passenger"
          ? "Вы уже пассажир этого города"
          : "Анкета водителя в этом городе уже подана"
      );
    }

    if (role === "passenger") {
      const status = ["PILOT", "ACTIVE"].includes(city.status) ? "ACTIVE" : "WAITLIST";
      const membership = await Membership.create({
        userId: req.user._id,
        cityId,
        role,
        status,
      });

      await logAudit({
        actorId: req.user._id,
        action: "membership.created",
        targetType: "Membership",
        targetId: membership._id,
        payload: { cityId, role, status },
      });
      await recalcCityStatus(cityId);

      return res.status(201).json({
        status: "success",
        data: { membership },
        ...(status === "WAITLIST" && {
          message: "В вашем городе сервис ещё не запущен, вы в списке ожидания",
        }),
      });
    }

    // Driver role
    const phone = normalizePhone(req.body.phone);
    if (!phone)
      throw new ApiError(400, "Телефон должен быть в формате +7XXXXXXXXXX");

    const zoneIds = req.body.zones?.length
      ? await validateZonesBelongToCity(cityId, req.body.zones)
      : [];

    let status = "PENDING";
    if (city.settings?.autoApproveDrivers) {
      status = "ACTIVE";
    }

    const membership = await Membership.create({
      userId: req.user._id,
      cityId,
      role,
      status,
      ...(role === "driver" && { zones: zoneIds }),
    });

    try {
      await DriverProfile.create({
        membershipId: membership._id,
        displayName: req.body.displayName,
        phone,
        car: {
          color: req.body.car.color,
          plate: req.body.car.plate,
          ...(req.body.car.brand && { brand: req.body.car.brand }),
        },
        zones: undefined,
      });
    } catch (error) {
      await Membership.findByIdAndDelete(membership._id);
      if (error.code === 11000)
        throw new ApiError(409, "Этот телефон уже зарегистрирован у другого водителя");
      throw error;
    }

    if (status === "ACTIVE") {
      // Validate the car pair before activating the driver
      // An occupied pair rolls the whole application back instead of
      // leaving an ACTIVE driver with a duplicate car
      try {
        await assertCarPairFree(membership);
      } catch (error) {
        await DriverProfile.deleteOne({ membershipId: membership._id });
        await Membership.findByIdAndDelete(membership._id);
        throw error;
      }
      membership.reviewedBy = req.user._id;
      await membership.save();
    }

    await logAudit({
      actorId: req.user._id,
      action: "membership.driverApplication",
      targetType: "Membership",
      targetId: membership._id,
      payload: { cityId, status, autoApproved: status === "ACTIVE" },
    });
    await recalcCityStatus(cityId);

    res.status(201).json({
      status: "success",
      data: { membership },
    });
  }),
];

// Throws when an ACTIVE driver of the city already uses the same color+plate
const assertCarPairFree = async (membership) => {
  const activeDrivers = await Membership.find({
    cityId: membership.cityId,
    role: "driver",
    status: "ACTIVE",
    _id: { $ne: membership._id },
  }).select("_id");

  const profiles = await DriverProfile.find({
    membershipId: { $in: activeDrivers.map((item) => item._id) },
  });

  const current = await DriverProfile.findOne({ membershipId: membership._id });
  const { sameCarPair } = require("../utilities/drivers");

  for (const profile of profiles) {
    if (sameCarPair(current, profile))
      throw new ApiError(409, "Пара «цвет и номер» уже занята в этом городе");
  }
};

// GET /api/memberships/mine
exports.getMyMemberships = catchAsyncError(async (req, res) => {
  const memberships = await Membership.find({ userId: req.user._id })
    .populate("cityId", "name status tz")
    .populate("zones", "name");

  const profiles = await DriverProfile.find({
    membershipId: { $in: memberships.map((item) => item._id) },
  });

  res.json({
    status: "success",
    data: {
      memberships,
      driverProfiles: profiles.map((profile) => ({
        ...profile.toObject(),
        carCaption: [
          profile.car.color,
          profile.car.plate,
          profile.car.brand,
        ]
          .filter(Boolean)
          .join(" "),
      })),
    },
  });
});

// PATCH /api/memberships/:id — driver changes his zones; owner only
exports.updateMembership = [
  validateBody(updateMembershipSchema),
  catchAsyncError(async (req, res) => {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id))
      throw new ApiError(400, "Некорректный идентификатор членства");

    const membership = await Membership.findById(id);
    if (!membership) throw new ApiError(404, "Членство не найдено");
    if (String(membership.userId) !== String(req.user._id))
      throw new ApiError(403, "Это чужое членство");
    if (req.body.zones && membership.role === "driver") {
      const zoneIds = await validateZonesBelongToCity(membership.cityId, req.body.zones);
      membership.zones = zoneIds;
      await membership.save();

      await logAudit({
        actorId: req.user._id,
        action: "membership.zonesChanged",
        targetType: "Membership",
        targetId: membership._id,
        payload: { cityId: membership.cityId, zones: zoneIds },
      });
    }

    res.json({ status: "success", data: { membership } });
  }),
];

// PATCH /api/users/me/home-city — home city changes at most once per 30 days
exports.setHomeCity = [
  validateBody(homeCitySchema),
  catchAsyncError(async (req, res) => {
    const city = await City.findById(req.body.cityId);
    if (!city) throw new ApiError(404, "Город не найден");

    const user = await User.findById(req.user._id);
    const changed = user.homeCityChangedAt
      ? new Date(user.homeCityChangedAt).getTime()
      : 0;
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;

    if (
      user.homeCityId &&
      String(user.homeCityId) !== String(city._id) &&
      Date.now() - changed < thirtyDays
    ) {
      throw new ApiError(
        403,
        "Домашний город можно менять не чаще раза в 30 дней"
      );
    }

    const isChange = !user.homeCityId || String(user.homeCityId) !== String(city._id);
    if (isChange) {
      user.homeCityId = city._id;
      user.homeCityChangedAt = new Date();
      await user.save();
    }

    await logAudit({
      actorId: req.user._id,
      action: "user.homeCityChanged",
      targetType: "User",
      targetId: user._id,
      payload: { cityId: city._id },
    });

    res.json({ status: "success", data: { homeCityId: user.homeCityId } });
  }),
];
