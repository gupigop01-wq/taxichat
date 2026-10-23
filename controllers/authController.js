const { z } = require("zod");
const User = require("../models/User");
const ApiError = require("../utilities/errors");
const catchAsyncError = require("../utilities/catchAsyncError");
const { sendAuthCookie, clearAuthCookie } = require("../utilities/auth");
const City = require("../models/City");
const Membership = require("../models/Membership");
const { recalcCityStatus } = require("../utilities/cityStatus");
const { normalizePhone } = require("../utilities/phone");

const registerSchema = z
  .object({
    name: z.string().trim().min(1, "Укажите имя").max(50, "Имя слишком длинное"),
    username: z
      .string()
      .trim()
      .min(3, "Логин должен содержать минимум 3 символа")
      .max(30, "Логин слишком длинный")
      .regex(/^[a-zA-Z0-9_.-]+$/, "Логин: только латиница, цифры и символы . _ -")
      .transform((value) => value.toLowerCase()),
    password: z.string().min(8, "Пароль должен содержать минимум 8 символов"),
    confirmPassword: z.string().min(1, "Повторите пароль"),
    // Город при регистрации: выбрать существующий или добавить свой
    cityId: z.string().optional(),
    newCityName: z.string().trim().min(1, "Укажите город").max(60).optional(),
    bio: z.string().max(100).optional(),
    avatar: z.string().optional(),
    // Contact phone: any readable format, stored as +7XXXXXXXXXX
    phone: z.string().trim().max(30).optional(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Пароли не совпадают",
    path: ["confirmPassword"],
  })
  .refine((data) => !(data.cityId && data.newCityName), {
    message: "Выберите город из списка или введите свой",
    path: ["newCityName"],
  });

const loginSchema = z.object({
  username: z
    .string()
    .trim()
    .min(1, "Введите логин")
    .transform((value) => value.toLowerCase()),
  password: z.string().min(1, "Введите пароль"),
});

exports.registerSchema = registerSchema;
exports.loginSchema = loginSchema;

exports.register = catchAsyncError(async (req, res) => {
  const { name, username, password, bio, avatar, cityId, newCityName, phone } = req.body;

  const existing = await User.findOne({ username });
  if (existing) throw new ApiError(409, "Логин уже занят");

  const normalizedPhone = phone ? normalizePhone(phone) : null;
  if (phone && !normalizedPhone)
    throw new ApiError(400, "Телефон укажите в формате +7 902 111-22-33");

  const newUser = await User.create({
    name,
    username,
    password,
    confirmPassword: req.body.confirmPassword,
    ...(normalizedPhone && { phone: normalizedPhone }),
    ...(bio !== undefined && { bio }),
    ...(avatar !== undefined && { avatar }),
  });

  // Город при регистрации: готовый из справочника или добавленный вручную
  let city = null;
  if (cityId) {
    city = await City.findById(cityId);
  } else if (newCityName) {
    const existingCity = await City.findOne({ name: newCityName });
    city =
      existingCity ??
      (await City.create({
        name: newCityName,
        oktmo: `C${Date.now()}`,
        custom: true,
        status: "PILOT",
      }));
  }

  if (city) {
    await Membership.create({
      userId: newUser._id,
      cityId: city._id,
      role: "passenger",
      status: "ACTIVE",
    });
    newUser.homeCityId = city._id;
    await User.findByIdAndUpdate(newUser._id, { homeCityId: city._id });
    await recalcCityStatus(city._id);
  }

  sendAuthCookie(newUser, res, 201);
});

exports.login = catchAsyncError(async (req, res, next) => {
  const { username, password } = req.body;

  const foundUser = await User.findOne({ username });

  if (!foundUser)
    return next(new ApiError(400, "Неверный логин или пароль"));

  if (foundUser.banned)
    return next(new ApiError(403, "Аккаунт заблокирован"));

  const passwordGivenCorrect = await foundUser.checkPasswordValidity(
    password,
    foundUser.password
  );

  if (!passwordGivenCorrect)
    return next(new ApiError(400, "Неверный логин или пароль"));

  sendAuthCookie(foundUser, res, 200);
});

exports.logout = (req, res) => {
  clearAuthCookie(res);
  res.status(200).json({ status: "success", message: "Вы вышли из аккаунта" });
};

exports.me = catchAsyncError(async (req, res) => {
  const Membership = require("../models/Membership");
  const DriverProfile = require("../models/DriverProfile");

  const memberships = await Membership.find({ userId: req.user._id })
    .populate("cityId", "name status tz")
    .populate("zones", "name");

  const driverProfiles = await DriverProfile.find({
    membershipId: { $in: memberships.map((membership) => membership._id) },
  });

  res.status(200).json({
    status: "success",
    data: { user: req.user, memberships, driverProfiles },
  });
});
