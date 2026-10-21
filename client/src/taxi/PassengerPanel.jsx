import { useEffect, useState } from "react";
import { useDispatch } from "react-redux";
import { notificationActions } from "../store/notificationSlice";
import { apiGet, apiPost, apiDelete } from "./api";
import useSocket from "../hooks/useSocket";
import OrderChat from "./OrderChat";
import DirectChat from "./DirectChat";
import ChatList from "./ChatList";
import AddressInput from "./AddressInput";
import TimePicker from "./TimePicker";
import { statusBadge, formatWhen, defaultScheduledAt } from "./statusLabels";
import TaxiIcon, { IconText } from "./TaxiIcon";

// Passenger panel, mobile-first: the order composer sits at the BOTTOM of the
// screen like a messenger input; recent orders fill the scrollable area above.
const ACTIVE_STATUSES = ["DRAFT", "PUBLISHED", "ASSIGNED", "ARRIVING", "WAITING", "IN_RIDE", "DISPUTE"];

const PassengerPanel = ({ me, cityId, cityName, cityNames, refreshMe, startCall }) => {
  const dispatch = useDispatch();
  const { socketListen, socket } = useSocket();
  const [view, setView] = useState(null); // { type: "order" | "direct", id }
  const [orders, setOrders] = useState([]);
  const [ordersFilter, setOrdersFilter] = useState("active");
  const [drivers, setDrivers] = useState([]);
  const [favorites, setFavorites] = useState([]);
  const [tab, setTab] = useState("new");
  const [error, setError] = useState(null);
  const [directTarget, setDirectTarget] = useState(null);

  // Композер заказа: маршрут одной строкой, сейчас или на время
  const [route, setRoute] = useState("");
  const [notes, setNotes] = useState("");
  const [whenType, setWhenType] = useState("now");
  const [whenAt, setWhenAt] = useState(defaultScheduledAt());
  const [timeOpen, setTimeOpen] = useState(false);
  const [sending, setSending] = useState(false);

  const load = async () => {
    try {
      const ordersRes = await apiGet(`/api/orders?cityId=${cityId}`);
      setOrders(ordersRes.data.orders);
      const driversRes = await apiGet(`/api/cities/${cityId}/free-drivers`);
      setDrivers(driversRes.data.drivers);
      const favoritesRes = await apiGet("/api/favorites");
      setFavorites(favoritesRes.data.favorites);
    } catch (err) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
    const onStatusChanged = (payload) => {
      // Voice and the on-screen notice come from useOrderNotices; refresh data only
      load();
    };
    const onMembershipUpdated = () => refreshMe();
    socketListen("order:status", onStatusChanged);
    socketListen("membership:updated", onMembershipUpdated);
    return () => {
      socket.off("order:status", onStatusChanged);
      socket.off("membership:updated", onMembershipUpdated);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cityId]);

  if (view?.type === "order") {
    return <OrderChat orderId={view.id} me={me} onBack={() => setView(null)} startCall={startCall} />;
  }
  if (view?.type === "direct") {
    return <DirectChat chatId={view.id} me={me} onBack={() => setView(null)} />;
  }

  const submit = async (event) => {
    event.preventDefault();
    if (!route.trim() || sending) return;
    setError(null);
    setSending(true);
    try {
      const res = await apiPost("/api/orders", {
        cityId,
        route: route.trim(),
        ...(notes.trim() && { notes: notes.trim() }),
        ...(whenType === "scheduled" && {
          whenType: "scheduled",
          whenAt: new Date(whenAt).toISOString(),
        }),
        ...(directTarget && {
          targetDriverId: directTarget.driverId,
          chatId: directTarget.chatId,
        }),
      });
      setDirectTarget(null);
      setRoute("");
      setNotes("");
      setWhenType("now");
      setWhenAt(defaultScheduledAt());
      setTab("orders");
      dispatch(
        notificationActions.addNotification({
          message:
            whenType === "scheduled"
              ? "Заказ на время создан и виден водителям"
              : "Заказ создан, ищем водителя",
          type: "success",
        })
      );
      setView({ type: "order", id: res.data.order._id });
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  };

  const callDriver = async (driver) => {
    startCall({
      kind: "direct",
      target: String(driver.driverId),
      cityId,
      name: driver.displayName,
      fromRole: "passenger",
      onAck: ({ chatId }) =>
        setDirectTarget({
          driverId: String(driver.driverId),
          driverName: driver.displayName,
          chatId,
        }),
    });
  };

  const toggleFavorite = async (driver) => {
    try {
      if (driver.isFavorite) {
        await apiDelete(`/api/favorites/${driver.driverId}`);
      } else {
        await apiPost("/api/favorites", { driverId: driver.driverId });
      }
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const driverCard = (driver, extra = {}) => (
    <div key={driver.driverId} className="glass anim-rise rounded-2xl p-3 text-sm text-center">
      <div className="font-semibold text-center">{driver.displayName}</div>
      <div className="text-secondary-text">{driver.carCaption}</div>
       {driver.rating != null && <div><TaxiIcon name="starFilled" className="inline-block align-[-0.2em]" /> {driver.rating}</div>}
      {extra.children}
    </div>
  );

  const routeTitle = (order) =>
    order.to?.text ? `${order.from?.text} → ${order.to?.text}` : order.from?.text;

  const orderCard = (order) => (
    <button
      key={order._id}
      className="press w-full text-left glass rounded-2xl p-4 text-[1.5rem]"
      onClick={() => setView({ type: "order", id: order._id })}
      aria-label={`Открыть заказ: ${routeTitle(order)}, ${order.status}`}
    >
      <div className="flex items-start gap-2">
        <div className="order-card-title min-w-0 break-words">{routeTitle(order)}</div>
        {order.unreadCount > 0 && (
          <span className="ml-auto bg-danger text-white rounded-full px-2 text-xs shrink-0" aria-label={`Новых сообщений: ${order.unreadCount}`}>
            {order.unreadCount}
          </span>
        )}
      </div>
      {order.driver?.displayName && (
        <div className="text-[1.3rem] text-primary-text">
          <IconText>🚕</IconText> {order.driver.displayName}
          {order.driver.carCaption ? ` · ${order.driver.carCaption}` : ""}
        </div>
      )}
<div className="text-secondary-text mt-1">
         <IconText>{statusBadge(order.status)}</IconText> · {formatWhen(order.when)}
      </div>
      <div className="mt-1 text-cta-icon text-[1.2rem] font-semibold">Открыть заказ →</div>
    </button>
  );

  const activeOrders = orders.filter((order) => ACTIVE_STATUSES.includes(order.status));
  const shownOrders = ordersFilter === "all" ? orders : activeOrders;

  return (
    <div className="flex flex-col h-full max-w-[42rem] mx-auto w-full">
      {/* Табы */}
      <div className="taxi-subnav shrink-0 px-3 pt-3 pb-2 flex gap-2 text-sm overflow-x-auto hide-scrollbar">
        {[
          ["new", "🚕 Заказ"],
          ["orders", "📋 Мои заказы"],
          ["drivers", "🧑‍✈️ Водители"],
          ["favorites", "⭐ Избранные"],
          ["dialogs", "💬 Диалоги"],
        ].map(([key, label]) => (
          <button
            key={key}
            className={`taxi-subtab press ${
              tab === key ? "is-active" : ""
            }`}
            aria-current={tab === key ? "page" : undefined}
            onClick={() => setTab(key)}
          >
             <IconText>{label}</IconText>
          </button>
        ))}
      </div>

      {error && <div className="shrink-0 text-danger text-sm text-center px-4">{error}</div>}

      {/* Прокручиваемая область */}
      <div key={tab} className="taxi-panel-enter flex-1 overflow-y-auto px-4 pb-4 space-y-2">
        {tab === "new" && (
          <>
            {activeOrders.length > 0 ? (
              <>
                <div className="text-xs text-secondary-text text-center">Ваши активные заказы</div>
                {activeOrders.map(orderCard)}
              </>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-center gap-2 py-10">
                 <TaxiIcon name="route" size={36} className="text-cta-icon" />
                <div className="text-secondary-text text-sm">
                  Напишите маршрут ниже — водители города получат заказ
                </div>
              </div>
            )}
          </>
        )}

        {tab === "orders" && (
          <>
            <div className="flex gap-2 text-sm justify-center">
              {[
                ["active", "Активные"],
                ["all", "Все"],
              ].map(([key, label]) => (
                <button
                  key={key}
                  className={`px-3 py-1.5 rounded-full ${
                    ordersFilter === key
                      ? "bg-accent text-black font-semibold"
                      : "bg-secondary text-secondary-text"
                  }`}
                  onClick={() => setOrdersFilter(key)}
                >
                  {label}
                </button>
              ))}
            </div>
            {shownOrders.length === 0 && (
              <div className="text-secondary-text text-sm text-center">Заказов пока нет</div>
            )}
            {shownOrders.map(orderCard)}
          </>
        )}

        {tab === "drivers" && (
          <>
            {drivers.length === 0 && (
              <div className="text-secondary-text text-sm text-center">
                Сейчас все водители заняты или не на линии
              </div>
            )}
            {drivers.map((driver) =>
              driverCard(driver, {
                children: (
                  <div className="flex gap-2 mt-2">
                    <button
                      className="bg-success text-white px-3 py-2 rounded-xl press font-semibold flex-1"
                      onClick={() => callDriver(driver)}
                    >
                      Позвонить
                    </button>
                    <button
                      className="border border-secondary-text/40 px-3 py-2 rounded-lg"
                      onClick={() => toggleFavorite(driver)}
                    >
                       <IconText>{driver.isFavorite ? "★ В избранных" : "☆ В избранные"}</IconText>
                    </button>
                  </div>
                ),
              })
            )}
          </>
        )}

        {tab === "favorites" && (
          <>
            {favorites.length === 0 && (
              <div className="text-secondary-text text-sm text-center">Список пуст</div>
            )}
            {favorites.map((driver) =>
              driverCard(driver, {
                children: (
                  <button
                    className="bg-success text-white px-3 py-2 rounded-xl press font-semibold mt-2 w-full"
                    onClick={() => callDriver(driver)}
                  >
                    Позвонить
                  </button>
                ),
              })
            )}
          </>
        )}

        {tab === "dialogs" && (
          <ChatList onOpen={(chatId) => setView({ type: "direct", id: chatId })} />
        )}
      </div>

      {/* Нижний композер заказа */}
      {tab === "new" && (
        <form
          className="shrink-0 glass-strong rounded-t-3xl p-3 space-y-2.5 safe-area-bottom anim-sheet"
          onSubmit={submit}
        >
          {directTarget && (
            <div className="text-xs text-secondary-text text-center bg-primary rounded-lg p-2">
              Прямой заказ водителю {directTarget.driverName ?? directTarget.driverId}
            </div>
          )}

          <div className="relative flex p-1 rounded-2xl bg-[#0d0d0d]">
            {[
              ["now", "⚡ Сейчас"],
              ["scheduled", "🕓 На время"],
            ].map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`press relative z-10 flex-1 py-2 rounded-xl text-[1.3rem] transition-all duration-300 ${
                  whenType === key ? "btn-accent font-bold" : "text-secondary-text"
                }`}
                onClick={() => setWhenType(key)}
              >
                 <IconText>{label}</IconText>
              </button>
            ))}
          </div>

{whenType === "scheduled" && (
            <button
              type="button"
              className="press w-full text-left glass rounded-2xl p-3 text-[1.4rem] flex items-center justify-between gap-2"
              onClick={() => setTimeOpen(true)}
            >
              <span className="flex items-center gap-2">
                 <TaxiIcon name="clock" />
                <span>
                  {(whenAt.split("T")[1] ?? "")} ·{" "}
                  {new Date(whenAt).toLocaleDateString("ru-RU", { day: "numeric", month: "long" })}
                </span>
              </span>
              <span className="text-cta-icon font-semibold">Изменить</span>
            </button>
          )}

<AddressInput
            value={route}
            onChange={setRoute}
            onEnter={submit}
            label="Маршрут"
            placeholder="Куда едем? Например: от ЖД до Центра"
            cityName={cityName}
            cities={cityNames}
            listId="route-suggestions"
          />

          {/* Комментарий + кнопка заказа — одна строка в стиле мессенджера:
              при открытой клавиатуре всё помещается над ней */}
          <label className="sr-only" htmlFor="taxi-order-notes">Комментарий водителю (необязательно)</label>
          <div className="flex items-center gap-2 min-w-0">
            <input
              id="taxi-order-notes"
              className="flex-1 min-w-0 bg-[#0d0d0d] text-white placeholder:text-secondary-text border border-secondary-text/30 rounded-2xl px-3 py-2.5 focus:border-accent focus:outline-none transition-colors text-[1.5rem] text-primary-text"
              placeholder="Комментарий (необязательно)"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
            <button
              aria-label={
                sending
                  ? "Отправляем заказ"
                  : whenType === "scheduled"
                    ? "Заказать на время"
                    : directTarget
                      ? "Оформить заказ водителю"
                      : "Заказать такси"
              }
              className={`press btn-accent shrink-0 w-[5.6rem] h-[5.6rem] rounded-full flex items-center justify-center ${

                !route.trim() || sending ? "opacity-50" : "opacity-100 anim-pulse-ring"
              }`}
              type="submit"
              disabled={!route.trim() || sending}
            >
              {sending ? (
                <span className="text-[1.6rem] font-bold">…</span>
              ) : (
                <TaxiIcon name="send" size={30} />
              )}
            </button>
          </div>
</form>
      )}

      <TimePicker
        open={timeOpen}
        value={whenAt}
        onChange={setWhenAt}
        onClose={() => setTimeOpen(false)}
        title="Когда подать машину"
      />
    </div>
  );
};

export default PassengerPanel;
