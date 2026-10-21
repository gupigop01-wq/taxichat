const catchAsyncError = require("../utilities/catchAsyncError");
const ReqError = require("../utilities/ReqError");
const User = require("../models/User");

exports.getSelfProfile = catchAsyncError(async (req, res, next) => {
  const user = await User.findById(req.user._id).select(
    "-contacts -password -__v"
  );

  if (!user) return next(new ReqError(400, "User does not exist"));

  res.status(200).json({
    status: "Success",
    data: {
      user,
    },
  });
});

// Only these fields may be changed by the user; role, ban, password and
// bookkeeping fields must never be taken from the request body
const EDITABLE_PROFILE_FIELDS = ["name", "bio", "avatar", "username"];

exports.updateSelfProfile = catchAsyncError(async (req, res, next) => {
  const update = {};
  for (const field of EDITABLE_PROFILE_FIELDS) {
    const value = req.body?.[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || !value.trim())
      return next(new ReqError(400, "Некорректное поле " + field));
    update[field] = value.trim();
  }

  // This action should send a message to all sockets to update username if user changes username
  const user = await User.findByIdAndUpdate(req.user._id, update, {
    new: true,
    runValidators: true,
  }).select("-contacts -password -__v");

  if (!user) return next(new ReqError(400, "User does not exist"));

  res.status(200).json({
    status: "Success",
    data: {
      user,
    },
  });
});
