// Dev-workflow smoke test: boots MongoDB (in-memory), the API server and the
// CRA dev server exactly like the README, then verifies that the CRA proxy
// forwards REST and WebSocket (socket.io) traffic.
const { MongoMemoryServer } = require("mongodb-memory-server");
const { spawn } = require("child_process");
const mongoose = require("mongoose");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForUrl = async (url, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch {}
    await wait(1000);
  }
  throw new Error(`timeout waiting for ${url}`);
};

(async () => {
  const mms = await MongoMemoryServer.create();
  const env = {
    ...process.env,
    MONGO_URI: mms.getUri("taxichat"),
    JWT_SECRET_KEY: "dev-workflow",
    PORT: "4000",
    NODE_ENV: "development",
    DISABLE_JOBS: "1",
    BROWSER: "none",
    CI: "1",
  };

  const api = spawn("node", ["index.js"], { env });
  api.stdout.on("data", (d) => process.stdout.write(`[api] ${d}`));
  api.stderr.on("data", (d) => process.stderr.write(`[api] ${d}`));

  const craLines = [];
  const client = spawn("npm", ["start"], {
    env: { ...env, PORT: "3000" },
    cwd: "client",
    shell: true,
  });
  client.stdout.on("data", (d) => {
    craLines.push(String(d));
    process.stdout.write(`[cra] ${d}`);
  });
  client.stderr.on("data", (d) => {
    craLines.push(String(d));
    process.stderr.write(`[cra] ${d}`);
  });

  try {
    // 1. API is up; seed reference data in-process (seed CLI is covered by tests)
    await waitForUrl("http://localhost:4000/api/health", 30000);
    await mongoose.connect(env.MONGO_URI);
    const { importGeoData } = require("../scripts/geoImport");
    const geoSeed = require("../data/geoSeed");
    await importGeoData(geoSeed);
    const User = require("../models/User");
    const City = require("../models/City");
    const Zone = require("../models/Zone");
    const Membership = require("../models/Membership");
    const DriverProfile = require("../models/DriverProfile");
    const kazan = await City.findOne({ name: "Казань" });
    const zones = await Zone.find({ cityId: kazan._id }).sort({ name: 1 });
    const spec = [
      ["driver1", "Иван", "driver", { displayName: "Иван", phone: "+79001234567", car: { color: "Белый", plate: "456" } }],
      ["dispatcher", "Диспетчер", "dispatcher", null],
    ];
    for (const [username, name, role, profile] of spec) {
      // Recreate users like scripts/seed.js so the bcrypt pre-save hook runs
      await User.deleteOne({ username });
      const user = await User.create({ username, name, password: "Bombila2026", confirmPassword: "Bombila2026" });
      const membership = await Membership.findOneAndUpdate(
        { userId: user._id, cityId: kazan._id, role },
        { $setOnInsert: { userId: user._id, cityId: kazan._id, role, status: "ACTIVE", ...(role === "driver" && { zones: [zones[0]._id] }) } },
        { upsert: true, new: true }
      );
      if (profile) {
        await DriverProfile.findOneAndUpdate(
          { membershipId: membership._id },
          { $setOnInsert: { membershipId: membership._id, ...profile } },
          { upsert: true }
        );
      }
    }
    const passenger = await User.findOneAndUpdate(
      { username: "passenger" },
      { $setOnInsert: { username: "passenger", name: "Пассажир" } },
      { upsert: true, new: true }
    );
    if (!passenger.password || !passenger.password.startsWith("$2")) {
      await User.deleteOne({ username: "passenger" });
      await User.create({
        username: "passenger",
        name: "Пассажир",
        password: "Bombila2026",
        confirmPassword: "Bombila2026",
      });
    }
    await Membership.findOneAndUpdate(
      { userId: passenger._id, cityId: kazan._id, role: "passenger" },
      { $setOnInsert: { userId: passenger._id, cityId: kazan._id, role: "passenger", status: "ACTIVE" } },
      { upsert: true }
    );
    await mongoose.disconnect();
    console.log("SMOKE: seed data ready");

    // 2. CRA dev server is up through its own port
    await waitForUrl("http://localhost:3000/", 240000);
    const html = await (await fetch("http://localhost:3000/")).text();
    console.log("CRA HTML served:", html.includes('<div id="root">'));

    // 3. REST proxies through the CRA dev server
    const proxied = await fetch("http://localhost:3000/api/health");
    console.log("PROXY REST:", JSON.stringify(await proxied.json()));

    // 4. Login through the proxy and check cookies flow back
    const login = await fetch("http://localhost:3000/api/user/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "passenger", password: "Bombila2026" }),
    });
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
    console.log("PROXY LOGIN:", login.status);

    const me = await fetch("http://localhost:3000/api/user/me", {
      headers: { Cookie: cookie },
    });
    console.log("PROXY ME:", me.status);

    // 5. WebSocket (socket.io) through the CRA proxy with cookie auth.
    // Default transports first (polling -> upgrade), like the real client.
    const { io } = require("socket.io-client");
    const socket = io("http://localhost:3000", {
      extraHeaders: { cookie },
    });
    const connected = await new Promise((resolve, reject) => {
      socket.on("connect", () => resolve(true));
      socket.on("connect_error", (err) => reject(new Error(err.message)));
      setTimeout(() => reject(new Error("ws connect timeout")), 20000);
    });
    console.log("PROXY WS connect:", connected);

    socket.emit("user:online");
    await wait(500);
    console.log("PROXY WS auth: ok (no connect_error)");

    socket.close();
    console.log("DEV WORKFLOW OK");
    process.exit(0);
  } catch (error) {
    console.error("DEV WORKFLOW FAILED:", error.message);
    console.error("CRA output tail:\n" + craLines.slice(-30).join(""));
    process.exitCode = 1;
  } finally {
    // Kill the whole process tree (npm → cmd → node react-scripts)
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(client.pid), "/T", "/F"]);
    } else {
      client.kill("SIGTERM");
    }
    api.kill("SIGTERM");
    await wait(1500);
    await mms.stop();
  }
})();

