const express = require("express");
const mongoose = require("mongoose");
const uploadController = require("../controllers/uploadController");
const Order = require("../models/Order");
const { Chat, isChatUsableForUpload, isBlockedWithChatPeer, withinHourlyQuota } = require("../utilities/uploadPolicy");
const ApiError = require("../utilities/errors");
const catchAsyncError = require("../utilities/catchAsyncError");
const { protect } = require("../utilities/auth");
const { loadMemberships } = require("../utilities/rbac");

const router = express.Router();

// Media is only stored for a conversation the caller takes part in: the order
// (passenger / assigned driver / city dispatcher) or a live chat in a city the
// caller belongs to, within a per-user hourly budget. Without this an account
// could fill the disk with 10-15 MB blobs.
const assertUploadContext = catchAsyncError(async (req, res, next) => {
  const { orderId, chatId } = req.body ?? {};
  const userId = String(req.user._id);

  if (orderId) {
    if (!mongoose.isValidObjectId(orderId))
      throw new ApiError(400, "Некорректный идентификатор заказа");
    const order = await Order.findById(orderId).select("passengerId driverId cityId");
    if (!order) throw new ApiError(404, "Заказ не найден");

    const isParticipant =
      String(order.passengerId) === userId ||
      (order.driverId && String(order.driverId) === userId);
    const isDispatcher = (req.memberships ?? []).some(
      (item) =>
        item.role === "dispatcher" &&
        item.status === "ACTIVE" &&
        String(item.cityId?._id ?? item.cityId) === String(order.cityId)
    );
    if (!isParticipant && !isDispatcher)
      throw new ApiError(403, "Вы не участник этого заказа");
  } else if (chatId) {
    if (!mongoose.isValidObjectId(chatId))
      throw new ApiError(400, "Некорректный идентификатор чата");
    const chat = await Chat.findOne({ _id: chatId, members: req.user._id }).select(
      "type cityId members closedAt lastActivityAt"
    );
    if (!chat) throw new ApiError(403, "Вы не участник этого чата");
    if (!isChatUsableForUpload(chat, req.memberships))
      throw new ApiError(403, "Диалог закрыт или недоступен в этом городе");
    if (await isBlockedWithChatPeer(chat, req.user._id))
      throw new ApiError(403, "Диалог недоступен: собеседник заблокирован");
  } else {
    throw new ApiError(400, "Не указан заказ или чат для файла");
  }

  if (!(await withinHourlyQuota(req.user._id)))
    throw new ApiError(429, "Слишком много медиафайлов за час, попробуйте позже");

  next();
});

router.post("/", protect, loadMemberships, assertUploadContext, uploadController.upload);
router.get("/:filename", protect, uploadController.download);

module.exports = router;
