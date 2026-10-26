import { useCallback, useEffect, useState } from "react";
import { useDispatch } from "react-redux";
import { notificationActions } from "../store/notificationSlice";
import { apiGet, apiPost } from "./api";
import useSocket from "../hooks/useSocket";
import OrderChat from "./OrderChat";
import DirectChat from "./DirectChat";
import ChatList from "./ChatList";
import { useDialog } from "./AppDialog";
import { statusBadge, formatWhen } from "./statusLabels";
import TaxiIcon, { IconText } from "./TaxiIcon";
import WaitingInfo from "./WaitingInfo";

// Driver panel: shift toggle, live feed of published orders, assigned orders
const DriverPanel = ({ me, cityId, cityTz, driverProfile, refreshMe, startCall }) => {
  const { ask } = useDialog();
  const dispatch = useDispatch();
  const { socketEmit, socket } = useSocket();
  const [view, setView] = useState(null); // { type, id }
  const [orders, setOrders] = useState([]);
  const [online, setOnline] = useState(driverProfile?.shift != null && driverProfile.shift !== "offline");
  const [shiftPending, setShiftPending] = useState(false);
  const [error, setError] = useState(null);

  // Entering the tab must show the server state: the shift may have been
  // changed from the AI chat while this panel was unmounted
  useEffect(() => {
    refreshMe().catch(() => undefined);
  }, [refreshMe]);

  const load = useCallback(async () => {
    try {
      const res = await apiGet(`/api/orders?cityId=${cityId}`);
      setOrders(res.data.orders);
    } catch (err) {
      setError(err.message);
    }
  }, [cityId]);

  // Live link indicator: shows whether this device currently receives events
  const [linked, setLinked] = useState(socket.connected);
  const [lastEvent, setLastEvent] = useState("—");
  // Orders this driver already answered: no second offer until the passenger
  // accepts or declines (survives re-renders; list refresh brings myOffer)
  const [sentOffers, setSentOffers] = useState({});
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
  }, [refreshMe, socket]);

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
    // The AI chat changes the shift and assigns orders while this tab is
    // unmounted; refresh the profile as well so the toggle is never stale
    const onChanged = (payload) => {
      if (payload?.driverId && String(payload.driverId) === String(me?.user?._id)) {
        refreshMe().catch(() => undefined);
      }
      load();
    };
    socket.on("order:new", onNew);
    socket.on("order:taken", onTaken);
    socket.on("order:status", onChanged);
    socket.on("driver:presence", onChanged);
    socket.on("driver:shiftChanged", onChanged);
    return () => {
      socket.off("order:new", onNew);
      socket.off("order:taken", onTaken);
      socket.off("order:status", onChanged);
      socket.off("driver:presence", onChanged);
      socket.off("driver:shiftChanged", onChanged);
    };
  }, [cityId, load, socket, dispatch, me?.user?._id, refreshMe]);

  // 90 seconds of silence takes the driver offline (concept 1.8); the beat
  // itself lives in TaxiApp so it does not stop when this tab is left.

  const toggleShift = async () => {
    if (!linked || shiftPending) return;
    const next = online ? "offline" : "online";
    // Taken off the line by a dispatcher: going back needs an explicit answer
    let confirmBack = false;
    if (next === "online" && driverProfile?.shiftNote) {
      const answer = await ask({
        title: "Вернуться на линию?",
        text: `Диспетчер снял вас с линии: ${driverProfile.shiftNote}`,
        okText: "Вернуться на линию",
      });
      // ask() answers "" when confirmed without text; only a dismissed
      // dialog (null) cancels the return to the line
      if (answer === null) return;
      confirmBack = true;
    }
    setShiftPending(true);
    socketEmit("driver:shift", { shift: next, ...(confirmBack && { confirmBack: true }) });
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
    // The server refused "online" because a dispatcher took the driver off the
    // line: show the reason and wait for the explicit confirmation
    const onOffline = (payload) => {
      if (payload?.reason) setError(`Диспетчер снял вас с линии: ${payload.reason}`);
      setShiftPending(false);
      refreshMe().catch(() => undefined);
    };
    socket.on("driver:presence", onPresence);
    socket.on("driver:error", onError);
    socket.on("driver:offline", onOffline);
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
      socket.off("driver:offline", onOffline);
    };
  }, [shiftPending, me?.user?._id, refreshMe, socket]);

  // A dispatcher took the driver off the line: stop the heartbeat right away,
  // keep the toggle off and show the reason until the driver confirms
  useEffect(() => {
    const onOffline = (payload) => {
      if (!payload?.reason) return;
      setOnline(false);
      setLastEvent(`Снят с линии: ${payload.reason}`);
    };
    socket.on("driver:offline", onOffline);
    return () => socket.off("driver:offline", onOffline);
  }, [socket]);

  // Sync the shift toggle with the server state (busy while assigned)
  useEffect(() => {
    if (driverProfile) setOnline(driverProfile.shift !== "offline");
  }, [driverProfile]);

  if (view?.type === "order") {
    return (
      <OrderChat
        orderId={view.id}
        me={me}
        cityTz={cityTz}
        onBack={() => setView(null)}
        startCall={startCall}
      />
    );
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
    if (order.myOffer || sentOffers[order._id]) return;
    try {
      const priceText = await ask({ title: "Цена поездки", placeholder: "Например: 350", okText: "Отправить" });
      if (!priceText) return;
      const etaMin = parseInt((await ask({ title: "Время подачи, минут", placeholder: "Например: 5", inputMode: "numeric", okText: "Отправить" })) ?? "10", 10);
      await apiPost(`/api/orders/${order._id}/offers`, { priceText, etaMin });
      setSentOffers((current) => ({ ...current, [order._id]: { priceText, etaMin } }));
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
      {/* A dispatcher may take the driver off the line: show why */}
      {!online && driverProfile?.shiftNote && (
        <div className="text-[1.4rem] text-danger" role="alert">
          Диспетчер снял вас с линии: {driverProfile.shiftNote}. Выйдите на линию, когда будете готовы.
        </div>
      )}
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
                <div className="text-sm text-secondary-text"><IconText>{statusBadge(order.status)}</IconText> · <IconText>{formatWhen(order.when, cityTz)}</IconText> · {order.pax} пасс.</div>
                {order.passenger?.name && <div className="text-sm">Пассажир: {order.passenger.name}</div>}
                {order.waiting && <WaitingInfo waiting={order.waiting} />}
                <div className="flex flex-wrap gap-2 items-center">
                  {order.status === "ASSIGNED" && <button className="btn-accent press px-4 py-2 rounded-xl font-semibold" onClick={() => myAction(order, "arrive")}>Выехал</button>}
                  {order.status === "ARRIVING" && <button className="btn-accent press px-4 py-2 rounded-xl font-semibold" onClick={() => myAction(order, "wait")}>Я на месте</button>}
                  {order.status === "WAITING" && <>
                    <button className="bg-success text-white px-4 py-2 rounded-xl" onClick={() => myAction(order, "start")}>Поехали</button>
                    <button className="bg-danger text-white px-4 py-2 rounded-xl" onClick={() => myAction(order, "no_show")}>Не вышел</button>
                  </>}
                  {order.status === "IN_RIDE" && <>
                    <button className="bg-success text-white px-4 py-2 rounded-xl" onClick={() => myAction(order, "finish")}>Завершить</button>
                    <button className="border border-danger text-danger px-3 py-2 rounded-xl font-semibold" onClick={() => myAction(order, "undo_start")}>Отменить начало</button>
                  </>}
                  <button
                    className="press bg-secondary border border-secondary-text/30 px-3 py-2 rounded-xl font-semibold inline-flex items-center gap-1.5 relative"
                    onClick={() => setView({ type: "order", id: order._id })}
                  >
                    <TaxiIcon name="message" size={20} />
                    Чат
                    {order.unreadCount > 0 && (
                      <span className="bg-danger text-white rounded-full px-1.5 text-xs leading-tight" aria-label={`Новых сообщений: ${order.unreadCount}`}>
                        {order.unreadCount}
                      </span>
                    )}
                  </button>
                  {order.passengerId && (
                    <button
                      className="press bg-success text-white px-3 py-2 rounded-xl font-semibold inline-flex items-center gap-1.5"
                      onClick={() => startCall({ kind: "order", orderId: order._id, target: String(order.passengerId), name: "Пассажир", fromRole: "driver" })}
                    >
                      <TaxiIcon name="phone" size={20} />
                      Позвонить
                    </button>
                  )}
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
              <div className="text-sm text-secondary-text"><IconText>{formatWhen(order.when, cityTz)}</IconText> · {order.pax} пасс.</div>
              <div className="flex flex-wrap gap-3 items-center">
                <button className="btn-accent press px-3 py-2 rounded-xl font-semibold" onClick={() => activateBooking(order)}>Приступить к брони</button>
                <button
                  className="press bg-secondary border border-secondary-text/30 px-3 py-2 rounded-xl font-semibold inline-flex items-center gap-1.5"
                  onClick={() => setView({ type: "order", id: order._id })}
                >
                  <TaxiIcon name="message" size={18} /> Открыть заказ
                </button>
              </div>
            </div>
          ))}</div>
      </div>

      <div>
        <h3 className="font-display font-bold mb-2 text-center tracking-wide"><IconText>📢 Лента заказов</IconText></h3>
          <div className="space-y-2">
          {feed.length === 0 && <div className="text-sm text-secondary-text"><IconText>📭 Пока нет заказов</IconText></div>}
          {feed.map((order) => {
            // The feed lists the whole city: only orders this driver executes
            // (assigned, booked or still waiting for his booking) open the
            // chat. For everybody else's order there is just an offer button,
            // because the chat is closed to non-participants.
            const openable =
              (order.driverId && String(order.driverId) === String(me?.user?._id)) ||
              (order.targetDriverId && String(order.targetDriverId) === String(me?.user?._id));
            return (
            <div key={order._id} className="glass rounded-2xl p-4 text-[1.5rem]">
                <div className="font-semibold break-words">
                  {order.to?.text ? `${order.from?.text} → ${order.to?.text}` : order.from?.text}
                </div>
              <div className="text-secondary-text">
                {formatWhen(order.when, cityTz)} · {order.pax} пасс.
                {order.notes ? ` · ${order.notes}` : ""}
              </div>
              <div className="flex gap-2 mt-2 flex-wrap">
                {order.isTarget || order.matchMode === "first_take" ? (
                  <button className="bg-success text-white px-3 py-1.5 rounded-lg" onClick={() => accept(order)}>
                    Принять
                  </button>
                ) : order.myOffer || sentOffers[order._id] ? (
                  <div className="text-sm text-secondary-text">
                    <IconText>⏳ Отклик отправлен: {order.myOffer?.priceText ?? sentOffers[order._id].priceText} ₽ · ждём ответа пассажира</IconText>
                  </div>
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
                {openable && (
                  <button
                    className="press bg-secondary border border-secondary-text/30 px-3 py-2 rounded-xl font-semibold inline-flex items-center gap-1.5"
                    onClick={() => setView({ type: "order", id: order._id })}
                  >
                    <TaxiIcon name="message" size={18} /> Открыть заказ
                  </button>
                )}
              </div>
            </div>
            );
          })}
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


