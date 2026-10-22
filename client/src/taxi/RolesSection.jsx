import { useState } from "react";
import { apiPost } from "./api";
import { cityStatusEmoji } from "./statusLabels";
import useSocket from "../hooks/useSocket";
import { enablePushNotifications, disablePushNotifications } from "./pushClient";
import TaxiIcon, { IconText } from "./TaxiIcon";

const ROLE_LABELS = {
  passenger: "🧍 Пассажир",
  driver: "🚕 Водитель",
  dispatcher: "🎧 Диспетчер",
  region_admin: "🗺️ Админ региона",
};

const STATUS_LABELS = {
  WAITLIST: "⏳ в очереди",
  PENDING: "🕓 на проверке",
  ACTIVE: "✅ работает",
  REJECTED: "❌ отклонено",
  SUSPENDED: "⛔ приостановлено",
};

// "Кабинет": the taxi profile — who the user is in the city, how to become a
// driver or a dispatcher (concept 1.5)
const RolesSection = ({ me, cityId, cities, refreshMe, onLogout }) => {
  const { socketEmit } = useSocket();

  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushOn, setPushOn] = useState(() =>
    typeof Notification !== "undefined" && Notification.permission === "granted" && "PushManager" in window
  );

  const togglePush = async () => {
    setPushBusy(true);
    try {
      if (pushOn) {
        await disablePushNotifications();
        setPushOn(false);
        setNotice("Пуш-уведомления выключены");
      } else {
        const result = await enablePushNotifications();
        if (!result.ok) throw new Error(result.reason ?? "Push не включился");
        setPushOn(true);
        setNotice("Пуш-уведомления включены");
      }
    } catch (err) {
      setError(err.message ?? "Не удалось включить push");
    } finally {
      setPushBusy(false);
    }
  };


  const [driverForm, setDriverForm] = useState({
    displayName: "",
    phone: "",
    color: "",
    plate: "",
    brand: "",

  });
  const [dispatcherNote, setDispatcherNote] = useState("");

  const city = cities.find((item) => String(item._id) === String(cityId));
  const memberships = (me?.memberships ?? []).filter(
    (membership) => String(membership.cityId?._id) === String(cityId)
  );
  const driverMembership = memberships.find((membership) => membership.role === "driver");
  const driverProfile = me?.driverProfiles?.find(
    (profile) => String(profile.membershipId) === String(driverMembership?._id)
  );



  const becomePassenger = async () => {
    try {
      await apiPost("/api/memberships", { cityId, role: "passenger" });
      setNotice("Вы записаны пассажиром. Статус зависит от города.");
      await refreshMe();
    } catch (err) {
      setError(err.message);
    }
  };

  const submitDriver = async (event) => {
    event.preventDefault();
    setError(null);
    try {
      await apiPost("/api/memberships", {
        cityId,
        role: "driver",
        displayName: driverForm.displayName,
        phone: driverForm.phone,
        car: {
          color: driverForm.color,
          plate: driverForm.plate,
          ...(driverForm.brand && { brand: driverForm.brand }),
        },
  
      });
      setNotice("📨 Анкета отправлена. Диспетчер проверит её и даст ответ.");
      await refreshMe();
    } catch (err) {
      setError(err.message);
    }
  };

  const submitDispatcher = async (event) => {
    event.preventDefault();
    setError(null);
    try {
      await apiPost("/api/applications", {
        cityId,
        type: "dispatcher",
        ...(dispatcherNote && { note: dispatcherNote }),
      });
      setNotice("📨 Заявка отправлена. Её рассмотрит админ региона.");
      setDispatcherNote("");
    } catch (err) {
      setError(err.message);
    }
  };


  return (
    <div className="p-4 space-y-4 overflow-y-auto h-full max-w-lg mx-auto w-full">
      {error && <div className="text-danger text-sm">{error}</div>}
       {notice && <div className="text-success text-sm"><IconText>{notice}</IconText></div>}

      <div className="glass rounded-2xl p-3">
        <div className="font-semibold mb-1 text-center">
           <IconText>🔔 Уведомления</IconText>
        </div>
        <div className="text-sm text-secondary-text mb-2">
          Пуши о новых заказах, откликах и статусах поездки. Работают и когда приложение закрыто.
        </div>
        <button
          className={`press px-3 py-2 rounded-xl text-sm font-semibold ${pushOn ? "bg-secondary text-secondary-text" : "btn-accent"}`}
          onClick={togglePush}
          disabled={pushBusy}
          aria-pressed={pushOn}
        >
          {pushBusy ? "…"
            : pushOn ? "Выключить пуш-уведомления"
            : "🔔 Включить пуш-уведомления"}
        </button>
      </div>

      <div className="glass rounded-2xl p-3">
        <div className="font-semibold mb-1 text-center">
           <IconText>📍</IconText> {city?.name ?? "—"} <IconText>{cityStatusEmoji(city?.status)}</IconText>
        </div>
        <div className="text-sm text-secondary-text">
           <IconText>Заказать такси можно в городах со статусом ✅ или 🟢.</IconText>
        </div>
      </div>

      <div className="glass rounded-2xl p-3">
         <h3 className="font-display font-bold mb-2 text-center tracking-wide"><IconText>🪪 Мой кабинет</IconText></h3>
        {memberships.length === 0 && (
          <div className="text-sm text-secondary-text mb-2">Пока вы не в такси этого города</div>
        )}
         <div className="space-y-2" aria-label="Роли в выбранном городе">
         {memberships.map((membership) => (
           <div key={membership._id} className="text-sm p-3 bg-primary rounded-xl flex justify-between gap-2 flex-wrap">
              <IconText>{ROLE_LABELS[membership.role]}</IconText> — <IconText>{STATUS_LABELS[membership.status]}</IconText>
            {membership.status === "REJECTED" && membership.reason
              ? ` (${membership.reason})`
              : ""}
           </div>
         ))}
         </div>
        {!memberships.some((membership) => membership.role === "passenger") && (
          <button
            className="btn-accent press px-3 py-1 rounded-xl text-sm font-semibold mt-2"
            onClick={becomePassenger}
          >
             <IconText>🧍 Заказывать такси</IconText>
          </button>
        )}
        {driverProfile && (
          <div className="text-sm text-secondary-text mt-2">
             <IconText>🚗</IconText> {driverProfile.carCaption} · <IconText>📞</IconText> {driverProfile.phone}
          </div>
        )}
      </div>

       {!driverMembership && (
        <form className="glass rounded-2xl p-3 space-y-2" onSubmit={submitDriver}>
           <h3 className="font-display font-bold text-center tracking-wide"><IconText>🚕 Стать водителем</IconText></h3>
          <input
            className="w-full bg-primary p-2 rounded text-sm"
             placeholder="Имя для пассажиров"
            required
            value={driverForm.displayName}
            onChange={(event) => setDriverForm({ ...driverForm, displayName: event.target.value })}
          />
          <input
            className="w-full bg-primary p-2 rounded text-sm"
             placeholder="Телефон +7XXXXXXXXXX"
            required
            value={driverForm.phone}
            onChange={(event) => setDriverForm({ ...driverForm, phone: event.target.value })}
          />
          <div className="flex gap-2">
            <input
              className="flex-1 bg-primary p-2 rounded text-sm"
               placeholder="Цвет"
              required
              value={driverForm.color}
              onChange={(event) => setDriverForm({ ...driverForm, color: event.target.value })}
            />
            <input
              className="w-28 bg-primary p-2 rounded text-sm"
               placeholder="Номер"
              required
              value={driverForm.plate}
              onChange={(event) => setDriverForm({ ...driverForm, plate: event.target.value })}
            />
            <input
              className="w-28 bg-primary p-2 rounded text-sm"
               placeholder="Марка"
              value={driverForm.brand}
              onChange={(event) => setDriverForm({ ...driverForm, brand: event.target.value })}
            />
          </div>
          <button className="btn-accent press px-4 py-2.5 rounded-2xl text-sm font-bold w-full" type="submit">
             <IconText>📨 Отправить анкету</IconText>
          </button>
        </form>
      )}

      {!memberships.some((membership) => membership.role === "dispatcher") && (
        <form className="glass rounded-2xl p-3 space-y-2" onSubmit={submitDispatcher}>
           <h3 className="font-display font-bold text-center tracking-wide"><IconText>🎧 Стать диспетчером</IconText></h3>
          <textarea
            className="w-full bg-primary p-2 rounded text-sm"
             placeholder="Коротко о себе (необязательно)"
            value={dispatcherNote}
            onChange={(event) => setDispatcherNote(event.target.value)}
          />
          <button className="btn-accent press px-4 py-2.5 rounded-2xl text-sm font-bold w-full" type="submit">
             <IconText>📨 Подать заявку</IconText>
          </button>
        </form>
      )}
      {onLogout && (
        <button type="button" className="taxi-logout press" onClick={onLogout}>
          <TaxiIcon name="exit" size={20} /> Выйти из аккаунта
        </button>
      )}
    </div>
  );
};

export default RolesSection;

