const { waitingView } = require("./waiting");

// Order serializers (concept 1.6 / 1.10): exact addresses and the passenger
// name stay hidden from drivers until ASSIGNED. The passenger's phone is
// never exposed to drivers; the driver's phone is added for the assigned
// passenger and dispatchers only.

const canSeeExact = (order, viewerId) => {
  if (viewerId && String(order.passengerId) === String(viewerId)) return true;
  return order.driverId && String(order.driverId) === String(viewerId);
};

const baseView = (order) => ({
  _id: order._id,
  cityId: order.cityId,
  fromZone: order.fromZone,
  toZone: order.toZone,
  from: order.from,
  to: order.to,
  when: order.when,
  pax: order.pax,
  notes: order.notes,
  status: order.status,
  statusLog: order.statusLog,
  // Live free/paid waiting: ticks while WAITING, frozen after the ride starts
  waiting: waitingView(order.waiting),
  // Status before a dispute, so the dispatcher knows what is being decided
  previousStatus:
    order.status === "DISPUTE"
      ? [...(order.statusLog ?? [])].reverse().find((entry) => entry.status !== "DISPUTE")?.status ?? null
      : null,
  matchMode: order.matchMode,
  mode: order.mode,
  createdAt: order.createdAt,
  expiresAt: order.expiresAt,
  chatId: order.chatId,
});

// Passenger sees everything of his own order, plus driver info once assigned
const toPassengerView = (order, { driverProfile } = {}) => {
  const view = {
    ...baseView(order),
    passengerId: order.passengerId,
    exactFrom: order.exactFrom,
    exactTo: order.exactTo,
    priceAgreed: order.priceAgreed,
  };

  if (order.driverId) {
    view.driverId = order.driverId;
    if (driverProfile) {
      view.driver = {
        displayName: driverProfile.displayName,
        carCaption: [
          driverProfile.car?.color,
          driverProfile.car?.plate,
          driverProfile.car?.brand,
        ]
          .filter(Boolean)
          .join(" "),
        // Driver phone becomes visible to the passenger after ASSIGNED
        phone: driverProfile.phone,
      };
    }
  }

  return view;
};

// Driver view: exact addresses and passenger identity are revealed only to
// the assigned driver after ASSIGNED; other drivers keep seeing the card
const toDriverView = (order, { viewerId, passenger } = {}) => {
  const viewerIsAssigned =
    Boolean(order.driverId) &&
    Boolean(viewerId) &&
    String(order.driverId) === String(viewerId);

  const view = {
    ...baseView(order),
    driverId: order.driverId,
    isTarget: order.targetDriverId
      ? String(order.targetDriverId) === String(viewerId)
      : undefined,
    targetDriverId: order.mode === "direct" ? order.targetDriverId : undefined,
  };

  if (viewerIsAssigned) {
    view.exactFrom = order.exactFrom;
    view.exactTo = order.exactTo;
    view.priceAgreed = order.priceAgreed;
    // The passenger name is revealed to the assigned driver only; the
    // passenger's phone is never shown to drivers (concept 1.5)
    view.passengerId = order.passengerId;
    if (passenger) {
      view.passenger = { name: passenger.name };
    }
  }

  return view;
};

// Dispatcher sees everything within his city, including exact addresses and
// both contact phones (he dials them himself; the personal number of the
// dispatcher is never given out, passengers call the city line instead)
const toDispatcherView = (order, { driverProfile, passenger } = {}) => ({
  ...baseView(order),
  passengerId: order.passengerId,
  ...(passenger && {
    passenger: { name: passenger.name, phone: passenger.phone ?? null },
  }),
  exactFrom: order.exactFrom,
  exactTo: order.exactTo,
  priceAgreed: order.priceAgreed,
  driverId: order.driverId,
  targetDriverId: order.targetDriverId,
  ...(driverProfile && {
    driver: {
      displayName: driverProfile.displayName,
      carCaption: [
        driverProfile.car?.color,
        driverProfile.car?.plate,
        driverProfile.car?.brand,
      ]
        .filter(Boolean)
        .join(" "),
      phone: driverProfile.phone,
    },
  }),
});

module.exports = { toPassengerView, toDriverView, toDispatcherView, canSeeExact };
