const Region = require("../models/Region");
const City = require("../models/City");
const Zone = require("../models/Zone");
const Landmark = require("../models/Landmark");
const { tzForRegion } = require("../services/timezones");

// Imports a reference dataset of the shape:
// {
//   regions: [{ name, oktmo? }],
//   cities:  [{ name, oktmo, region, tz?, zones?: [{ name, streets?, neighbors? }], landmarks?: [{ name, zone?, aliases? }] }]
// }
// Everything is upserted: regions by oktmo (fallback name), cities by oktmo,
// zones by (city, name), landmarks by (city, name). Idempotent.
const importGeoData = async (data) => {
  const summary = { regions: 0, cities: 0, zones: 0, landmarks: 0 };

  const regionIds = new Map();
  for (const regionData of data.regions ?? []) {
    const query = regionData.oktmo ? { oktmo: regionData.oktmo } : { name: regionData.name };
    const region = await Region.findOneAndUpdate(
      query,
      { $setOnInsert: { name: regionData.name, ...(regionData.oktmo && { oktmo: regionData.oktmo }) } },
      { upsert: true, new: true }
    );
    regionIds.set(regionData.name, region._id);
    summary.regions += 1;
  }

  for (const cityData of data.cities ?? []) {
    const regionId = regionIds.get(cityData.region);
    if (!regionId) throw new Error(`Unknown region "${cityData.region}" for city "${cityData.name}"`);

    // The dataset may omit tz; the region map still puts the city in the right
    // zone instead of silently defaulting to Moscow time.
    const tz = cityData.tz ?? tzForRegion(cityData.region);
    if (!tz) throw new Error(`Unknown timezone for region "${cityData.region}"`);

    const city = await City.findOneAndUpdate(
      { oktmo: cityData.oktmo },
      {
        $setOnInsert: {
          name: cityData.name,
          oktmo: cityData.oktmo,
          regionId,
          ...(cityData.status && { status: cityData.status }),
          ...(cityData.alwaysActive && { alwaysActive: true }),
        },
        // Re-import corrects a stale zone written by an earlier default
        $set: { tz },
      },
      { upsert: true, new: true }
    );
    summary.cities += 1;

    const zoneIds = new Map();
    for (const zoneData of cityData.zones ?? []) {
      const zone = await Zone.findOneAndUpdate(
        { cityId: city._id, name: zoneData.name },
        { $setOnInsert: { cityId: city._id, name: zoneData.name, streets: zoneData.streets ?? [] } },
        { upsert: true, new: true }
      );
      zoneIds.set(zoneData.name, zone._id);
      summary.zones += 1;
    }

    // Resolve adjacency by zone names within the same city
    for (const zoneData of cityData.zones ?? []) {
      if (!zoneData.neighbors?.length) continue;
      const neighborIds = zoneData.neighbors
        .map((name) => zoneIds.get(name))
        .filter(Boolean);
      await Zone.updateOne(
        { _id: zoneIds.get(zoneData.name) },
        { $addToSet: { neighbors: { $each: neighborIds } } }
      );
    }

    for (const landmarkData of cityData.landmarks ?? []) {
      await Landmark.findOneAndUpdate(
        { cityId: city._id, name: landmarkData.name },
        {
          $setOnInsert: {
            cityId: city._id,
            name: landmarkData.name,
            aliases: landmarkData.aliases ?? [],
            ...(landmarkData.zone && { zoneId: zoneIds.get(landmarkData.zone) }),
          },
        },
        { upsert: true }
      );
      summary.landmarks += 1;
    }
  }

  return summary;
};

module.exports = { importGeoData };
