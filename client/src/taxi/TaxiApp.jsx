import { useCallback, useEffect, useRef, useState } from "react";
import { useDispatch } from "react-redux";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { authActions } from "../store/authSlice";
import TripsList from "./TripsList";
import OrderChat from "./OrderChat";
import AiChat from "./AiChat";
import useTaxi from "./useTaxi";
import useSocket from "../hooks/useSocket";
import useOrderNotices from "../hooks/useOrderNotices";
import useCall from "./useCall";
import useBundleRefresh from "./useBundleRefresh";
import CallModal from "./CallModal";
import PassengerPanel from "./PassengerPanel";
import DriverPanel from "./DriverPanel";
import DispatcherPanel from "./DispatcherPanel";
import RolesSection from "./RolesSection";
import { apiPost } from "./api";
import { cityStatusEmoji } from "./statusLabels";
import { registerServiceWorker, listenForPushTaps } from "./pushClient";
import ErrorBoundary from "./ErrorBoundary";
import CityPicker from "./CityPicker";
import PushBell from "./PushBell";
import TaxiIcon, { IconText } from "./TaxiIcon";

// Main Бомбила workspace: city and role switcher, role panels, order chats
// and voice calls.
const ROLE_LABELS = {
  passenger: "Пассажир",
  driver: "Водитель",
  dispatcher: "Диспетчер",
  region_admin: "Админ региона",
};

const ROLE_ICONS = { passenger: "passenger", driver: "driver", dispatcher: "support", region_admin: "map" };
const SECTIONS = [
  { key: "dispatcher", label: "Диспетчер", icon: "support" },
  { key: "taxi", label: "Заказы", icon: "route" },
  { key: "trips", label: "Поездки", icon: "trips" },
  { key: "cabinet", label: "Кабинет", icon: "cabinet" },
];

const pageMotionBase = {
  initial: { opacity: 0, x: 16 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -12 },
  transition: { duration: 0.2, ease: "easeOut" },
};

const TaxiApp = () => {
  const dispatch = useDispatch();
  const { me, user, memberships, cities, cityId, setCityId, role, setRole, driverProfile, error, refreshMe } = useTaxi();
  const { call, startCall, acceptCall, endCall } = useCall();
  const { socket } = useSocket();
  useBundleRefresh();
  // Sections: "dispatcher" (AI chat), "taxi" (role panel), "trips", "cabinet"
  const [tab, setTab] = useState("dispatcher");
  const [openTrip, setOpenTrip] = useState(null);
  const [rolePickerOpen, setRolePickerOpen] = useState(false);
  // Tabs with unseen changes get a "!" mark until the user opens them
  const [tabAlerts, setTabAlerts] = useState({});
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const markTab = useCallback((key) => {
    if (tabRef.current === key) return;
    setTabAlerts((prev) => (prev[key] ? prev : { ...prev, [key]: true }));
  }, []);
  const clearTabAlert = useCallback(
    (key) => setTabAlerts((prev) => (prev[key] ? { ...prev, [key]: false } : prev)),
    []
  );
  // Accepting an offer in a notice opens the assigned order right away
  useEffect(() => {
    const onOpen = (event) => {
      setTab("trips");
      setOpenTrip(event.detail?.orderId ?? null);
      clearTabAlert("trips");
    };
    window.addEventListener("bombila:open-order", onOpen);
    return () => window.removeEventListener("bombila:open-order", onOpen);
  }, [clearTabAlert]);
  // PWA: service worker + push notification tap relay (opens the order and
  // speaks the summary with the phone's TTS)
  useEffect(() => {
    registerServiceWorker();
    listenForPushTaps((orderId) => {
      setTab("trips");
      setOpenTrip(orderId ?? null);
      clearTabAlert("trips");
      window.dispatchEvent(new CustomEvent("bombila:open-order", { detail: { orderId } }));
    });
  }, [clearTabAlert]);
  // Live voice/on-screen notices for order changes, for every role. A driver
  // who is off the line hears nothing about work in the city.
  const onLine = Boolean(driverProfile && driverProfile.shift !== "offline");
  useOrderNotices({ role, userId: user?._id, onLine });

  // The shift comes from the server, and the AI chat or a dispatcher changes it
  // without a reload: follow it so the heartbeat below starts and stops with it.
  useEffect(() => {
    const meId = String(user?._id ?? "");
    if (!meId) return undefined;
    const onShift = (payload) => {
      if (String(payload?.driverId ?? "") !== meId) return;
      refreshMe().catch(() => undefined);
    };
    // A phone that slept through the 90 s window wakes up offline: show it
    const onConnect = () => refreshMe().catch(() => undefined);
    socket.on("connect", onConnect);
    socket.on("driver:shiftChanged", onShift);
    socket.on("driver:presence", onShift);
    return () => {
      socket.off("connect", onConnect);
      socket.off("driver:shiftChanged", onShift);
      socket.off("driver:presence", onShift);
    };
  }, [socket, user?._id, refreshMe]);

  // The shift lives as long as the app is open, not as long as one tab is
  // mounted: a driver put on the line from the AI chat must stay reachable, and
  // jobs/handlers.js ends the shift only when the phone stops beating.
  useEffect(() => {
    if (!onLine) return undefined;
    const beat = () => socket.emit("driver:heartbeat");
    beat();
    const timer = setInterval(beat, 30 * 1000);
    return () => clearInterval(timer);
  }, [onLine, socket]);


  // Attention marks: only tabs the user is not looking at are marked, and
  // opening a tab clears its mark.
  useEffect(() => {
    if (!socket) return undefined;
    const meId = String(user?._id ?? "");
    const staff = role === "dispatcher" || role === "region_admin";
    const onAi = (payload) => {
      if (payload?.message?.senderType === "bot") markTab("dispatcher");
    };
    const onNewOrder = () => {
      if (["driver", "dispatcher", "region_admin"].includes(role)) markTab("taxi");
    };
    const onOffer = () => markTab("taxi");
    const onStatus = (payload) => {
      const participant =
        String(payload?.passengerId) === meId || String(payload?.driverId) === meId;
      if (payload?.scope === "order") {
        if (!participant) return;
        markTab("taxi");
        markTab("trips");
        return;
      }
      // City-scope events change the dispatcher's operational picture only
      if (staff) markTab("taxi");
    };
    const onMessage = (payload) => {
      if (!payload?.orderId) return;
      if (
        window.__bombilaOpenOrderId != null &&
        String(window.__bombilaOpenOrderId) === String(payload.orderId)
      )
        return;
      markTab("trips");
    };
    const onMembership = () => markTab("cabinet");
    const onSos = () => {
      if (staff) markTab("taxi");
    };
    socket.on("ai:message", onAi);
    socket.on("order:new", onNewOrder);
    socket.on("order:offer", onOffer);
    socket.on("order:status", onStatus);
    socket.on("order:message", onMessage);
    socket.on("membership:updated", onMembership);
    socket.on("sos:raised", onSos);
    socket.on("sos:taken", onSos);
    socket.on("sos:closed", onSos);
    return () => {
      socket.off("ai:message", onAi);
      socket.off("order:new", onNewOrder);
      socket.off("order:offer", onOffer);
      socket.off("order:status", onStatus);
      socket.off("order:message", onMessage);
      socket.off("membership:updated", onMembership);
      socket.off("sos:raised", onSos);
      socket.off("sos:taken", onSos);
      socket.off("sos:closed", onSos);
    };
  }, [socket, role, user?._id, markTab]);

  const city = cities.find((item) => String(item._id) === String(cityId));
  const section = SECTIONS.find((item) => item.key === tab) ?? SECTIONS[0];
  const reduceMotion = useReducedMotion();

  // The open order belongs to the city it was opened from: switching the city
  // closes the detail view so the header and the content never disagree.
  useEffect(() => {
    setOpenTrip(null);
  }, [cityId]);
  const availableRoles = ["passenger", "driver", "dispatcher", "region_admin"].filter(
    (r) =>
      memberships.some(
        (m) => m.role === r && m.status === "ACTIVE" && String(m.cityId?._id) === String(cityId)
      )
  );
  // Superadmin manages any city without memberships
  if (user?.isSuperadmin && !availableRoles.includes("dispatcher")) {
    availableRoles.push("dispatcher");
  }

  const changeSection = (next) => {
    clearTabAlert(next);
    if (tab === next && !openTrip) return;
    setOpenTrip(null);
    setTab(next);
  };

  const logout = async () => {
    await fetch("/api/user/logout", { method: "POST", credentials: "include" });
    dispatch(authActions.logout());
    window.location.reload();
  };

  // Keyboard guarantee: when any field gets focus, pull the bottom of the
  // content (composer / chat input) into the visible area. Chrome hands us a
  // shrunken layout viewport; hiding rails and compacting the header gives the
  // composer room, and this scroll keeps it reachable in every case.
  const contentRef = useRef(null);
  const bringBottomIntoView = () => {
    const view = contentRef.current;
    if (!view) return;
    requestAnimationFrame(() => {
      view.scrollTop = view.scrollHeight;
      setTimeout(() => {
        view.scrollTop = view.scrollHeight;
      }, 350);
    });
  };
  const onFocusOrClick = (event) => {
    const el = event.target;
    const isField = el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
    if (isField) bringBottomIntoView();
  };

  return (
    <div className="taxi-shell w-full h-full flex flex-col">
      <header className="taxi-header sticky top-0 z-30 px-4 pt-3 pb-3">
        <div className="taxi-header-row">
          <div className="min-w-0">
            <div className="flex flex-col gap-1">
              <h1 className="m-0"><span className="brand-title brand-gradient inline-block">Бомбила</span></h1>
              <span className="text-[1.2rem] text-secondary-text tracking-wide">такси без посредников</span>
            </div>
          </div>
          <div className="taxi-header-tools">
            <PushBell />
            <button className="taxi-avatar press" onClick={() => changeSection("cabinet")} aria-label="Открыть кабинет">
              <TaxiIcon name="profile" size={22} />
            </button>
          </div>
        </div>
        <h2 className="taxi-heading font-display">{openTrip ? "Заказ" : section.label}</h2>
          <div className="taxi-context-row">
            <CityPicker cities={cities} cityId={cityId} onSelect={setCityId} />
          <div className="taxi-context-actions">
          {availableRoles.length > 1 ? (
            <div className="taxi-role-anchor">
              <button className="taxi-role-trigger press" onClick={() => setRolePickerOpen((value) => !value)}
                aria-expanded={rolePickerOpen} aria-label="Сменить роль">
                <TaxiIcon name={ROLE_ICONS[role] ?? "passenger"} size={19} />
                <span className="truncate">{ROLE_LABELS[role] ?? "Роль"}</span>
                <TaxiIcon name={rolePickerOpen ? "up" : "down"} size={15} />
              </button>
              <AnimatePresence>
                {rolePickerOpen && (
                  <motion.div className="taxi-role-menu" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.16 }}>
                    {availableRoles.map((r) => (
                      <button key={r} className={role === r ? "is-current" : ""}
                        onClick={() => { setRole(r); setRolePickerOpen(false); changeSection("taxi"); }}>
                        <TaxiIcon name={ROLE_ICONS[r]} size={19} /> {ROLE_LABELS[r]}
                      </button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          ) : <div className="taxi-role-static"><TaxiIcon name={ROLE_ICONS[role] ?? "passenger"} size={18} /> {ROLE_LABELS[role] ?? "Роль"}</div>}
          </div>
        </div>
      </header>

      {error && <div className="text-danger text-sm px-4 py-1">{error}</div>}

      <main ref={contentRef} className="taxi-content flex-1 min-h-0 overflow-hidden" onFocus={onFocusOrClick} onClick={onFocusOrClick}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={openTrip ? `trip-${openTrip}` : `${tab}-${role}-${cityId}`}
            {...(reduceMotion
              ? { initial: false, animate: {}, exit: {} }
              : pageMotionBase)}
            className="h-full min-h-0 overflow-hidden"
          >
          <ErrorBoundary>
        {tab === "trips" && openTrip ? (
          <OrderChat orderId={openTrip} me={me} cityTz={city?.tz} onBack={() => setOpenTrip(null)} startCall={startCall} />
        ) : tab === "trips" ? (
          <TripsList cityId={cityId} cityTz={city?.tz} me={me} onOpen={(id) => setOpenTrip(id)} />
        ) : tab === "cabinet" ? (
          <RolesSection me={me} cityId={cityId} cities={cities} refreshMe={refreshMe} onLogout={logout} />
        ) : !cityId ? (
          <div className="p-6 text-secondary-text">Выберите город</div>
        ) : availableRoles.length === 0 ? (
          <div className="p-6 space-y-2">
            <div className="text-secondary-text">
              В городе {city?.name ?? ""} вы пока не в такси.
              Статус города: <IconText>{cityStatusEmoji(city?.status)}</IconText>.
            </div>
            <button
              className="btn-accent press px-4 py-2 rounded-2xl text-sm font-bold"
              onClick={async () => {
                try {
                  await apiPost("/api/memberships", { cityId, role: "passenger" });
                  await refreshMe();
                } catch (err) {
                  // Passenger may already exist; ignore duplicate errors
                }
              }}
            >
              Стать пассажиром в этом городе
            </button>
            <button
              className="press bg-secondary border border-secondary-text/30 px-3 py-2 rounded-xl font-semibold text-sm"
              onClick={() => setTab("cabinet")}
            >
              Или оформите роль водителя / диспетчера
            </button>
          </div>
        ) : tab === "dispatcher" ? (
          <ErrorBoundary key={`ai-${cityId}-${role}`}>
            <AiChat cityId={cityId} cityName={city?.name} role={role} />
          </ErrorBoundary>
        ) : role === "driver" ? (
          <DriverPanel
            me={me}
            cityId={cityId}
            cityTz={city?.tz}
            driverProfile={driverProfile}
            refreshMe={refreshMe}
            startCall={startCall}
          />
        ) : role === "dispatcher" || role === "region_admin" ? (
          <DispatcherPanel cityId={cityId} cityTz={city?.tz} role={role} me={me} />
        ) : (
          <ErrorBoundary key={cityId + role}>
            <PassengerPanel
              me={me}
              cityId={cityId}
              cityTz={city?.tz}
              cityName={(cities.find((c) => String(c._id) === String(cityId)) ?? {}).name}
              cityNames={cities.map((c) => c.name)}
              refreshMe={refreshMe}
              startCall={startCall}
            />
          </ErrorBoundary>
        )}
          </ErrorBoundary>
          </motion.div>
        </AnimatePresence>
      </main>

      <nav className="taxi-tabbar" aria-label="Основная навигация">
        {SECTIONS.map((item) => (
          <button key={item.key} className={`taxi-tab press ${tab === item.key ? "is-active" : ""}`}
            aria-current={tab === item.key ? "page" : undefined} onClick={() => changeSection(item.key)}>
            {tab === item.key && <motion.span layoutId="taxi-tab-active" className="taxi-tab-active"
              transition={{ type: "spring", stiffness: 440, damping: 38 }} />}
            {tabAlerts[item.key] && tab !== item.key && (
              <span className="taxi-tab-alert" role="status" aria-label="Есть изменения">!</span>
            )}
            <TaxiIcon name={item.icon} size={23} />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>


      <CallModal call={call} acceptCall={acceptCall} endCall={endCall} />
    </div>
  );
};

export default TaxiApp;

