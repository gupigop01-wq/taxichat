const express = require("express");
const dispatchController = require("../controllers/dispatchController");
const reputationController = require("../controllers/reputationController");
const cityController = require("../controllers/cityController");
const { protect } = require("../utilities/auth");

const router = express.Router();

router.use(protect);

// SOS center of the city (dispatcher works the signal on the spot)
router.route("/sos/:id/take").post(reputationController.takeCitySos);
router.route("/sos/:id").patch(reputationController.closeCitySos);
router.route("/:cityId/sos").get(reputationController.listCitySos);

// Operational settings of the city (dispatch line)
router.route("/:cityId/settings").get(cityController.getCitySettings);
router.route("/:cityId/dispatch-phone").patch(cityController.setDispatchPhone);
router.route("/:cityId/timers").patch(cityController.setCityTimers);
router
  .route("/:cityId/drivers/:membershipId/offline")
  .patch(cityController.forceDriverOffline);

// Shift summary of the city day and the handover note
router.route("/:cityId/shift").get(cityController.getShiftSummary);
router.route("/:cityId/shift/handover").post(cityController.handoverShift);

router.route("/:cityId/drivers").get(dispatchController.listDrivers);
router.route("/drivers/:membershipId").patch(dispatchController.reviewDriver);

module.exports = router;
