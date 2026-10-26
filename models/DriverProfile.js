const mongoose = require("mongoose");

// Driver questionnaire and presence state, one per driver membership.
// Only a short car caption is stored ("Белая 456"): color + plate, no documents.
const carSchema = new mongoose.Schema(
  {
    color: { type: String, required: true },
    plate: { type: String, required: true },
    brand: String,
  },
  { _id: false }
);

const driverProfileSchema = new mongoose.Schema(
  {
    membershipId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Membership",
      required: true,
      unique: true,
      index: true,
    },
    // Name shown to passengers
    displayName: { type: String, required: true },
    // +7XXXXXXXXXX, one phone per account; visible to dispatchers and to the
    // passenger of an assigned order only (concept 1.5)
    phone: {
      type: String,
      required: true,
      unique: true,
      match: [/^\+7\d{10}$/, "Телефон должен быть в формате +7XXXXXXXXXX"],
    },
    car: { type: carSchema, required: true },
    shift: { type: String, enum: ["online", "busy", "offline"], default: "offline" },
    // Set when a dispatcher takes the driver off the line: the driver sees why
    shiftNote: { type: String, default: null },
    shiftChangedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    shiftChangedAt: Date,
    lastSeen: Date,
    // Driver can stop accepting direct calls without leaving the shift
    acceptDirectCalls: { type: Boolean, default: true },
    // Short "about the driver" line shown to passengers and dispatchers
    about: { type: String, default: "", maxlength: 160 },
    // Set while a direct call is in progress; hides the driver from the list
    inCall: { type: Boolean, default: false },
    // Cached rating aggregate (avg stars), refreshed on each new rating
    rating: { type: Number, default: null },
    ratingCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("DriverProfile", driverProfileSchema);
