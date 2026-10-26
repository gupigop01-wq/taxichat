// Short car caption shown to passengers, e.g. "Белая 456"
const carCaption = (car) =>
  [car.color, car.plate, car.brand].filter(Boolean).join(" ");

// Two drivers of one city must not share the same color+plate pair
const sameCarPair = (a, b) =>
  String(a.car?.color ?? "").trim().toLowerCase() ===
    String(b.car?.color ?? "").trim().toLowerCase() &&
  String(a.car?.plate ?? "").trim().toLowerCase() ===
    String(b.car?.plate ?? "").trim().toLowerCase();

// Phones have a single implementation; re-exported so existing driver imports
// keep working without a second, subtly different normalizer.
module.exports = { carCaption, sameCarPair, normalizePhone: require("./phone").normalizePhone };
