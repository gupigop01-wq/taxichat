import { useEffect, useState } from "react";
import { apiPatch } from "./api";
import { withRussianPrefix } from "./phone";
import { IconText } from "./TaxiIcon";

// Personal card of the account: the dispatcher calls this phone on SOS, so it
// lives on the account and is edited here, not in every order
const field = "w-full bg-[#0d0d0d] text-white placeholder:text-secondary-text border border-secondary-text/30 rounded-2xl px-3 py-2.5 text-[1.5rem] focus:border-accent focus:outline-none";
const label = "block text-secondary-text text-xs mb-1";

const AccountCard = ({ me, refreshMe, onError, onNotice }) => {
  const user = me?.user;
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: "", phone: "", bio: "" });

  useEffect(() => {
    if (!user) return;
    setForm({
      name: user.name ?? "",
      phone: user.phone ?? "",
      bio: user.bio ?? "",
    });
  }, [user]);

  const startEdit = () => {
    setForm({
      name: user?.name ?? "",
      phone: user?.phone ?? "",
      bio: user?.bio ?? "",
    });
    setEditing(true);
  };

  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      const payload = { name: form.name.trim() };
      if (form.phone.trim()) payload.phone = withRussianPrefix(form.phone.trim());
      payload.bio = form.bio.trim();
      await apiPatch("/api/user/me", payload);
      await refreshMe();
      setEditing(false);
      onNotice?.("Данные сохранены");
    } catch (err) {
      onError?.(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (!user) return null;

  return (
    <div className="glass rounded-2xl p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-display font-bold tracking-wide">
          <IconText>🪪 {user.name}</IconText>
        </h3>
        {!editing && (
          <button
            className="press bg-secondary border border-secondary-text/30 px-3 py-1.5 rounded-xl text-sm font-semibold"
            onClick={startEdit}
          >
            Изменить
          </button>
        )}
      </div>

      {editing ? (
        <form className="space-y-2" onSubmit={save}>
          <div>
            <label className={label} htmlFor="account-name">Имя</label>
            <input
              id="account-name"
              className={field}
              value={form.name}
              required
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </div>
          <div>
            <label className={label} htmlFor="account-phone">Телефон для связи</label>
            <input
              id="account-phone"
              className={field}
              type="tel"
              inputMode="tel"
              placeholder="+7 902 111-22-33"
              value={form.phone}
              onChange={(event) => setForm({ ...form, phone: event.target.value })}
            />
            <div className="text-xs text-secondary-text mt-1">
              По этому номеру звонит диспетчер. Водителю он не показывается.
            </div>
          </div>
          <div>
            <label className={label} htmlFor="account-bio">О себе</label>
            <input
              id="account-bio"
              className={field}
              maxLength={100}
              placeholder="Короткая строка для других участников"
              value={form.bio}
              onChange={(event) => setForm({ ...form, bio: event.target.value })}
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
          <div>
            <span className="text-secondary-text">Логин: </span>{user.username}
          </div>
          <div>
            <span className="text-secondary-text">Телефон: </span>
            {user.phone ?? <span className="text-danger">не указан</span>}
          </div>
          {user.bio && <div className="break-words"><span className="text-secondary-text">О себе: </span>{user.bio}</div>}
        </div>
      )}
    </div>
  );
};

export default AccountCard;
