const crypto = require("crypto");
const mongoose = require("mongoose");
const Order = require("../models/Order");
const DriverProfile = require("../models/DriverProfile");
const Membership = require("../models/Membership");
const ApiError = require("../utilities/errors");
const catchAsyncError = require("../utilities/catchAsyncError");
const { carCaption } = require("../utilities/drivers");

// GET /api/orders/:id/share — participant gets a read-only share link
// (concept 1.10: только маршрут, статус, машина, без телефонов)
exports.createShareLink = catchAsyncError(async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) throw new ApiError(404, "Заказ не найден");

  const isParticipant =
    String(order.passengerId) === String(req.user._id) ||
    (order.driverId && String(order.driverId) === String(req.user._id));
  if (!isParticipant) throw new ApiError(403, "Вы не участник заказа");

  const TERMINAL = ["COMPLETED", "CANCELLED", "NO_SHOW", "EXPIRED"];
  if (TERMINAL.includes(order.status))
    throw new ApiError(409, "Поездка уже завершена");

  if (!order.shareToken) {
    order.shareToken = crypto.randomBytes(16).toString("hex");
    await order.save();
  }

  res.json({
    status: "success",
    data: { url: `/share/${order.shareToken}` },
  });
});

// GET /api/share/:token — public read-only trip status (no personal data)
exports.viewSharedTrip = catchAsyncError(async (req, res) => {
  const order = await Order.findOne({ shareToken: req.params.token });
  if (!order) throw new ApiError(404, "Ссылка не найдена");

  let driver = null;
  if (order.driverId) {
    // DriverProfile is keyed by the driver membership of the order city
    const membership = await Membership.findOne({
      userId: order.driverId,
      cityId: order.cityId,
      role: "driver",
    }).select("_id");
    const profile = membership
      ? await DriverProfile.findOne({ membershipId: membership._id })
      : null;
    if (profile) {
      driver = {
        displayName: profile.displayName,
        carCaption: profile.car ? carCaption(profile.car) : undefined,
      };
    }
  }

  res.json({
    status: "success",
    data: {
      status: order.status,
      from: order.from?.text,
      to: order.to?.text,
      when: order.when,
      pax: order.pax,
      priceAgreed: order.priceAgreed,
      driver,
      updatedAt: order.updatedAt,
    },
  });
});
