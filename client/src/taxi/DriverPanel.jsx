import { useEffect, useState } from "react";
import { useDispatch } from "react-redux";
import { notificationActions } from "../store/notificationSlice";
import { apiGet, apiPost } from "./api";
import useSocket from "../hooks/useSocket";
import OrderChat from "./OrderChat";
import DirectChat from "./DirectChat";
import ChatList from "./ChatList";
import { useDialog } from "./AppDialog";
import { statusBadge, formatWhen } from "./statusLabels";
import { IconText } from "./TaxiIcon";

// Driver panel: shift toggle, live feed of published orders, assigned orders
const DriverPanel = ({ me, cityId, driverProfile, refreshMe, startCall }) => {
  const { ask, confirm } = useDialog();
  const dispatch = useDispatch();
  const { socketListen, socketEmit, socket } = useSocket();
  const [view, setView] = useState(null); // { type, id }
  const [orders, setOrders] = useState([]);
  const [online, setOnline] = useState(driverProfile?.shift != null && driverProfile.shift !== "offline");
  const [shiftPending, setShiftPending] = useState(false);
  const [error, setError] = useState(null);

  const load = async () => {
    try {
      const res = await apiGet(`/api/orders?cityId=${cityId}`);
      setOrders(res.data.orders);
    } catch (err) {
      setError(err.message);
    }
  };

  // Live link indicator: shows whether this device currently receives events
  const [linked, setLinked] = useState(socket.connected);
  const [lastEvent, setLastEvent] = useState("—");
  useEffect(() => {
    const up = () => {
      setLinked(true);
      refreshMe().catch((err) => setError(err.message));
    };
    const down = () => setLinked(false);
    socket.on("connect", up);
    socket.on("disconnect", down);
    return () => {
      socket.off("connect", up);
      socket.off("disconnect", down);
    };
  }, []);

  useEffect(() => {
    load();
    const onNew = () => {
      setLastEvent(`order:new ${new Date().toLocaleTimeString("ru-RU")}`);
      // Voice and notice come from useOrderNotices
      load();
    };
    const onTaken = () => {
      dispatch(
        notificationActions.addNotification({
          message: "Один из заказов уже взят",
          type: "info",
        })
      );
      load();
    };
    const onChanged = () => load();
    socketListen("order:new", onNew);
    socketListen("order:taken", onTaken);
    socketListen("order:status", onChanged);
    socketListen("driver:presence", onChanged);
    return () => {
      socket.off("order:new", onNew);
      socket.off("order:taken", onTaken);
      socket.off("order:status", onChanged);
      socket.off("driver:presence", onChanged);
    };
  }, [cityId]);

  // 90 seconds of silence takes the driver offline (concept 1.8)
  useEffect(() => {
    if (!online) return undefined;
    const beat = () => socketEmit("driver:heartbeat");
    beat();
    const timer = setInterval(beat, 30 * 1000);
    return () => clearInterval(timer);
  }, [online]);

  const toggleShift = () => {
    if (!linked || shiftPending) return;
    const next = online ? "offline" : "online";
    setShiftPending(true);
    socketEmit("driver:shift", { shift: next });
  };

  useEffect(() => {
    if (!shiftPending) return undefined;
    const onPresence = (payload) => {
      if (String(payload?.driverId) !== String(me?.user?._id)) return;
      refreshMe().then(() => setShiftPending(false)).catch((err) => {
        setError(err.message);
        setShiftPending(false);
      });
    };
    const onError = (payload) => {
      setError(payload?.error ?? "Не удалось сменить статус смены");
      setShiftPending(false);
    };
    socket.on("driver:presence", onPresence);
    socket.on("driver:error", onError);
    // Presence events are throttled server-side; verify the saved state even without one.
    const timer = setTimeout(() => {
      refreshMe().then(() => setShiftPending(false)).catch((err) => {
        setError(err.message);
        setShiftPending(false);
      });
    }, 5500);
    return () => {
      clearTimeout(timer);
      socket.off("driver:presence", onPresence);
      socket.off("driver:error", onError);
    };
  }, [shiftPending, me?.user?._id]);

  // Sync the shift toggle with the server state (busy while assigned)
  useEffect(() => {
    if (driverProfile) setOnline(driverProfile.shift !== "offline");
  }, [driverProfile?.shift]);

  if (view?.type === "order") {
    return <OrderChat orderId={view.id} me={me} onBack={() => setView(null)} startCall={startCall} />;
  }
  if (view?.type === "direct") {
    return <DirectChat chatId={view.id} me={me} onBack={() => setView(null)} />;
  }

  const accept = async (order) => {
    try {
      await apiPost(`/api/orders/${order._id}/accept`, {});
      dispatch(
        notificationActions.addNotification({
          message: "Заказ принят — открываю чат",
          type: "success",
        })
      );
      setView({ type: "order", id: order._id });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const book = async (order) => {
    try {
      await apiPost(`/api/orders/${order._id}/book`, {});
      dispatch(
        notificationActions.addNotification({
          message: "Заказ забронирован. Вы остаётесь свободны до времени поездки",
          type: "success",
        })
      );
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const activateBooking = async (order) => {
    try {
      await apiPost(`/api/orders/${order._id}/activate`, {});
      dispatch(
        notificationActions.addNotification({
          message: "Бронь активирована — вы назначены на заказ",
          type: "success",
        })
      );
      setView({ type: "order", id: order._id });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const sendOffer = async (order) => {
    try {
      const priceText = await ask({ title: "Цена поездки", placeholder: "Например: 350", okText: "Отправить" });
      if (!priceText) return;
      const etaMin = parseInt((await ask({ title: "Время подачи, минут", placeholder: "Например: 5", inputMode: "numeric", okText: "Отправить" })) ?? "10", 10);
      await apiPost(`/api/orders/${order._id}/offers`, { priceText, etaMin });
      dispatch(
        notificationActions.addNotification({
          message: "Отклик отправлен пассажиру",
          type: "info",
        })
      );
    } catch (err) {
      setError(err.message);
    }
  };

  const myAction = async (order, action) => {
    try {
      await apiPost(`/api/orders/${order._id}/action`, { action });
      const labels = {
        arrive: "Отмечено: выехал",
        wait: "Отмечено: на месте",
        start: "Поездка началась",
        finish: "Поездка завершена ✅",
        no_show: "Отмечена неявка пассажира",
        undo_start: "Начало поездки отменено",
      };
      dispatch(
        notificationActions.addNotification({
          message: labels[action] ?? "Готово",
          type: "success",
        })
      );
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const feed = orders.filter(
    (order) =>
      order.status === "PUBLISHED" &&
      (order.isTarget || order.mode !== "direct")
  );
  const mine = orders.filter(
    (order) => String(order.driverId) === String(me?.user?._id) &&
      !["PUBLISHED", "DRAFT"].includes(order.status)
  );
  const active = mine.filter((order) => ["ASSIGNED", "ARRIVING", "WAITING", "IN_RIDE", "DISPUTE"].includes(order.status));
  const booked = mine.filter((order) => order.status === "BOOKED");

  return (
    <div className="p-4 space-y-4 overflow-y-auto h-full max-w-[42rem] mx-auto w-full anim-rise">
      <div className="glass rounded-2xl p-4 space-y-2">
      <div className="flex items-center gap-3 flex-wrap">
        <button
          className={`press px-6 py-3 rounded-2xl text-white font-display font-bold tracking-wide ${online ? "bg-success shadow-[0_0_24px_rgba(46,160,67,0.45)]" : "bg-danger"}`}
          onClick={toggleShift}
          disabled={!linked || shiftPending}
          aria-busy={shiftPending}
        >
          {shiftPending ? "Смена статуса…" : online ? "На линии · выключить" : "Не на линии · выйти"}
        </button>
        {driverProfile && (
          <div className="text-sm text-secondary-text">
            {driverProfile.carCaption}
            {driverProfile.rating != null && ` · ★ ${driverProfile.rating}`}
          </div>
        )}
      </div>
      <div className="text-sm text-secondary-text" role="status">
        {linked ? "Связь с сервером есть" : "Нет связи: смена статуса недоступна"}
        {shiftPending && " · Ожидаем подтверждения смены"}
      </div>
      </div>

      {error && <div className="text-danger text-sm">{error}</div>}

      {!online && (
        <div className="text-sm text-secondary-text">
          <IconText>😴 Выйдите на линию, чтобы получать заказы</IconText>
        </div>
      )}

      <div className="text-xs text-secondary-text">Последнее событие: {lastEvent}</div>

      <div>
          <h3 className="font-display font-bold mb-2 tracking-wide"><IconText>🚕 Моя поездка</IconText> {active.length > 0 && `· ${active.length}`}</h3>
          {active.length === 0 && <div className="glass rounded-2xl p-4 text-sm text-secondary-text">Сейчас нет назначенной поездки</div>}
          <div className="space-y-2">
            {active.map((order) => (
              <div key={order._id} className="glass rounded-2xl p-4 space-y-3 border border-accent/50">
                <div className="font-display font-bold text-lg">{order.to?.text ? `${order.from?.text} → ${order.to?.text}` : order.from?.text}</div>
                <div className="text-sm text-secondary-text"><IconText>{statusBadge(order.status)}</IconText> · <IconText>{formatWhen(order.when)}</IconText> · {order.pax} пасс.</div>
                {order.passenger?.name && <div className="text-sm">Пассажир: {order.passenger.name}</div>}
                <div className="flex flex-wrap gap-2 items-center">
                  {order.status === "ASSIGNED" && <button className="btn-accent press px-4 py-2 rounded-xl font-semibold" onClick={() => myAction(order, "arrive")}>Выехал</button>}
                  {order.status === "ARRIVING" && <button className="btn-accent press px-4 py-2 rounded-xl font-semibold" onClick={() => myAction(order, "wait")}>Я на месте</button>}
                  {order.status === "WAITING" && <>
                    <button className="bg-success text-white px-4 py-2 rounded-xl" onClick={() => myAction(order, "start")}>Поехали</button>
                    <button className="bg-danger text-white px-4 py-2 rounded-xl" onClick={() => myAction(order, "no_show")}>Не вышел</button>
                  </>}
                  {order.status === "IN_RIDE" && <>
                    <button className="bg-success text-white px-4 py-2 rounded-xl" onClick={() => myAction(order, "finish")}>Завершить</button>
                    <button className="underline" onClick={() => myAction(order, "undo_start")}>Отменить начало</button>
                  </>}
                  <button className="underline" onClick={() => setView({ type: "order", id: order._id })}>Чат {order.unreadCount > 0 && `(${order.unreadCount})`}</button>
                  {order.passengerId && <button className="underline" onClick={() => startCall({ kind: "order", orderId: order._id, target: String(order.passengerId), name: "Пассажир", fromRole: "driver" })}>Позвонить</button>}
                </div>
              </div>
            ))}
          </div>
      </div>

      <div>
          <h3 className="font-display font-bold mb-2 tracking-wide"><IconText>🔖 Мои брони</IconText> {booked.length > 0 && `· ${booked.length}`}</h3>
          {booked.length === 0 && <div className="text-sm text-secondary-text">Нет предстоящих броней</div>}
          <div className="space-y-2">{booked.map((order) => (
            <div key={order._id} className="glass rounded-2xl p-4 space-y-2">
              <div className="font-semibold">{order.to?.text ? `${order.from?.text} → ${order.to?.text}` : order.from?.text}</div>
              <div className="text-sm text-secondary-text"><IconText>{formatWhen(order.when)}</IconText> · {order.pax} пасс.</div>
              <div className="flex flex-wrap gap-3 items-center">
                <button className="btn-accent press px-3 py-2 rounded-xl font-semibold" onClick={() => activateBooking(order)}>Приступить к брони</button>
                <button className="underline" onClick={() => setView({ type: "order", id: order._id })}>Открыть заказ</button>
              </div>
            </div>
          ))}</div>
      </div>

      <div>
        <h3 className="font-display font-bold mb-2 text-center tracking-wide"><IconText>📢 Лента заказов</IconText></h3>
          <div className="space-y-2">
          {feed.length === 0 && <div className="text-sm text-secondary-text"><IconText>📭 Пока нет заказов</IconText></div>}
          {feed.map((order) => (
            <div key={order._id} className="glass rounded-2xl p-4 text-[1.5rem]">
                <div className="font-semibold break-words">
                  {order.to?.text ? `${order.from?.text} → ${order.to?.text}` : order.from?.text}
                </div>
              <div className="text-secondary-text">
                {formatWhen(order.when)} · {order.pax} пасс.
                {order.notes ? ` · ${order.notes}` : ""}
              </div>
              <div className="flex gap-2 mt-2 flex-wrap">
                {order.isTarget || order.matchMode === "first_take" ? (
                  <button className="bg-success text-white px-3 py-1.5 rounded-lg" onClick={() => accept(order)}>
                    Принять
                  </button>
                ) : (
                  <button className="btn-accent press px-3 py-1.5 rounded-xl font-semibold" onClick={() => sendOffer(order)}>
                    Прислать отклик
                  </button>
                )}
                {order.when?.type === "scheduled" && (
                  <button
                    className="border border-accent text-cta-icon px-3 py-1.5 rounded-lg"
                    onClick={() => book(order)}
                  >
                    <IconText>🔖 Забронировать</IconText>
                  </button>
                )}
                                <button className="underline" onClick={() => setView({ type: "order", id: order._id })}>
                  Открыть заказ
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3 className="font-display font-bold mb-2 text-center tracking-wide"><IconText>💬 Диалоги</IconText></h3>
        <ChatList onOpen={(chatId) => setView({ type: "direct", id: chatId })} />
      </div>
    </div>
  );
};

export default DriverPanel;


