import { useEffect, useRef, useState } from "react";
import { useDispatch } from "react-redux";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { authActions } from "../store/authSlice";
import TripsList from "./TripsList";
import OrderChat from "./OrderChat";
import useTaxi from "./useTaxi";
import useOrderNotices from "../hooks/useOrderNotices";
import useCall from "./useCall";
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
  // Sections: "taxi" (role panel), "trips" (Поездки), "cabinet" (Кабинет)
  const [tab, setTab] = useState("taxi");
  const [openTrip, setOpenTrip] = useState(null);
  const [rolePickerOpen, setRolePickerOpen] = useState(false);
  // Accepting an offer in a notice opens the assigned order right away
  useEffect(() => {
    const onOpen = (event) => {
      setTab("trips");
      setOpenTrip(event.detail?.orderId ?? null);
    };
    window.addEventListener("bombila:open-order", onOpen);
    return () => window.removeEventListener("bombila:open-order", onOpen);
  }, []);
  // PWA: service worker + push notification tap relay (opens the order and
  // speaks the summary with the phone's TTS)
  useEffect(() => {
    registerServiceWorker();
    listenForPushTaps((orderId) => {
      setTab("trips");
      setOpenTrip(orderId ?? null);
      window.dispatchEvent(new CustomEvent("bombila:open-order", { detail: { orderId } }));
    });
  }, []);
  // Live voice/on-screen notices for order changes, for every role
  useOrderNotices({ role, userId: user?._id });

  const city = cities.find((item) => String(item._id) === String(cityId));
  const activeCity = city ?? {};
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
          <button className="taxi-avatar press" onClick={() => changeSection("cabinet")} aria-label="Открыть кабинет">
            <TaxiIcon name="profile" size={22} />
          </button>
        </div>
        <h2 className="taxi-heading font-display">{openTrip ? "Заказ" : section.label}</h2>
          <div className="taxi-context-row">
            <CityPicker cities={cities} cityId={cityId} onSelect={setCityId} />
            {activeCity?.dispatchPhone && role !== "dispatcher" && role !== "region_admin" && (
              <a
                className="taxi-role-trigger press"
                href={`tel:${String(activeCity.dispatchPhone).replace(/[^\d+]/g, "")}`}
                aria-label={`Позвонить диспетчеру: ${activeCity.dispatchPhone}`}
                title={activeCity.dispatchPhoneNote || "Диспетчерская"}
              >
                <TaxiIcon name="phone" size={17} />
                <span className="truncate">Диспетчерская</span>
              </a>
            )}
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
          <OrderChat orderId={openTrip} me={me} onBack={() => setOpenTrip(null)} startCall={startCall} />
        ) : tab === "trips" ? (
          <TripsList cityId={cityId} me={me} onOpen={(id) => setOpenTrip(id)} />
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
              className="underline text-sm"
              onClick={() => setTab("cabinet")}
            >
              Или оформите роль водителя / диспетчера
            </button>
          </div>
        ) : role === "driver" ? (
          <DriverPanel
            me={me}
            cityId={cityId}
            driverProfile={driverProfile}
            refreshMe={refreshMe}
            startCall={startCall}
          />
        ) : role === "dispatcher" || role === "region_admin" ? (
          <DispatcherPanel cityId={cityId} role={role} me={me} />
        ) : (
          <ErrorBoundary key={cityId + role}>
            <PassengerPanel
              me={me}
              cityId={cityId}
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

