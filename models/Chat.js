const mongoose = require("mongoose");

const CHAT_TYPES = ["order", "zone", "city", "direct", "support", "ai"];

// New-generation chat rooms (concept 1.7). Legacy ChatRoom keeps working for
// the old contact chats; orders and direct calls use this model.
const chatSchema = new mongoose.Schema(
  {
    type: { type: String, enum: CHAT_TYPES, required: true },
    cityId: { type: mongoose.Schema.Types.ObjectId, ref: "City", index: true },
    zoneId: { type: mongoose.Schema.Types.ObjectId, ref: "Zone" },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", index: true },
    members: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    lastActivityAt: { type: Date, default: Date.now },
    closedAt: Date,
  },
  { timestamps: true }
);

chatSchema.index({ members: 1, type: 1 });

module.exports = mongoose.model("Chat", chatSchema);
