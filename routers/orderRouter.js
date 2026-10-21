const express = require("express");
const orderController = require("../controllers/orderController");
const callController = require("../controllers/callController");
const reputationController = require("../controllers/reputationController");
const shareController = require("../controllers/shareController");
const { protect } = require("../utilities/auth");
const { loadMemberships } = require("../utilities/rbac");

const router = express.Router();

router.use(protect, loadMemberships);

router.route("/").post(orderController.createOrder);
router.route("/").get(orderController.listOrders);
router.route("/:id").get(orderController.getOrder);
router.route("/:id/action").post(orderController.orderAction);
router.route("/:id/cancel").post(orderController.cancelOrder);
router.route("/:id/dispute").post(orderController.openDispute);
router.route("/:id/resolve").post(orderController.resolveDispute);
router.route("/:id/offers").get(orderController.listOffers);
router.route("/:id/offers").post(orderController.createOffer);
router.route("/:id/accept").post(orderController.acceptOrder);
router.route("/:id/book").post(orderController.bookOrder);
router.route("/:id/activate").post(orderController.activateBooking);
router.route("/:id/assign").post(orderController.assignByDispatcher);
router.route("/:id/messages").get(orderController.listMessages);
router.route("/:id/messages").post(orderController.sendOrderMessage);
router.route("/:id/calls").get(callController.listOrderCalls);
router.route("/:id/decline").post(orderController.declineDirectOrder);
router.route("/:id/republish").post(orderController.republishOrder);
router.route("/:id/read").post(orderController.markOrderRead);
router.route("/:id/rating").post(reputationController.rateOrder);
router.route("/:id/sos").post(reputationController.raiseSos);
router.route("/:id/share").get(shareController.createShareLink);

module.exports = router;
