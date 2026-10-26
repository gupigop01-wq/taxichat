// One-off (and idempotent) repair of city timezones: earlier imports left
// every city on the schema default "Europe/Moscow", which shifted bookings in
// Irkutsk and any other region by hours. Re-derives the zone from the region.
//   node scripts/fixCityTimezones.js [--dry-run]
const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const City = require("../models/City");
require("../models/Region");
const { tzForRegion } = require("../services/timezones");

const dryRun = process.argv.includes("--dry-run");

(async () => {
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set");
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);
  const cities = await City.find().populate("regionId", "name").sort({ name: 1 });

  let changed = 0;
  let unknown = 0;
  for (const city of cities) {
    const tz = tzForRegion(city.regionId?.name);
    if (!tz) {
      unknown += 1;
      console.log(`? ${city.name} (${city.regionId?.name ?? "без региона"}): ${city.tz}`);
      continue;
    }
    if (city.tz === tz) continue;
    console.log(`${dryRun ? "~" : "✓"} ${city.name}: ${city.tz} -> ${tz}`);
    if (!dryRun) {
      city.tz = tz;
      await city.save();
    }
    changed += 1;
  }

  console.log(
    `${dryRun ? "Would update" : "Updated"} ${changed} of ${cities.length} cities; ${unknown} without a region map`
  );
  await mongoose.disconnect();
})().catch(async (error) => {
  console.error(error.message);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
