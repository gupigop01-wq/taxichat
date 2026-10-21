const express = require("express");
const uploadController = require("../controllers/uploadController");

const router = express.Router();

router.post("/", uploadController.upload);
router.get("/:filename", uploadController.download);

module.exports = router;
