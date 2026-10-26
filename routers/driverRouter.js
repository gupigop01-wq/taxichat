const express = require("express");
const driverController = require("../controllers/driverController");
const reputationController = require("../controllers/reputationController");
const { protect } = require("../utilities/auth");

const router = express.Router();

router.use(protect);

router.route("/me").get(driverController.getMyDriverProfile);
router.route("/me/settings").patch(driverController.updateMySettings);
router.route("/me/profile").patch(driverController.updateMyProfile);
router.route("/:userId/rating").get(reputationController.getDriverRating);

module.exports = router;
