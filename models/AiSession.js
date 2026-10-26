const mongoose = require("mongoose");

// One AI dispatcher conversation per user, city and role. The passenger chat,
// the driver chat and the dispatcher chat are separate threads, so a person
// who is both a passenger and a driver in one city keeps two dialogs.
// `pending` holds an action that waits for the user's explicit confirmation.
const aiSessionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    cityId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "City",
      required: true,
      index: true,
    },
    role: {
      type: String,
      enum: ["passenger", "driver", "dispatcher"],
      required: true,
    },
    chatId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Chat",
      required: true,
    },
    // One-line memory for the next turn (kept short: the local model is slow)
    summary: { type: String, default: "", maxlength: 600 },
    recent: [
      {
        _id: false,
        role: { type: String, enum: ["user", "bot"] },
        text: { type: String, maxlength: 300 },
      },
    ],
    pending: { type: mongoose.Schema.Types.Mixed, default: null },
    lastOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order" },
    turns: { type: Number, default: 0 },
    lastUserAt: Date,
  },
  { timestamps: true }
);

aiSessionSchema.index({ userId: 1, cityId: 1, role: 1 }, { unique: true });

module.exports = mongoose.model("AiSession", aiSessionSchema);
