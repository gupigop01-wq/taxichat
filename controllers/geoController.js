const mongoose = require("mongoose");
const Region = require("../models/Region");
const City = require("../models/City");
const Zone = require("../models/Zone");
const Landmark = require("../models/Landmark");
const ApiError = require("../utilities/errors");
const catchAsyncError = require("../utilities/catchAsyncError");

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const cityView = (city) => ({
  _id: city._id,
  name: city.name,
  oktmo: city.oktmo,
  tz: city.tz,
  status: city.status,
  region: city.regionId ? { _id: city.regionId._id, name: city.regionId.name } : null,
  // Public dispatch line of the city: shown on the passenger screen
  dispatchPhone: city.settings?.dispatchPhone ?? null,
  dispatchPhoneNote: city.settings?.dispatchPhoneNote ?? "",
});

// GET /api/geo/regions
exports.getRegions = catchAsyncError(async (req, res) => {
  const query = req.query.query
    ? { name: new RegExp(escapeRegex(req.query.query), "i") }
    : {};
  const regions = await Region.find(query).sort({ name: 1 }).limit(100);
  res.json({ status: "success", data: { regions } });
});

// GET /api/geo/cities?query=&regionId=
exports.getCities = catchAsyncError(async (req, res) => {
  const { query, regionId } = req.query;

  const filter = {};
  if (query) filter.name = new RegExp(escapeRegex(query), "i");
  if (regionId) {
    if (!mongoose.isValidObjectId(regionId))
      throw new ApiError(400, "Некорректный идентификатор региона");
    filter.regionId = regionId;
  }

  const cities = await City.find(filter)
    .populate("regionId", "name")
    .sort({ name: 1 })
    .limit(50);

  res.json({ status: "success", data: { cities: cities.map(cityView) } });
});

// GET /api/geo/cities/:id/zones
exports.getCityZones = catchAsyncError(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id))
    throw new ApiError(400, "Некорректный идентификатор города");

  const city = await City.findById(id);
  if (!city) throw new ApiError(404, "Город не найден");

  const zones = await Zone.find({ cityId: id }).populate("neighbors", "name").sort({ name: 1 });
  res.json({ status: "success", data: { zones } });
});

// GET /api/geo/cities/:id/landmarks?query=
exports.getCityLandmarks = catchAsyncError(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id))
    throw new ApiError(400, "Некорректный идентификатор города");

  const city = await City.findById(id);
  if (!city) throw new ApiError(404, "Город не найден");

  const { query } = req.query;
  const landmarks = query
    ? await Landmark.find({ cityId: id, $text: { $search: query } }).limit(20)
    : await Landmark.find({ cityId: id }).limit(100);

  res.json({ status: "success", data: { landmarks } });
});
