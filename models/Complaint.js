const mongoose = require("mongoose");

const COMPLAINT_TYPES = ["sos", "fraud", "behavior", "safety", "other"];
const COMPLAINT_STATUSES = ["OPEN", "IN_REVIEW", "RESOLVED", "DISMISSED"];

// Complaints and SOS signals go to the region admin (concept 1.9)
const complaintSchema = new mongoose.Schema(
  {
    reporterId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", index: true },
    targetUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    // City the complaint belongs to (order city or reporter's home city);
    // region admins see only complaints of their region
    cityId: { type: mongoose.Schema.Types.ObjectId, ref: "City", index: true },
    type: { type: String, enum: COMPLAINT_TYPES, required: true },
    status: { type: String, enum: COMPLAINT_STATUSES, default: "OPEN", index: true },
    text: { type: String, required: true, maxlength: 1000 },
    resolution: String,
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    // SOS is handled by the city dispatcher on the spot: OPEN -> IN_REVIEW
    // (someone took it) -> RESOLVED/DISMISSED. `takenBy` drives "taken by
    // whom" in the dispatcher banner.
    takenBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    takenAt: Date,
    // Normalised at creation so the order view can offer a direct call
    phone: String,
  },
  { timestamps: true }
);

complaintSchema.index({ type: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model("Complaint", complaintSchema);
