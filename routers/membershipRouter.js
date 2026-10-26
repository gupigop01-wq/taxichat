const express = require("express");
const membershipController = require("../controllers/membershipController");
const { protect } = require("../utilities/auth");
const { loadMemberships } = require("../utilities/rbac");

const router = express.Router();

router.use(protect, loadMemberships);

router
  .route("/")
  .post(
    membershipController.createMembership
  );
router.route("/mine").get(membershipController.getMyMemberships);
router.patch("/:id", membershipController.updateMembership);
// Leaving a role: same body, { leave: true }, handled by the update above
router.post("/:id", membershipController.updateMembership);

module.exports = router;
