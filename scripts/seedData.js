const { importGeoData } = require("./geoImport");
const geoSeed = require("../data/geoSeed");
const { recalcCityStatus } = require("../utilities/cityStatus");

// Demo password: old leaked test password triggers Chrome/carrier warnings,
// so demo accounts use a simple phrase that is not in breach databases.
const PASSWORD = "Bombila2026";

// Demo reference data and accounts (concept 1.14: Казань -> PILOT).
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

  const upsertUser = async (data) => {
    await User.deleteOne({ username: data.username });
    return User.create({ ...data, password: PASSWORD, confirmPassword: PASSWORD });
  };

  const upsertMembership = async (data) => {
    await Membership.deleteOne({
      userId: data.userId,
      cityId: data.cityId,
      role: data.role,
    });
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
    name: "Админ Иркутской области",
  });
  const dispatcher = await upsertUser({
    username: "dispatcher",
    name: "Диспетчер Слюдянки",
  });
  const dispatcher2 = await upsertUser({
    username: "dispatcher2",
    name: "Диспетчер Култука",
  });
  const driver1 = await upsertUser({ username: "driver1", name: "Иван Водитель" });
  const driver2 = await upsertUser({ username: "driver2", name: "Пётр Шофёр" });
  const driver3 = await upsertUser({ username: "driver3", name: "Олег Таксист" });
  const passenger = await upsertUser({ username: "passenger", name: "Пассажир Анна" });

  // Слюдянка — основной город: все демо-роли живут здесь, и при входе
  // открывается Слюдянка, а не первый город по алфавиту
  const sludyanka = await City.findOne({ name: "Слюдянка" });
  const kulutk = await City.findOne({ name: "Култук" });
  const sludyankaZones = await Zone.find({ cityId: sludyanka._id }).sort({ name: 1 });
  const kulutkZones = await Zone.find({ cityId: kulutk._id }).sort({ name: 1 });
  await User.updateMany({}, { homeCityId: sludyanka._id });

  await upsertMembership({
    userId: regionadmin._id,
    cityId: sludyanka._id,
    role: "region_admin",
    status: "ACTIVE",
  });
  await upsertMembership({
    userId: dispatcher._id,
    cityId: sludyanka._id,
    role: "dispatcher",
    status: "ACTIVE",
  });
  await upsertMembership({
    userId: dispatcher2._id,
    cityId: kulutk._id,
    role: "dispatcher",
    status: "ACTIVE",
  });

  const driverSpecs = [
    {
      user: driver1,
      membership: { cityId: sludyanka._id, zones: sludyankaZones.slice(0, 2).map((zone) => zone._id) },
      profile: {
        displayName: "Иван",
        phone: "+79001234567",
        car: { color: "Белый", plate: "456", brand: "Lada" },
      },
    },
    {
      user: driver2,
      membership: { cityId: sludyanka._id, zones: [sludyankaZones[0]._id] },
      profile: {
        displayName: "Пётр",
        phone: "+79001234568",
        car: { color: "Чёрный", plate: "789" },
      },
    },
    {
      user: driver3,
      membership: { cityId: sludyanka._id, zones: sludyankaZones.slice(1, 3).map((zone) => zone._id) },
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
    await DriverProfile.deleteOne({ membershipId: membership._id });
    await DriverProfile.create({ membershipId: membership._id, ...spec.profile });
  }

  await upsertMembership({
    userId: passenger._id,
    cityId: sludyanka._id,
    role: "passenger",
    status: "ACTIVE",
  });

  for (const city of [sludyanka, kulutk]) {
    const change = await recalcCityStatus(city._id);
    console.log(`  ${city.name}: ${change.from} -> ${change.to}`);
  }

  return { password: PASSWORD, users: ["passenger", "driver1", "driver2", "driver3", "dispatcher", "regionadmin", "superadmin"] };
};

module.exports = { seedDemoData, PASSWORD };

