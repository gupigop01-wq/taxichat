// PWA plumbing: service worker registration, optional Web Push subscription
// (VAPID), and tap-from-notification relay (speak + open order).
import { apiGet, apiPost } from "./api";

const urlBase64ToUint8Array = (base64String) => {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
};

export const registerServiceWorker = async () => {
  if (!("serviceWorker" in navigator)) return null;
  try {
    const registration = await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
    // Hand the build id to the worker: a release changes the cache name, so the
    // next activation drops every asset of the previous bundle
    const version = process.env.REACT_APP_BUILD_ID || document.querySelector('script[src*="main."]')?.src.split("main.")[1]?.split(".")[0];
    if (version) {
      const tell = (worker) => worker?.postMessage({ type: "cache-version", cacheVersion: `bombila-shell-${version}` });
      tell(registration.active);
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        worker?.addEventListener("statechange", () => {
          if (worker.state === "activated") tell(worker);
        });
      });
    }
    return registration;
  } catch (error) {
    console.warn("Service worker registration failed:", error.message);
    return null;
  }
};

// Subscribe the browser to web push. Returns { ok, reason }. Requires a user
// gesture on iOS; safe to call repeatedly (idempotent subscription).
export const enablePushNotifications = async () => {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    return { ok: false, reason: "Push не поддерживается этим браузером" };
  }
  let permission = Notification.permission;
  if (permission === "default") {
    permission = await Notification.requestPermission();
  }
  if (permission !== "granted") {
    return {
      ok: false,
      reason:
        permission === "denied"
          ? "Уведомления заблокированы. Включите их в настройках телефона: Настройки → Приложения → Бомбила → Уведомления."
          : "Разрешение не выдано",
    };
  }

  const registration = await navigator.serviceWorker.ready;
  const { data } = await apiGet("/api/push/vapid-public");
  const applicationServerKey = urlBase64ToUint8Array(data.publicKey);
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ?? (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey }));
  await apiPost("/api/push/subscribe", subscription.toJSON());
  return { ok: true };
};

// Drop the push subscription and forget it on the server, so the phone stops
// receiving order cards. Safe to call when nothing is subscribed.
export const disablePushNotifications = async () => {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription().catch(() => null);
  if (subscription) {
    await apiPost("/api/push/unsubscribe", { endpoint: subscription.endpoint }).catch(() => undefined);
    await subscription.unsubscribe().catch(() => undefined);
  }
};

// Listen for taps on push notifications: focus the app, speak the summary,
// open the order the notification refers to.
export const listenForPushTaps = (handleOpenOrder) => {
  navigator.serviceWorker?.addEventListener("message", (event) => {
    if (event.data?.type !== "bombila-push-open") return;
    if (event.data.speakText && window.speechSynthesis) {
      const utterance = new SpeechSynthesisUtterance(event.data.speakText);
      utterance.lang = "ru-RU";
      window.speechSynthesis.speak(utterance);
    }
    if (event.data.orderId) handleOpenOrder(event.data.orderId);
  });
};
