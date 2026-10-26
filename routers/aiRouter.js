const express = require("express");
const aiController = require("../controllers/aiController");
const { protect } = require("../utilities/auth");

const router = express.Router();

router.use(protect);

router.get("/status", aiController.getStatus);
router.get("/chats", aiController.listChats);
router.get("/chat", aiController.getChat);
router.post("/messages", aiController.sendMessage);
router.post("/confirm", aiController.confirm);

module.exports = router;
