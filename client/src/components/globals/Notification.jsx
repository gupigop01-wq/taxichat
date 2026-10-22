import React, { useEffect } from "react";
import { useDispatch, useSelector } from "react-redux";
import { notificationActions } from "../../store/notificationSlice";
import { apiPost } from "../../taxi/api";
import { motion, AnimatePresence } from "framer-motion";
import TaxiIcon, { IconText } from "../../taxi/TaxiIcon";

// Auto-dismiss: every notification leaves on its own after this delay.
// Offers (kind "offer") are the exception: they wait for a decision and are
// removed by a status change (removeOfferNotices) or the close button.
const LIFETIME_MS = 60 * 1000;

// Voice: notifications marked speak=true are read aloud (Russian).
// Chrome on Android blocks speechSynthesis until the page has been touched
// (autoplay policy), and voices load asynchronously. So we:
//  - pick a Russian voice once the list is available,
//  - queue the text if speech is still locked and flush it on the first
//    user gesture (tap/click/key), which is what unlocks the synthesizer.
let voices = [];
const loadVoices = () => {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  voices = window.speechSynthesis.getVoices() || [];
};
if (typeof window !== "undefined" && window.speechSynthesis) {
  loadVoices();
  window.speechSynthesis.onvoiceschanged = loadVoices;
}

const pickRussianVoice = () =>
  voices.find((v) => v.lang?.toLowerCase().startsWith("ru")) ||
  voices.find((v) => /russian|русск/i.test(v.name || "")) ||
  null;

let pendingSpeech = [];
let unlocked = false;

// Mark the synthesizer as unlocked on the very first gesture on the page,
// whatever it is, so notices that arrive later speak without extra taps.
const unlockOnce = () => {
  unlocked = true;
  window.removeEventListener("pointerdown", unlockOnce);
  window.removeEventListener("click", unlockOnce);
  window.removeEventListener("keydown", unlockOnce);
  window.removeEventListener("touchstart", unlockOnce);
  flushSpeech();
};
if (typeof window !== "undefined" && window.speechSynthesis) {
  window.addEventListener("pointerdown", unlockOnce);
  window.addEventListener("click", unlockOnce);
  window.addEventListener("keydown", unlockOnce);
  window.addEventListener("touchstart", unlockOnce);
}

function speakNow(text) {
  if (typeof window === "undefined" || !window.speechSynthesis || !text) return;
  try {
    const utterance = new SpeechSynthesisUtterance(text);
    const voice = pickRussianVoice();
    if (voice) utterance.voice = voice;
    utterance.lang = voice?.lang || "ru-RU";
    utterance.rate = 1;
    window.speechSynthesis.speak(utterance);
  } catch (err) {
    // Synthesizer unavailable: keep the app quiet instead of crashing
  }
}

const flushSpeech = () => {
  if (!window.speechSynthesis) return;
  const queue = pendingSpeech;
  pendingSpeech = [];
  queue.forEach((text) => speakNow(text));
};

const speak = (text) => {
  if (typeof window === "undefined" || !window.speechSynthesis || !text) return;
  // Chrome locks speech until the page has been touched: queue until unlocked
  if (!unlocked) {
    pendingSpeech.push(text);
    return;
  }
  // Speak now even without a known voice list: Chrome picks a default voice
  // itself. A Russian voice is only an improvement, not a precondition.
  speakNow(text);
  // If voices arrive later, prefer them for subsequent notices
  if (!voices.length) {
    const prev = window.speechSynthesis.onvoiceschanged;
    window.speechSynthesis.onvoiceschanged = () => {
      if (typeof prev === "function") prev();
      loadVoices();
    };
  }
};

export function NotificationItem({ item, onDismiss }) {
  const dispatch = useDispatch();
  const openOrder = () => {
    if (item.orderId) window.dispatchEvent(new CustomEvent("bombila:open-order", { detail: { orderId: item.orderId } }));
    onDismiss(item.id);
  };

  useEffect(() => {
    // Offers stay until acted on: dismissal, decision, or order status change.
    if (item.kind === "offer") return undefined;
    const timer = setTimeout(() => onDismiss(item.id), LIFETIME_MS);
    return () => clearTimeout(timer);
  }, [item.id]);

  useEffect(() => {
    if (item.speak) speak(item.speakText || item.message);
  }, [item.id]);

  // Offer card: the passenger accepts or declines right from the notice,
  // on any page, without opening the order
  if (item.offer) {
    const { orderId, offerId, driverName, priceText, etaMin, carCaption } = item.offer;
    const accept = async () => {
      try {
        await apiPost(`/api/orders/${orderId}/accept`, { offerId });
        dispatch(notificationActions.removeOfferNotices(orderId));
        // After assignment go straight to this order's page; the spoken
        // "driver assigned" status notice comes over the socket
        window.dispatchEvent(new CustomEvent("bombila:open-order", { detail: { orderId } }));
      } catch (err) {
        // Final rejections (taken driver, handled offer, missing order) close
        // the card; transient failures (network) keep it for another try.
        if ([404, 409, 410].includes(Number(err?.status))) onDismiss(item.id);
        dispatch(notificationActions.addNotification({
          message: `⚠️ ${err.message ?? "Не удалось принять отклик"}`,
          speakText: `Невозможно принять. ${err.message ?? ""}`,
          type: "error",
          speak: true,
        }));
      }
    };
    return (
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0 }}
        className="glass-strong w-full min-w-0 rounded-2xl p-3 space-y-2 border-l-[3px] border-l-cta-icon text-[1.4rem]"
      >
        <div className="font-display font-bold text-[1.5rem]"><TaxiIcon name="driver" className="inline-block align-[-0.2em]" /> Отклик водителя</div>
        <div className="space-y-0.5">
          <div><TaxiIcon name="cash" className="inline-block align-[-0.2em]" /> Цена: <b>{priceText}</b></div>
          <div><TaxiIcon name="eta" className="inline-block align-[-0.2em]" /> Подача через: <b>{etaMin} мин</b></div>
          <div className="break-words"><TaxiIcon name="driver" className="inline-block align-[-0.2em]" /> {driverName ?? "Водитель"}</div>
          {carCaption && <div className="break-words"><TaxiIcon name="road" className="inline-block align-[-0.2em]" /> {carCaption}</div>}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button onClick={() => onDismiss(item.id)} data-testid="notice-decline" className="rounded-xl py-2 bg-white/10 border border-white/10">
            Отказаться
          </button>
          <button onClick={accept} data-testid="notice-accept" className="rounded-xl py-2 btn-accent font-bold">
            Принять
          </button>
        </div>
      </motion.div>
    );
  }


  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className={`glass-strong w-full min-w-0 flex items-center gap-2 rounded-2xl px-3 py-2 text-[1.4rem] border-l-[3px] ${
        item.type === "error" ? "border-l-danger" : "border-l-cta-icon"
      }`}
    >
      <span className="flex-1 min-w-0 break-words"><IconText>{item.message}</IconText></span>
      {item.orderId && (
        <button className="shrink-0 rounded-xl px-2 py-1 btn-accent text-[1.3rem] font-bold" onClick={openOrder}>
          Открыть
        </button>
      )}
      <button
        onClick={() => onDismiss(item.id)}
        className="shrink-0 w-[3rem] h-[3rem] flex items-center justify-center rounded-full text-secondary-text"
        aria-label="Закрыть"
      >
        <TaxiIcon name="close" />
      </button>
    </motion.div>
  );
}

function Notification() {
  const notifications = useSelector((state) => state.notificationReducer);
  const dispatch = useDispatch();
  const dismiss = (id) => dispatch(notificationActions.removeNotification(id));

  return (
    <div className="fixed top-[6rem] left-2 right-2 z-[10000] flex flex-col gap-2 pointer-events-none max-w-[calc(100vw-1rem)] overflow-hidden">
      <AnimatePresence mode="popLayout" initial={false}>
        {notifications.map((item) => (
          <div key={item.id} className="pointer-events-auto w-full min-w-0 max-w-full">
            <NotificationItem item={item} onDismiss={dismiss} />
          </div>
        ))}
      </AnimatePresence>
    </div>
  );
}

export default Notification;
