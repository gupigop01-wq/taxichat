import { useCallback, useEffect, useState } from "react";
import TaxiIcon from "./TaxiIcon";
import { useDialog } from "./AppDialog";
import { enablePushNotifications, disablePushNotifications } from "./pushClient";

const isSupported = () =>
  typeof window !== "undefined" &&
  "Notification" in window &&
  "serviceWorker" in navigator &&
  "PushManager" in window;

// Permission alone is not enough: without a live subscription the phone gets
// nothing, so the bell counts as "off" until both are in place.
const readState = async () => {
  if (!isSupported()) return { supported: false, on: false };
  let subscribed = false;
  try {
    const registration = await navigator.serviceWorker.ready;
    subscribed = Boolean(await registration.pushManager.getSubscription());
  } catch {
    subscribed = false;
  }
  return { supported: true, on: Notification.permission === "granted" && subscribed };
};

// Header control that turns device push on and off; the cabinet no longer carries it.
const PushBell = () => {
  const { confirm } = useDialog();
  // on === null while the first read is in flight, so the hint does not flash
  // for people who already have notifications working.
  const [state, setState] = useState(() => ({ supported: isSupported(), on: null }));
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setState(await readState());
  }, []);

  useEffect(() => {
    refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", refresh);
    // Permission can be changed in Chrome settings while the app stays open
    const timer = setInterval(refresh, 15000);
    let permissionStatus = null;
    navigator.permissions
      ?.query?.({ name: "notifications" })
      .then((status) => {
        permissionStatus = status;
        status.addEventListener?.("change", refresh);
      })
      .catch(() => undefined);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", refresh);
      clearInterval(timer);
      permissionStatus?.removeEventListener?.("change", refresh);
    };
  }, [refresh]);

  const turnOff = async () => {
    const agreed = await confirm({
      title: "Выключить уведомления?",
      text: "Телефон перестанет получать карточки заказов, пока не включите снова.",
      okText: "Выключить",
      cancelText: "Оставить",
      danger: true,
    });
    if (!agreed) return;
    setBusy(true);
    try {
      await disablePushNotifications();
    } catch (error) {
      await confirm({
        title: "Не удалось выключить",
        text: error?.message ?? "Браузер не отдал push-подписку.",
        okText: "Понятно",
        cancelText: null,
      });
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const turnOn = async () => {
    setBusy(true);
    try {
      const result = await enablePushNotifications();
      if (!result.ok) {
        await confirm({
          title: "Уведомления не включились",
          text: result.reason ?? "Разрешите уведомления в настройках браузера.",
          okText: "Понятно",
          cancelText: null,
        });
      }
    } catch (error) {
      await confirm({
        title: "Уведомления не включились",
        text: error?.message ?? "Не удалось включить уведомления. Попробуйте ещё раз.",
        okText: "Понятно",
        cancelText: null,
      });
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const onClick = () => {
    if (busy) return;
    if (state.on) return turnOff();
    return turnOn();
  };

  const on = state.on === true;

  return (
    <div className="taxi-push">
      <button
        type="button"
        className={`taxi-avatar taxi-bell press${on ? " is-on" : ""}`}
        onClick={onClick}
        disabled={busy}
        aria-pressed={on}
        aria-label={on ? "Уведомления включены" : "Включить уведомления"}
        title={on ? "Уведомления включены — нажмите, чтобы выключить" : "Включить уведомления"}
      >
        <TaxiIcon name="bell" size={22} />
      </button>
      {state.supported && state.on === false && (
        <button
          type="button"
          className="push-hint"
          onClick={onClick}
          aria-hidden="true"
          tabIndex={-1}
        >
          <span className="push-hint-bubble">Включите/разрешите уведомления этой кнопкой</span>
          <span className="push-hint-hand" aria-hidden="true">👆</span>
        </button>
      )}
    </div>
  );
};

export default PushBell;
