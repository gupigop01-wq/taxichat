import { statusLabel } from "./statusLabels";

// Voice and on-screen notices for order changes, shared by all roles.
// Each notice is spoken (speak: true) and disappears after 60 seconds.
// Notices that carry an orderId also get an "open order" button.
export const orderStatusNotice = (payload) => {
  const label = statusLabel(payload?.status);
  return {
    orderId: payload?.orderId,
    message: `Заказ: ${label}`,
    speakText: `Заказ. ${label}`,
    type: payload?.status === "DISPUTE" ? "error" : "info",
    speak: true,
  };
};

export const newOrderNotice = (order = {}) => ({
  orderId: order.orderId ?? order._id,
  message: "Новый заказ в городе",
  speakText: "Новый заказ в городе",
  type: "info",
  speak: true,
});

export const newOfferNotice = (offer = {}) => ({
  kind: "offer",
  message: "🚕 Новый отклик водителя",
  speakText: `Новый отклик водителя. Цена ${offer.priceText ?? ""}`,
  type: "info",
  speak: true,
  // Offer card: price, arrival time, driver and car, with accept/decline buttons
  offer: {
    orderId: offer.orderId,
    offerId: offer.offerId,
    driverName: offer.driverName,
    priceText: offer.priceText,
    etaMin: offer.etaMin,
    carCaption: offer.carCaption,
  },
});

// New message in an order the user takes part in. Shows the sender, a short
// preview of the text, an "open order" button (orderId) and is spoken aloud.
export const newMessageNotice = (msg = {}) => {
  const who = msg.senderName ?? "Собеседник";
  const preview =
    msg.kind === "photo" ? "📷 фото"
    : msg.kind === "voice" ? "🎤 голосовое"
    : (msg.body ?? "").slice(0, 60);
  return {
    orderId: msg.orderId,
    message: `💬 ${who}: ${preview}`,
    speakText: `Новое сообщение от ${who}. ${msg.kind === "text" || !msg.kind ? msg.body ?? "" : preview}`,
    type: "info",
    speak: true,
  };
};