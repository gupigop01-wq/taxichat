import { useEffect, useState } from "react";
import { apiPatch, apiPost } from "./api";
import { withRussianPrefix } from "./phone";
import { IconText } from "./TaxiIcon";

// Driver card: the name passengers see, the callback phone and the car. The
// driver keeps it current himself; the dispatcher only reviews the first
// application (concept 1.5).
const field = "w-full bg-[#0d0d0d] text-white placeholder:text-secondary-text border border-secondary-text/30 rounded-2xl px-3 py-2.5 text-[1.5rem] focus:border-accent focus:outline-none";
const label = "block text-secondary-text text-xs mb-1";

const DriverCard = ({ profile, cityId, refreshMe, onError, onNotice }) => {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ displayName: "", phone: "", about: "", color: "", plate: "", brand: "" });

  useEffect(() => {
    if (!profile) return;
    setForm({
      displayName: profile.displayName ?? "",
      phone: profile.phone ?? "",
      about: profile.about ?? "",
      color: profile.car?.color ?? "",
      plate: profile.car?.plate ?? "",
      brand: profile.car?.brand ?? "",
    });
  }, [profile]);

  if (!profile) return null;

  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      await apiPatch("/api/drivers/me/profile", {
        cityId,
        displayName: form.displayName.trim(),
        phone: withRussianPrefix(form.phone.trim()),
        about: form.about.trim(),
        car: {
          color: form.color.trim(),
          plate: form.plate.trim(),
          ...(form.brand.trim() && { brand: form.brand.trim() }),
        },
      });
      await refreshMe();
      setEditing(false);
      onNotice?.("Анкета водителя обновлена");
    } catch (err) {
      onError?.(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="glass rounded-2xl p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-display font-bold tracking-wide">
          <IconText>🚕 Моя анкета водителя</IconText>
        </h3>
        {!editing && (
          <button
            className="press bg-secondary border border-secondary-text/30 px-3 py-1.5 rounded-xl text-sm font-semibold"
            onClick={() => setEditing(true)}
          >
            Изменить
          </button>
        )}
      </div>

      {editing ? (
        <form className="space-y-2" onSubmit={save}>
          <div>
            <label className={label} htmlFor="drv-name">Имя для пассажиров</label>
            <input
              id="drv-name"
              className={field}
              required
              value={form.displayName}
              onChange={(event) => setForm({ ...form, displayName: event.target.value })}
            />
          </div>
          <div>
            <label className={label} htmlFor="drv-phone">Телефон</label>
            <input
              id="drv-phone"
              className={field}
              type="tel"
              inputMode="tel"
              required
              value={form.phone}
              onChange={(event) => setForm({ ...form, phone: event.target.value })}
            />
          </div>
          <div>
            <label className={label} htmlFor="drv-about">О себе</label>
            <input
              id="drv-about"
              className={field}
              maxLength={160}
              placeholder="Например: стаж 12 лет, езжу аккуратно"
              value={form.about}
              onChange={(event) => setForm({ ...form, about: event.target.value })}
            />
          </div>
          <div className="flex gap-2">
            <div className="flex-1">
              <label className={label} htmlFor="drv-color">Цвет</label>
              <input
                id="drv-color"
                className={field}
                required
                value={form.color}
                onChange={(event) => setForm({ ...form, color: event.target.value })}
              />
            </div>
            <div className="w-32">
              <label className={label} htmlFor="drv-plate">Номер</label>
              <input
                id="drv-plate"
                className={field}
                required
                value={form.plate}
                onChange={(event) => setForm({ ...form, plate: event.target.value })}
              />
            </div>
          </div>
          <div>
            <label className={label} htmlFor="drv-brand">Марка</label>
            <input
              id="drv-brand"
              className={field}
              value={form.brand}
              onChange={(event) => setForm({ ...form, brand: event.target.value })}
            />
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className="press bg-secondary px-3 py-2 rounded-xl text-sm font-semibold flex-1"
              onClick={() => setEditing(false)}
            >
              Отмена
            </button>
            <button
              type="submit"
              className="press btn-accent px-3 py-2 rounded-xl text-sm font-semibold flex-1"
              disabled={busy}
            >
              {busy ? "Сохраняем…" : "Сохранить"}
            </button>
          </div>
        </form>
      ) : (
        <div className="space-y-1 text-sm">
          <div><span className="text-secondary-text">Имя: </span>{profile.displayName}</div>
          <div><span className="text-secondary-text">Телефон: </span>{profile.phone}</div>
          <div><span className="text-secondary-text">Машина: </span>{profile.carCaption || "не указана"}</div>
          {profile.about && <div className="break-words"><span className="text-secondary-text">О себе: </span>{profile.about}</div>}
          <div className="text-xs text-secondary-text">
            Рейтинг: {profile.ratingCount > 0 ? `★ ${profile.rating?.toFixed(1)} · ${profile.ratingCount}` : "пока нет оценок"}
          </div>
        </div>
      )}
    </div>
  );
};

// Leaving a role: the person stops being a driver here. Refused while an
// active ride or a dispatcher's hold keeps him attached.
const LeaveRole = ({ memberships, refreshMe, onError, onNotice, onConfirm }) => {
  const left = memberships
    .filter((membership) => membership.status === "ACTIVE")
    .map((membership) => membership.role)
    .filter((role) => role !== "dispatcher" && role !== "region_admin");
  if (left.length === 0) return null;

  const leave = async (membership) => {
    const ok = await onConfirm?.({
      title: "Выйти из роли?",
      text: "Роль исчезнет из кабинета. Вернуться можно новой заявкой.",
      okText: "Выйти",
      danger: true,
    });
    if (!ok) return;
    try {
      await apiPost(`/api/memberships/${membership._id}`, { leave: true });
      await refreshMe();
      onNotice?.("Вы вышли из роли");
    } catch (err) {
      onError?.(err.message);
    }
  };

  return (
    <div className="glass rounded-2xl p-3 space-y-2">
      <div className="text-xs text-secondary-text">Выйти из роли в этом городе</div>
      <div className="flex flex-wrap gap-2">
        {memberships
          .filter((membership) => membership.status === "ACTIVE" && left.includes(membership.role))
          .map((membership) => (
            <button
              key={membership._id}
              className="press border border-danger text-danger px-3 py-2 rounded-xl text-sm font-semibold"
              onClick={() => leave(membership)}
            >
              Перестать быть {membership.role === "driver" ? "водителем" : "пассажиром"}
            </button>
          ))}
      </div>
    </div>
  );
};

export { DriverCard, LeaveRole };
export default DriverCard;
