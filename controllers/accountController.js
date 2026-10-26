const { z } = require("zod");
const User = require("../models/User");
const ApiError = require("../utilities/errors");
const catchAsyncError = require("../utilities/catchAsyncError");
const { validateBody } = require("../utilities/catchAsyncError");
const { normalizePhone } = require("../utilities/phone");
const { logAudit } = require("../utilities/audit");

// The personal card of the account: name, contact phone and a short "about me".
// Login is deliberately not editable here — it is the account identity used in
// audit records and by the dispatcher when calling out a driver.
const profileSchema = z
  .object({
    name: z.string().trim().min(1, "Укажите имя").max(50, "Имя слишком длинное").optional(),
    phone: z.string().trim().max(30, "Телефон слишком длинный").optional(),
    bio: z.string().trim().max(100, "О себе — не больше 100 символов").optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Нет изменений",
  });

exports.profileSchema = profileSchema;

// PATCH /api/user/me — the person edits his own card at any time
exports.updateMe = [
  validateBody(profileSchema),
  catchAsyncError(async (req, res) => {
    const { name, phone, bio } = req.body;
    const user = await User.findById(req.user._id);
    if (!user) throw new ApiError(404, "Пользователь не найден");

    const changed = {};
    if (name !== undefined && name !== user.name) {
      user.name = name;
      changed.name = name;
    }
    if (phone !== undefined) {
      const normalized = normalizePhone(phone);
      if (!normalized)
        throw new ApiError(400, "Телефон укажите в формате +7 902 111-22-33");
      if (normalized !== user.phone) {
        user.phone = normalized;
        changed.phone = normalized;
      }
    }
    if (bio !== undefined && bio !== user.bio) {
      user.bio = bio;
      changed.bio = bio;
    }

    if (Object.keys(changed).length === 0) {
      return res.json({ status: "success", data: { user: JSON.parse(JSON.stringify(user)) } });
    }

    await user.save();
    await logAudit({
      actorId: user._id,
      action: "profile.updated",
      targetType: "User",
      targetId: user._id,
      payload: changed,
    });

    res.json({ status: "success", data: { user: JSON.parse(JSON.stringify(user)) } });
  }),
];
