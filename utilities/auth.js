const jwt = require("jsonwebtoken");
const User = require("../models/User");
const ApiError = require("./errors");
const catchAsyncError = require("./catchAsyncError");

const AUTH_COOKIE = "telegramToken";
const DEFAULT_TOKEN_DAYS = 30;

const parseTokenDays = () => {
  const match = /^(?:P)?(\d+)d?$/.exec(process.env.JWT_EXPIRES_IN ?? "");
  return match ? parseInt(match[1], 10) : DEFAULT_TOKEN_DAYS;
};

// Token carries only the userId; roles and memberships are resolved per request
const signToken = (userId) =>
  jwt.sign({ userId }, process.env.JWT_SECRET_KEY, {
    expiresIn: process.env.JWT_EXPIRES_IN || `${DEFAULT_TOKEN_DAYS}d`,
  });

const sendAuthCookie = (user, res, statusCode) => {
  const token = signToken(user._id);

  const cookieOptions = {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires: new Date(Date.now() + parseTokenDays() * 24 * 60 * 60 * 1000),
  };

  res.cookie(AUTH_COOKIE, token, cookieOptions);

  user.password = undefined;

  res.status(statusCode).json({
    status: "success",
    // The JWT lives only in the httpOnly cookie; never expose it to page JS
    data: { user },
  });
};

const clearAuthCookie = (res) => {
  res.clearCookie(AUTH_COOKIE);
};

// Verifies the JWT cookie and loads the user for every protected request
const protect = catchAsyncError(async (req, res, next) => {
  const token = req.cookies?.[AUTH_COOKIE];

  if (!token) return next(new ApiError(401, "Требуется авторизация"));

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET_KEY);
  } catch (error) {
    return next(new ApiError(401, "Сессия недействительна, войдите заново"));
  }

  const user = await User.findById(payload.userId);
  if (!user) return next(new ApiError(401, "Пользователь не найден"));
  if (user.banned) return next(new ApiError(403, "Аккаунт заблокирован"));

  req.user = user;
  next();
});

module.exports = { signToken, sendAuthCookie, clearAuthCookie, protect, AUTH_COOKIE };
