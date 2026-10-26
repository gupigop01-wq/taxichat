const express = require("express");
const rateLimit = require("express-rate-limit");
const authController = require("../controllers/authController");
const accountController = require("../controllers/accountController");
const { validateBody } = require("../utilities/catchAsyncError");
const { protect } = require("../utilities/auth");

const router = express.Router();

// Brute-force protection on credentials endpoints (concept 1.10)
const credentialsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { status: "fail", message: "Слишком много попыток, попробуйте позже" },
  skip: (req) => process.env.NODE_ENV === "test",
});

router.post("/register", credentialsLimiter, validateBody(authController.registerSchema), authController.register);
router.post("/login", credentialsLimiter, validateBody(authController.loginSchema), authController.login);
router.post("/logout", authController.logout);
router.get("/me", protect, authController.me);
// The person edits his own card (name, phone, about) at any time
router.patch("/me", protect, accountController.updateMe);

module.exports = router;
