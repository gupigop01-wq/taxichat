const express = require("express");
const pushService = require("../utilities/pushService");
const PushSubscription = require("../models/PushSubscription");
const { protect } = require("../utilities/auth");

const router = express.Router();

// Public: the browser needs the server's VAPID public key to subscribe
router.get("/vapid-public", (req, res) => {
  const publicKey = pushService.publicKey();
  if (!publicKey) return res.status(503).json({ status: "fail", message: "Push не настроен на сервере" });
  res.json({ status: "success", data: { publicKey } });
});

// Authenticated: save/refresh this browser's push subscription
router.post("/subscribe", protect, async (req, res, next) => {
  try {
    const { endpoint, keys, platform } = req.body ?? {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ status: "fail", message: "Некорректная подписка" });
    }
    await PushSubscription.findOneAndUpdate(
      { endpoint },
      {
        userId: req.user._id,
        endpoint,
        keys,
        platform: platform ?? "web",
      },
      { upsert: true, new: true, runValidators: true }
    );
    res.status(201).json({ status: "success" });
  } catch (error) {
    next(error);
  }
});

router.post("/unsubscribe", protect, async (req, res, next) => {
  try {
    await PushSubscription.deleteOne({
      endpoint: req.body?.endpoint,
      userId: req.user._id,
    });
    res.json({ status: "success" });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
