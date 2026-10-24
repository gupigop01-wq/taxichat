const mongoose = require("mongoose");

// Handover note between shifts of the same city: the finishing dispatcher
// tells the next one what is still open (disputes, SOS, waiting bookings).
const shiftHandoverSchema = new mongoose.Schema(
  {
    cityId: { type: mongoose.Schema.Types.ObjectId, ref: "City", required: true, index: true },
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    // Calendar day of the city the shift belongs to (start instant)
    day: { type: Date, required: true, index: true },
    note: { type: String, required: true, maxlength: 1000 },
    // Numbers at the moment of handover, frozen for the journal
    stats: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

shiftHandoverSchema.index({ cityId: 1, createdAt: -1 });

module.exports = mongoose.model("ShiftHandover", shiftHandoverSchema);
