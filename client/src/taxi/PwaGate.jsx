import { useEffect, useState } from "react";
import TaxiIcon from "./TaxiIcon";

// The app is PWA-only: in a browser tab the user sees an install gate with the
// native install button instead of the application itself.
const isStandalone = () => {
  if (typeof window === "undefined") return true;
  return (
    window.matchMedia?.("(display-mode: standalone)")?.matches ||
    window.matchMedia?.("(display-mode: fullscreen)")?.matches ||
    window.navigator.standalone === true
  );
};

const isIos = () =>
  typeof navigator !== "undefined" &&
  /iphone|ipad|ipod/i.test(navigator.userAgent) &&
  !window.MSStream;

export const usePwaState = () => {
  const [standalone, setStandalone] = useState(isStandalone);
  const [installPrompt, setInstallPrompt] = useState(null);
  const [installed, setInstalled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState(null);

  useEffect(() => {
    const query = window.matchMedia?.("(display-mode: standalone)");
    const onChange = () => setStandalone(isStandalone());
    query?.addEventListener?.("change", onChange);
    const onPrompt = (event) => {
      event.preventDefault();
      setInstallPrompt(event);
    };
    const onInstalled = () => {
      setInstalled(true);
      setStandalone(isStandalone());
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      query?.removeEventListener?.("change", onChange);
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const install = async () => {
    if (installPrompt) {
      setBusy(true);
      try {
        installPrompt.prompt();
        const choice = await installPrompt.userChoice;
        if (choice?.outcome === "accepted") setHint("Устанавливаем приложение…");
        else setHint("Установка отменена. Попробуйте ещё раз.");
      } finally {
        setBusy(false);
        setInstallPrompt(null);
      }
      return;
    }
    // No native prompt (iOS Safari, or the browser hides it): explain the menu
    setHint(
      isIos()
        ? "В Safari нажмите «Поделиться» → «На экран «Домой»»."
        : "Откройте меню Chrome (⋮) → «Установить приложение» / «Добавить на главный экран»."
    );
  };

  return { standalone, installed, busy, hint, install, canInstall: Boolean(installPrompt) };
};

export const InstallGate = ({ state, children }) => {
  if (state.standalone) return children;

  return (
    <div className="install-gate">
      <div className="install-gate-card">
        <div className="install-gate-logo">
          <img src="/icons/icon-192.png" alt="Бомбила" width="88" height="88" />
        </div>
        <div className="brand-title brand-gradient install-gate-title">Бомбила</div>
        <div className="install-gate-sub">такси без посредников</div>

        <p className="install-gate-text">
          Приложение работает с главного экрана: пуш-уведомления о заказах и откликах,
          звонки и озвучка — даже когда оно закрыто. В браузере эти функции недоступны.
        </p>

        <button
          type="button"
          className="press btn-accent install-gate-button"
          onClick={state.install}
          disabled={state.busy}
        >
          <TaxiIcon name="down" size={20} />
          {state.busy ? "Устанавливаем…" : "Установить приложение"}
        </button>

        {state.hint && <div className="install-gate-hint">{state.hint}</div>}

        <ul className="install-gate-points">
          <li>🔔 Уведомления и кнопки «Принять» прямо в шторке</li>
          <li>🔊 Голосовое оповещение о статусе поездки</li>
          <li>📴 Открывается без адресной строки и работает офлайн</li>
        </ul>
      </div>
    </div>
  );
};

export const PwaGate = ({ children }) => {
  const state = usePwaState();
  return <InstallGate state={state}>{children}</InstallGate>;
};

export default PwaGate;
