const mongoose = require("mongoose");
const { isValidTimeZone } = require("../services/time");

const CITY_STATUSES = ["DORMANT", "WAITLIST", "PILOT", "ACTIVE", "SUSPENDED"];
const MATCH_MODES = ["offers", "first_take", "dispatcher"];

const cascadeTimeoutsSchema = new mongoose.Schema(
  {
    // Seconds each cascade step stays exclusive, from the concept (section 1.6)
    favorites: { type: Number, default: 20 },
    zone: { type: Number, default: 60 },
    neighbors: { type: Number, default: 120 },
    city: { type: Number, default: 300 },
    expire: { type: Number, default: 600 }, // 10 minutes to find a driver
  },
  { _id: false }
);

const directCallLimitsSchema = new mongoose.Schema(
  {
    maxConcurrent: { type: Number, default: 1 },
    maxPerHour: { type: Number, default: 10 },
    maxUnansweredPerDriver: { type: Number, default: 3 },
  },
  { _id: false }
);

const settingsSchema = new mongoose.Schema(
  {
    matchMode: { type: String, enum: MATCH_MODES, default: "offers" },
    // City dispatch line: passengers call it from the app ("Позвонить
    // диспетчеру"), so their personal number is never exposed either
    dispatchPhone: { type: String, default: null },
    dispatchPhoneNote: { type: String, maxlength: 80, default: "" },
    cascadeTimeouts: { type: cascadeTimeoutsSchema, default: () => ({}) },
    // Free waiting after the driver presses "Я на месте"; 0 means paid waiting
    // starts immediately. When the window ends, waiting costs the rate below.
    waitingMinutes: { type: Number, default: 10 },
    // Rubles per started minute beyond the free window; 0 disables paid waiting
    waitingPricePerMin: { type: Number, default: 0 },
    preorderLeadMinutes: { type: Number, default: 30 },
    filterContacts: { type: Boolean, default: false },
    autoApproveDrivers: { type: Boolean, default: false },
    directCallsEnabled: { type: Boolean, default: true },
    directCallLimits: { type: directCallLimitsSchema, default: () => ({}) },
    directOrderTimeoutMin: { type: Number, default: 10 },
  },
  { _id: false }
);

// City / populated locality; geography is reference data without maps
const citySchema = new mongoose.Schema(
  {
    oktmo: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    regionId: { type: mongoose.Schema.Types.ObjectId, ref: "Region", index: true },
    // IANA timezone, e.g. Europe/Samara. Every booking is parsed and shown in
    // this zone, so a wrong value shifts rides by hours.
    tz: {
      type: String,
      required: true,
      default: "Europe/Moscow",
      validate: {
        validator: isValidTimeZone,
        message: (props) => `Неизвестный часовой пояс: ${props.value}`,
      },
    },
    status: { type: String, enum: CITY_STATUSES, default: "DORMANT", index: true },
    thresholds: {
      pilotDrivers: { type: Number, default: 3 },
      activeDrivers: { type: Number, default: 10 },
      activeDispatchers: { type: Number, default: 2 },
    },
    settings: { type: settingsSchema, default: () => ({}) },
    // Город, добавленный пользователем вручную (не из справочника):
    // не опускается ниже PILOT, чтобы первый пользователь мог заказывать
    custom: { type: Boolean, default: false, index: true },
    // Город, принудительно активный (например, города Слюдянского района):
    // всегда ACTIVE независимо от порогов
    alwaysActive: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

citySchema.index({ name: 1 });

module.exports = mongoose.model("City", citySchema);
