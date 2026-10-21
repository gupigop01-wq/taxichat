const path = require("path");
const express = require("express");
const mongoose = require("mongoose");
const dotenv = require("dotenv");

// Load .env before app.js reads CLIENT_URL and other settings at import time
dotenv.config({ path: path.join(__dirname, ".env") });

const app = require("./app");

// Serve the prebuilt client (single-port mode); API routes take precedence
app.use(express.static(path.join(__dirname, "client", "build")));
app.get("*", (req, res) => {
  const indexFile = path.join(__dirname, "client", "build", "index.html");
  if (require("fs").existsSync(indexFile)) {
    res.sendFile(indexFile);
  } else {
    // Client build is missing (incomplete install): explain instead of crashing
    res
      .status(503)
      .send("Сборка клиента отсутствует. Выполните: npm run build --prefix client");
  }
});

const start = async () => {
  // Ephemeral in-memory MongoDB for cloud dev environments (Codespaces,
  // Colab): no MONGO_URI and no .env needed, data resets on restart
  if (!process.env.MONGO_URI && process.env.NODE_ENV !== "production") {
    const { MongoMemoryServer } = require("mongodb-memory-server");
    const mms = await MongoMemoryServer.create();
    process.env.MONGO_URI = mms.getUri("taxichat");
    console.log("No MONGO_URI: using in-memory MongoDB (ephemeral)");
  }

  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set. Copy .env.example to .env and configure it.");
    process.exit(1);
  }

  if (!process.env.JWT_SECRET_KEY) {
    if (process.env.NODE_ENV === "production") {
      console.error("JWT_SECRET_KEY is not set. Copy .env.example to .env and configure it.");
      process.exit(1);
    }
    process.env.JWT_SECRET_KEY = "ephemeral-dev-secret";
    console.log("No JWT_SECRET_KEY: using an ephemeral dev secret");
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log("Database connected...");

  // Auto-seed an empty database with demo data (Codespaces / Colab)
  const User = require("./models/User");
  if ((await User.countDocuments()) === 0) {
    console.log("Empty database: seeding demo data...");
    const { seedDemoData } = require("./scripts/seedData");
    await seedDemoData();
  }

  const expressServer = app.listen(process.env.PORT || 4000, () =>
    console.log(`Listening on port ${process.env.PORT || 4000}`)
  );

  if (process.env.NODE_ENV !== "test") {
    const initSocket = require("./socket");
    initSocket(expressServer);

    if (process.env.DISABLE_JOBS !== "1") {
      const { initJobs } = require("./jobs");
      initJobs(process.env.MONGO_URI).catch((error) =>
        console.error("Failed to start background jobs:", error.message)
      );
    }
  }

  // Graceful shutdown: stop the scheduler, close sockets and the server
  const shutdown = async () => {
    console.log("Shutting down...");
    try {
      const { getAgenda } = require("./jobs");
      await getAgenda()?.stop();
    } catch (error) {
      console.error("Agenda stop failed:", error.message);
    }
    expressServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
};

start().catch((error) => {
  console.error("Startup failed:", error.message);
  process.exit(1);
});
