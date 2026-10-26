const mongoose = require("mongoose");

const ORDER_STATUSES = [
  "DRAFT",
  "PUBLISHED",
  "BOOKED",
  "ASSIGNED",
  "ARRIVING",
  "WAITING",
  "IN_RIDE",
  "COMPLETED",
  "EXPIRED",
  "CANCELLED",
  "NO_SHOW",
  "DISPUTE",
];

const MATCH_MODES = ["offers", "first_take", "dispatcher"];

const statusLogSchema = new mongoose.Schema(
  {
    status: String,
    eventId: String,
    by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    at: { type: Date, default: Date.now },
    reason: String,
  },
  { _id: false }
);

const placeSchema = new mongoose.Schema(
  {
    text: String,
    landmarkId: { type: mongoose.Schema.Types.ObjectId, ref: "Landmark" },
  },
  { _id: false }
);

// Terms are snapshotted from the city settings when the driver arrives, so a
// rate change or a settings edit never touches a waiting order. endedAt is
// cleared again if the driver cancels a mistaken ride start.
const waitingSchema = new mongoose.Schema(
  {
    startedAt: Date,
    freeMinutes: Number,
    pricePerMin: Number,
    endedAt: Date,
  },
  { _id: false }
);

// An order is a chat room with a lifecycle (concept 1.6). exactFrom/exactTo
// stay hidden from drivers until ASSIGNED (see utilities/orderViews).
const orderSchema = new mongoose.Schema(
  {
    passengerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    // A dispatcher took the driver off the line while this order was active;
    // the order stays with the driver, the note is shown to him
    driverOfflineNote: { type: String, default: null },
    cityId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "City",
      required: true,
      index: true,
    },
    fromZone: { type: mongoose.Schema.Types.ObjectId, ref: "Zone", index: true },
    toZone: { type: mongoose.Schema.Types.ObjectId, ref: "Zone" },
    from: placeSchema,
    to: placeSchema,
    exactFrom: String,
    exactTo: String,
    when: {
      type: { type: String, enum: ["now", "scheduled"], default: "now" },
      at: Date,
    },
    pax: { type: Number, default: 1, min: 1, max: 8 },
    notes: { type: String, maxlength: 500 },
    // Reference price agreed in chat; no payments involved (concept 1.11)
    priceAgreed: String,
    // Free/paid waiting terms captured at "Я на месте" (see utilities/waiting)
    waiting: { type: waitingSchema, default: undefined },
    status: { type: String, enum: ORDER_STATUSES, default: "DRAFT", index: true },
    statusLog: [statusLogSchema],
    matchMode: { type: String, enum: MATCH_MODES, default: "offers" },
    mode: { type: String, enum: ["broadcast", "direct"], default: "broadcast" },
    // Target driver for direct orders placed after a voice call (concept 1.6)
    targetDriverId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    chatId: { type: mongoose.Schema.Types.ObjectId, ref: "Chat" },
    expiresAt: Date,
    // Booking lifecycle timestamps (set by the state machine)
    bookedAt: Date,
    activatedAt: Date,
    // Read-only share link token ("поделиться поездкой", concept 1.10)
    shareToken: { type: String, index: true },
  },
  { timestamps: true }
);

orderSchema.index({ cityId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model("Order", orderSchema);
