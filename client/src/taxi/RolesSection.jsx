import { useState } from "react";
import { apiPost } from "./api";
import AccountCard from "./AccountCard";
import DriverCard, { LeaveRole } from "./DriverCard";
import { useDialog } from "./AppDialog";
import { cityStatusEmoji } from "./statusLabels";
import { withRussianPrefix } from "./phone";
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
  const { confirm } = useDialog();
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);


  const [driverForm, setDriverForm] = useState({
    displayName: "",
    phone: "",
    color: "",
    plate: "",
    brand: "",

  });
  const [dispatcherNote, setDispatcherNote] = useState("");
  // Applications are secondary: the personal card is what people come for
  const [applicationsOpen, setApplicationsOpen] = useState(false);

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

  // One role per city: an application replaces the current role
  const currentRole = memberships.find(
    (membership) => membership.status === "ACTIVE" || membership.status === "PENDING"
  );
  const currentRoleLabel = currentRole ? ROLE_LABELS[currentRole.role] : null;

  const confirmSwitch = async () => {
    if (!currentRole || currentRole.role === "driver") return true;
    return confirm({
      title: "Сменить роль?",
      text: `Сейчас вы ${currentRoleLabel?.replace(/^\S+\s/, "") ?? "другая роль"} в этом городе. Заявка заменит её.`,
      okText: "Сменить роль",
      danger: true,
    });
  };

  const submitDriver = async (event) => {
    event.preventDefault();
    setError(null);
    if (!(await confirmSwitch())) return;
    try {
      await apiPost("/api/memberships", {
        cityId,
        role: "driver",
        displayName: driverForm.displayName,
        phone: withRussianPrefix(driverForm.phone),
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
    if (!(await confirmSwitch())) return;
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

      {/* 1. Кто я: карточка человека, её правят в любой момент */}
      <AccountCard
        me={me}
        refreshMe={refreshMe}
        onError={setError}
        onNotice={setNotice}
      />

      {/* 2. Если я водитель — моя анкета и машина */}
      {driverProfile && (
        <DriverCard
          profile={driverProfile}
          cityId={cityId}
          refreshMe={refreshMe}
          onError={setError}
          onNotice={setNotice}
        />
      )}

      {/* 3. Мои роли в городе */}
      <div className="glass rounded-2xl p-3">
         <h3 className="font-display font-bold mb-2 text-center tracking-wide"><IconText>🎭 Мои роли</IconText></h3>
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
            className="btn-accent press px-3 py-2 rounded-xl text-sm font-semibold mt-2"
            onClick={async () => {
              if (!(await confirmSwitch())) return;
              becomePassenger();
            }}
          >
             <IconText>🧍 Заказывать такси</IconText>
          </button>
        )}
      </div>

      <LeaveRole
        memberships={memberships}
        refreshMe={refreshMe}
        onError={setError}
        onNotice={setNotice}
        onConfirm={confirm}
      />

      <div className="glass rounded-2xl p-3">
        <div className="font-semibold mb-1 text-center">
           <IconText>📍</IconText> {city?.name ?? "—"} <IconText>{cityStatusEmoji(city?.status)}</IconText>
        </div>
        <div className="text-sm text-secondary-text">
           <IconText>Заказать такси можно в городах со статусом ✅ или 🟢.</IconText>
        </div>
      </div>

      <div className="glass rounded-2xl p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-display font-bold tracking-wide"><IconText>📨 Заявки и дополнительные роли</IconText></h3>
          <button
            className="press bg-secondary border border-secondary-text/30 px-3 py-1.5 rounded-xl text-sm font-semibold"
            onClick={() => setApplicationsOpen((open) => !open)}
            aria-expanded={applicationsOpen}
          >
            {applicationsOpen ? "Свернуть" : "Открыть"}
          </button>
        </div>
        <div className="text-xs text-secondary-text">
          Необязательно. В городе у человека одна роль: новая заявка заменит{" "}
          {currentRoleLabel ? `вашу текущую (${currentRoleLabel})` : "текущую роль"}.
        </div>
      </div>

      {applicationsOpen && !driverMembership && (
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

      {applicationsOpen && !memberships.some((membership) => membership.role === "dispatcher") && (
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

