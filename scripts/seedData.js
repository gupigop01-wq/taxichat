const { importGeoData } = require("./geoImport");
const geoSeed = require("../data/geoSeed");
const { recalcCityStatus } = require("../utilities/cityStatus");

// Only the first municipality is the pilot city: it is opened on login and
// holds every demo role (dispatchers, drivers, the passenger).
const PILOT_CITY = "Слюдянка";
// The second one is populated with a dispatcher only: useful for checking the
// concept's cascade across neighbouring municipalities.
const SECOND_CITY = "Култук";

// Demo password: old leaked test password triggers Chrome/carrier warnings,
// so demo accounts use a simple phrase that is not in breach databases.
const PASSWORD = "Bombila2026";

// Demo reference data and accounts (concept 1.14: the pilot municipality).
// Exported so the server can auto-seed an empty ephemeral database
// (Codespaces / Colab testing without an external MongoDB).
const seedDemoData = async () => {
  const User = require("../models/User");
  const City = require("../models/City");
  const Zone = require("../models/Zone");
  const Membership = require("../models/Membership");
  const DriverProfile = require("../models/DriverProfile");

  const summary = await importGeoData(geoSeed);
  console.log(
    `  geo: regions ${summary.regions}, cities ${summary.cities}, zones ${summary.zones}, landmarks ${summary.landmarks}`
  );

  // Every demo account carries a contact phone, as registration requires:
  // the dispatcher calls these numbers on SOS
  let demoPhone = 0;
  const upsertUser = async (data) => {
    await User.deleteOne({ username: data.username });
    demoPhone += 1;
    return User.create({
      phone: `+7900111${String(demoPhone).padStart(4, "0")}`,
      ...data,
      password: PASSWORD,
      confirmPassword: PASSWORD,
    });
  };

  // Memberships are reused when they already exist: deleting them would drop
  // the driver card that references the membership id
  const upsertMembership = async (data) => {
    const existing = await Membership.findOne({
      userId: data.userId,
      cityId: data.cityId,
      role: data.role,
    });
    if (existing) {
      Object.assign(existing, data);
      await existing.save();
      return existing;
    }
    return Membership.create(data);
  };

  console.log("  demo accounts:");
  const superadmin = await upsertUser({
    username: "superadmin",
    name: "Суперадмин Платформы",
    isSuperadmin: true,
  });
  const regionadmin = await upsertUser({
    username: "regionadmin",
    name: `Админ (${PILOT_CITY})`,
  });
  const dispatcher = await upsertUser({
    username: "dispatcher",
    name: `Диспетчер ${PILOT_CITY}`,
  });
  const dispatcher2 = await upsertUser({
    username: "dispatcher2",
    name: `Диспетчер ${SECOND_CITY}`,
  });
  const driver1 = await upsertUser({ username: "driver1", name: "Иван Водитель" });
  const driver2 = await upsertUser({ username: "driver2", name: "Пётр Шофёр" });
  const driver3 = await upsertUser({ username: "driver3", name: "Олег Таксист" });
  const passenger = await upsertUser({ username: "passenger", name: "Пассажир Анна" });

  // The pilot city holds every demo role, so login opens it instead of the
  // first city by alphabet
  const pilot = await City.findOne({ name: PILOT_CITY });
  const second = await City.findOne({ name: SECOND_CITY });
  if (!pilot || !second) {
    throw new Error(`Seed expects the cities ${PILOT_CITY} and ${SECOND_CITY} in data/geoSeed.js`);
  }
  const pilotZones = await Zone.find({ cityId: pilot._id }).sort({ name: 1 });
  const secondZones = await Zone.find({ cityId: second._id }).sort({ name: 1 });
  if (pilotZones.length < 2 || !secondZones.length) {
    throw new Error(`Seed expects zones for ${PILOT_CITY} and ${SECOND_CITY} in data/geoSeed.js`);
  }
  await User.updateMany({}, { homeCityId: pilot._id });

  await upsertMembership({
    userId: regionadmin._id,
    cityId: pilot._id,
    role: "region_admin",
    status: "ACTIVE",
  });
  await upsertMembership({
    userId: dispatcher._id,
    cityId: pilot._id,
    role: "dispatcher",
    status: "ACTIVE",
  });
  await upsertMembership({
    userId: dispatcher2._id,
    cityId: second._id,
    role: "dispatcher",
    status: "ACTIVE",
  });

  const driverSpecs = [
    {
      user: driver1,
      membership: { cityId: pilot._id, zones: pilotZones.slice(0, 2).map((zone) => zone._id) },
      profile: {
        displayName: "Иван",
        phone: "+79001234567",
        car: { color: "Белый", plate: "456", brand: "Lada" },
      },
    },
    {
      user: driver2,
      membership: { cityId: pilot._id, zones: [pilotZones[0]._id] },
      profile: {
        displayName: "Пётр",
        phone: "+79001234568",
        car: { color: "Чёрный", plate: "789" },
      },
    },
    {
      user: driver3,
      membership: { cityId: pilot._id, zones: pilotZones.slice(1, 3).map((zone) => zone._id) },
      profile: {
        displayName: "Олег",
        phone: "+79001234569",
        car: { color: "Серебристый", plate: "321", brand: "Kia" },
      },
    },
  ];

  for (const spec of driverSpecs) {
    const membership = await upsertMembership({
      userId: spec.user._id,
      role: "driver",
      status: "ACTIVE",
      ...spec.membership,
    });
    // Upsert the card instead of delete+create: the phone is unique and the
    // card is the only place where the car lives
    await DriverProfile.findOneAndUpdate(
      { membershipId: membership._id },
      { $set: { membershipId: membership._id, ...spec.profile } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }

  await upsertMembership({
    userId: passenger._id,
    cityId: pilot._id,
    role: "passenger",
    status: "ACTIVE",
  });

  for (const city of [pilot, second]) {
    const change = await recalcCityStatus(city._id);
    console.log(`  ${city.name}: ${change.from} -> ${change.to}`);
  }

  return {
    password: PASSWORD,
    cities: { pilot: PILOT_CITY, second: SECOND_CITY },
    users: ["passenger", "driver1", "driver2", "driver3", "dispatcher", "dispatcher2", "regionadmin", "superadmin"],
  };
};

module.exports = { seedDemoData, PASSWORD, PILOT_CITY, SECOND_CITY };
