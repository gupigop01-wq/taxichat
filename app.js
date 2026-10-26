const express = require("express");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const mongoose = require("mongoose");

const app = express();
// One proxy hop (CRA dev proxy or reverse proxy) forwards the client IP in
// X-Forwarded-For; required for correct rate-limit keys
app.set("trust proxy", 1);
const authRouter = require("./routers/authRouter");
const contactsRouter = require("./routers/contactsRouter");
const chatRoomRouter = require("./routers/chatRoomRouter");
const profileRouter = require("./routers/profileRouter");
const uploadRouter = require("./routers/uploadRouter");
const geoRouter = require("./routers/geoRouter");
const pushRouter = require("./routers/pushRouter");
const membershipRouter = require("./routers/membershipRouter");
const dispatchRouter = require("./routers/dispatchRouter");
const applicationRouter = require("./routers/applicationRouter");
const adminRouter = require("./routers/adminRouter");
const driverRouter = require("./routers/driverRouter");
const userRouter = require("./routers/userRouter");
const orderRouter = require("./routers/orderRouter");
const callRouter = require("./routers/callRouter");
const socialRouter = require("./routers/socialRouter");
const citiesRouter = require("./routers/citiesRouter");
const chatRouter = require("./routers/chatRouter");
const aiRouter = require("./routers/aiRouter");
const shareRouter = require("./routers/shareRouter");
const {
  complaintRouter,
  adminComplaintRouter,
} = require("./routers/reputationRouter");
const { protect } = require("./utilities/auth");
const errorController = require("./controllers/errorController");

const allowedOrigins = (process.env.CLIENT_URL ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

// Global API rate limit and a stricter limit on auth endpoints (concept 1.10)
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: (req) => process.env.NODE_ENV === "test",
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { status: "fail", message: "Слишком много попыток, попробуйте позже" },
  skip: (req) => process.env.NODE_ENV === "test",
});

app.use(express.json({ limit: "50mb" }));
app.use(cookieParser());
app.use(
  cors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : true,
    credentials: true,
  })
);

// Public routes (share links and geo city list live outside the auth protector)
app.use(shareRouter);
app.use(globalLimiter);
app.use("/api/geo", geoRouter);
app.use("/api/push", pushRouter);
app.use("/api/user", authRouter);

// Health check with the database connection state (for monitoring)
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    db: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
  });
});

// Protector: verifies JWT cookie on every remaining API route
app.use("/api/*", protect);

app.use("/api/contacts", contactsRouter);
app.use("/api/profile", profileRouter);
app.use("/api/chatRoom", chatRoomRouter);
app.use("/api/upload", uploadRouter);
app.use("/api/uploads", uploadRouter);
app.use("/api/memberships", membershipRouter);
app.use("/api/dispatch", dispatchRouter);
app.use("/api/applications", applicationRouter);
app.use("/api/admin", adminRouter);
app.use("/api/drivers", driverRouter);
app.use("/api/users", userRouter);
app.use("/api/orders", orderRouter);
app.use("/api/calls", callRouter);
app.use("/api/cities", citiesRouter);
app.use("/api/chats", chatRouter);
app.use("/api/ai", aiRouter);
app.use("/api", socialRouter);
app.use("/api/complaints", complaintRouter);
app.use("/api/admin", adminComplaintRouter);

// Error handle middleware
app.use(errorController);

module.exports = app;
