import { useCallback, useEffect, useRef, useState } from "react";
import { useDispatch } from "react-redux";
import { notificationActions } from "../store/notificationSlice";
import { apiGet, apiPost, apiUpload } from "./api";
import useSocket from "../hooks/useSocket";
import { statusBadge, formatWhen } from "./statusLabels";
import Marquee from "./Marquee";
import TaxiIcon, { IconText } from "./TaxiIcon";
import { useDialog } from "./AppDialog";
import useVoiceNote from "./useVoiceNote";
import WaitingInfo from "./WaitingInfo";

// Chat of a single order: bot card, system messages, quick action buttons,
// offers, SOS and the trip rating (concept 1.7)
const OrderChat = ({ orderId, me, cityTz, onBack, startCall }) => {
  const { ask, confirm } = useDialog();
  const dispatch = useDispatch();
  const { socket } = useSocket();
  const [order, setOrder] = useState(null);
  const [messages, setMessages] = useState([]);
  const [offers, setOffers] = useState([]);
  const [text, setText] = useState("");
  const [error, setError] = useState(null);
  const [stars, setStars] = useState(0);
  const [rated, setRated] = useState(false);
  const [hoverStars, setHoverStars] = useState(0);

  // Все хуки объявляются до ранних return, иначе число хуков меняется при загрузке заказа
  const fileInputRef = useRef();
  const messageRef = useRef();
  const [armed, setArmed] = useState(false);
  const [uploading, setUploading] = useState(false);

  // Status events fan out to several subscribers; parallel refreshes can
  // resolve out of order and overwrite fresh state with a stale snapshot.
  // Only the latest load() is allowed to commit its result.
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const res = await apiGet(`/api/orders/${orderId}`);
      if (seq !== loadSeq.current) return;
      setOrder(res.data.order);
      if (res.data.order.myRating) {
        setStars(res.data.order.myRating);
        setRated(true);
      }
      const history = await apiGet(`/api/orders/${orderId}/messages`);
      if (seq !== loadSeq.current) return;
      setMessages(history.data.messages);
      const offersRes = await apiGet(`/api/orders/${orderId}/offers`);
      if (seq !== loadSeq.current) return;
      setOffers(offersRes.data.offers);
    } catch (err) {
      if (seq === loadSeq.current) setError(err.message);
    }
  }, [orderId]);

  const sendVoice = useCallback(
    async (uploadData, seconds) => {
      await apiPost(`/api/orders/${orderId}/messages`, {
        kind: "voice",
        voiceNoteUrl: uploadData.secure_url,
        voiceNoteDuration: seconds,
      });
      load();
    },
    [load, orderId]
  );

  const voice = useVoiceNote({
    context: { orderId },
    onBlob: sendVoice,
  });
  useEffect(() => {
    if (voice.error) setError(voice.error);
  }, [voice.error]);

  // rows={1} textareas do not grow on their own; the CSS max-height caps the
  // growth at roughly five lines and the overflow then scrolls inside the field.
  // An empty field keeps its one-line height instead of stretching to the
  // wrapped placeholder.
  useEffect(() => {
    const field = messageRef.current;
    if (!field) return;
    if (!text) {
      field.style.height = "";
      return;
    }
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight}px`;
  }, [text]);
  const recording = voice.recording;
  const recordSeconds = voice.recordSeconds;
  const busy = uploading || voice.uploading;

  const isParticipant =
    String(order?.passengerId) === String(me?.user?._id) ||
    (order?.driverId && String(order.driverId) === String(me?.user?._id));
  const myRole = !isParticipant
    ? "dispatcher"
    : String(order?.driverId) === String(me?.user?._id)
      ? "driver"
      : "passenger";
  const otherId =
    myRole === "driver"
      ? order?.passengerId
      : order?.driverId;

  // While this chat is on screen its messages are visible here: tell the
  // notice hook not to pop a toast over the conversation being read
  useEffect(() => {
    window.__bombilaOpenOrderId = String(orderId);
    return () => {
      if (window.__bombilaOpenOrderId === String(orderId)) window.__bombilaOpenOrderId = null;
    };
  }, [orderId]);

  useEffect(() => {
    window.__bombilaOpenOrderId = String(orderId);
    return () => {
      if (window.__bombilaOpenOrderId === String(orderId)) window.__bombilaOpenOrderId = null;
    };
  }, [orderId]);

  useEffect(() => {
    load();
    // Mark the chat as read while it is open
    apiPost(`/api/orders/${orderId}/read`, {}).catch(() => {});
    const onChanged = () => {
      load();
      apiPost(`/api/orders/${orderId}/read`, {}).catch(() => {});
    };
    socket.on("chat:message", onChanged);
    socket.on("order:status", onChanged);
    socket.on("order:offersChanged", onChanged);

    // Join the live order room. The server refuses non-participants, so the
    // join is retried after the driver is assigned (order:status) and after
    // every reconnect (rooms are per connection).
    const joinRoom = () => socket.emit("order:join", { orderId });
    joinRoom();
    socket.on("connect", joinRoom);
    socket.on("order:status", joinRoom);
    return () => {
      socket.off("chat:message", onChanged);
      socket.off("order:status", onChanged);
      socket.off("order:offersChanged", onChanged);
      socket.off("connect", joinRoom);
      socket.off("order:status", joinRoom);
      socket.emit("order:leave", { orderId });
    };
  }, [orderId, load, socket]);

  const send = async (body) => {
    if (!body.trim()) return;
    try {
      await apiPost(`/api/orders/${orderId}/messages`, { body });
      setText("");
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const acceptOffer = async (offerId) => {
    try {
      await apiPost(`/api/orders/${orderId}/accept`, { offerId });
      // The "driver assigned" status notice arrives over the socket; only drop
      // this order's offer cards so they cannot be accepted a second time
      dispatch(notificationActions.removeOfferNotices(orderId));
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const runAction = async (button) => {
    const action = typeof button === "string" ? button : button.action;
    try {
      if (action === "offer") {
        const priceText = await ask({ title: "💰 Цена поездки", placeholder: "Например: 350", okText: "Отправить" });
        if (!priceText) return;
        const etaMin = parseInt((await ask({ title: "⏱ Время подачи, минут", placeholder: "Например: 5", inputMode: "numeric", okText: "Отправить" })) ?? "10", 10);
        await apiPost(`/api/orders/${orderId}/offers`, { priceText, etaMin });
        dispatch(
          notificationActions.addNotification({
            message: "Отклик отправлен пассажиру",
            type: "success",
          })
        );
      } else if (action === "cancel") {
        const reason = await ask({ title: "❌ Причина отмены", placeholder: "Коротко, что случилось", okText: "Отменить заказ" });
        if (!reason) return;
        await apiPost(`/api/orders/${orderId}/cancel`, { reason });
        dispatch(
          notificationActions.addNotification({
            message: "Заказ отменён",
            type: "info",
          })
        );
      } else if (action === "resolve_complete" || action === "resolve_cancel") {
        const done = action === "resolve_complete";
        const ok = await confirm({
          title: done ? "✅ Поездка состоялась?" : "❌ Отменить заказ по спору?",
          text: done
            ? "Заказ будет закрыт как выполненный, участники получат уведомление"
            : "Заказ будет отменён, участники получат уведомление",
          okText: done ? "Поездка состоялась" : "Отменить заказ",
          danger: !done,
        });
        if (!ok) return;
        await apiPost(`/api/orders/${orderId}/resolve`, {
          outcome: done ? "complete" : "cancel",
        });
        dispatch(
          notificationActions.addNotification({
            message: done ? "Спор закрыт: поездка состоялась" : "Спор закрыт: заказ отменён",
            type: "success",
          })
        );
      } else if (action === "dispute") {
        const reason = await ask({ title: "⚠️ Опишите проблему", placeholder: "Что пошло не так", okText: "Открыть спор" });
        if (!reason) return;
        await apiPost(`/api/orders/${orderId}/dispute`, { reason });
        dispatch(
          notificationActions.addNotification({
            message: "Спор открыт, диспетчер подключится",
            type: "info",
          })
        );
      } else if (action === "text") {
        // Quick replies from the bot ("Опаздываю на 5 минут" etc.)
        await send(button.text ?? button.label);
        return;
      } else {
        // Lifecycle actions: arrive/wait/start/finish etc., plus booking
        const endpoint =
          action === "book" ? "book" : action === "activate" ? "activate" : "action";
        await apiPost(
          `/api/orders/${orderId}/${endpoint}`,
          endpoint === "action" ? { action } : {}
        );
        const labels = {
          arrive: "Отмечено: выехал",
          wait: "Отмечено: на месте",
          start: "Поездка началась",
          finish: "Поездка завершена ✅",
          no_show: "Отмечена неявка",
          undo_start: "Начало поездки отменено",
          book: "🔖 Заказ забронирован — вы свободны до времени",
          activate: "🚕 Бронь активирована — вы назначены",
        };
        dispatch(
          notificationActions.addNotification({
            message: labels[action] ?? "Готово",
            type: "success",
          })
        );
      }
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const onPickPhoto = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      setUploading(true);
      const uploadData = await apiUpload(file, "image", { orderId });
      await apiPost(`/api/orders/${orderId}/messages`, {
        kind: "photo",
        imageUrl: uploadData.secure_url,
      });
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  };

  const sos = async () => {
    try {
      await apiPost(`/api/orders/${orderId}/sos`, {});
      dispatch(
        notificationActions.addNotification({
          message: "SOS отправлен — диспетчеры оповещены",
          type: "error",
        })
      );
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const rate = async (value) => {
    try {
      await apiPost(`/api/orders/${orderId}/rating`, { stars: value });
      setStars(value);
      setRated(true);
    } catch (err) {
      setError(err.message);
    }
  };

  const share = async () => {
    try {
      const res = await apiGet(`/api/orders/${orderId}/share`);
      await confirm({ title: "🔗 Ссылка для близких", text: res.data.url, okText: "Готово" });
    } catch (err) {
      setError(err.message);
    }
  };

  const blockPeer = async () => {
    if (!(await confirm({ title: "🚫 Заблокировать участника?", text: "Звонки и диалоги станут недоступны.", okText: "Заблокировать", danger: true }))) return;
    try {
      await apiPost("/api/blocks", { userId: String(otherId) });
      dispatch(
        notificationActions.addNotification({
          message: "Участник заблокирован",
          type: "info",
        })
      );
      setError("Участник заблокирован");
    } catch (err) {
      setError(err.message);
    }
  };

  if (error && !order) {
    // 403 here means the viewer is not a participant yet (an offer, not an
    // assignment): say so instead of leaving a bare server message
    const refused = /доступ/i.test(error);
    return (
      <div className="p-6 space-y-3 text-center">
        <div className="text-danger">
          {refused ? "Чат откроется после назначения: пока вы не участник этого заказа" : error}
        </div>
        <button className="btn-back mx-auto" onClick={onBack}><TaxiIcon name="back" /> Назад</button>
      </div>
    );
  }
  if (!order) return <div className="p-6">Загрузка...</div>;

  const CALLABLE = ["ASSIGNED", "ARRIVING", "WAITING", "IN_RIDE"];
  // The dispatcher dials through the city line, so in-app calls are for the
  // two participants only
  const canCallPeer = isParticipant && otherId;
  const peerLine = myRole === "passenger" && order.driver
    ? `${order.driver.displayName}${order.driver.carCaption ? ` · ${order.driver.carCaption}` : ""}`
    : myRole === "driver" && order.passenger?.name
      ? order.passenger.name
      : null;
  // The dispatcher dials the participants himself: a plain phone call from
  // the city line, so the passenger never sees a personal number
  const callable = (phone) => (phone ? `tel:${String(phone).replace(/[^\d+]/g, "")}` : null);

  return (
    <div className="flex flex-col h-full">
      <div className="glass-strong sticky top-0 z-20 p-2 border-b border-secondary-text/20 rounded-b-2xl">
          <div className="flex items-center gap-2 min-w-0">
             <button className="btn-back shrink-0" onClick={onBack} aria-label="Назад"><TaxiIcon name="back" /></button>
            <Marquee
              text={order.to?.text ? `${order.from?.text} → ${order.to?.text}` : order.from?.text}
              className="flex-1 min-w-0 text-[1.6rem] font-semibold"
            />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[1.5rem] text-secondary-text">
             <span><IconText>{statusBadge(order.status)}</IconText></span>
             <span><TaxiIcon name="time" className="inline-block align-[-0.2em]" /> {formatWhen(order.when, cityTz)}</span>
             {order.priceAgreed ? <span className="text-cta-icon font-semibold"><TaxiIcon name="cash" className="inline-block align-[-0.2em]" /> {order.priceAgreed}</span> : null}
          </div>
          {order.waiting && <WaitingInfo waiting={order.waiting} className="mt-1 text-[1.4rem]" />}
          {peerLine && (
            <div className="mt-1 break-words text-[1.5rem] text-primary-text">
              {myRole === "passenger"
                ? <><TaxiIcon name="driver" className="inline-block align-[-0.2em]" /> {peerLine}</>
                : <><TaxiIcon name="passenger" className="inline-block align-[-0.2em]" /> {peerLine}</>}
            </div>
          )}
          {myRole === "dispatcher" && (order.passenger?.name || order.driver?.displayName) && (
            <div className="mt-1 space-y-1 text-[1.5rem]">
              {order.passenger?.name && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-secondary-text">Пассажир: {order.passenger.name}</span>
                  {callable(order.passenger.phone) && (
                    <a className="text-cta-icon font-semibold underline" href={callable(order.passenger.phone)}>
                      Позвонить
                    </a>
                  )}
                </div>
              )}
              {order.driver?.displayName && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-secondary-text">
                    Водитель: {order.driver.displayName}
                    {order.driver.carCaption ? ` · ${order.driver.carCaption}` : ""}
                  </span>
                  {callable(order.driver.phone) && (
                    <a className="text-cta-icon font-semibold underline" href={callable(order.driver.phone)}>
                      Позвонить
                    </a>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 mt-2 justify-center">
          {canCallPeer && CALLABLE.includes(order.status) && (
            <button
              className="bg-success text-white px-3.5 py-2 rounded-xl text-[1.4rem] font-semibold"
              onClick={() =>
                startCall({
                  kind: "order",
                  orderId,
                  target: String(otherId),
                  name: myRole === "driver" ? "Пассажир" : "Водитель",
                  fromRole: myRole,
                })
              }
            >
               <TaxiIcon name="phone" className="inline-block align-[-0.2em]" /> Позвонить
            </button>
          )}
          {isParticipant &&
            ["PUBLISHED", "ASSIGNED", "ARRIVING", "WAITING", "IN_RIDE", "DISPUTE"].includes(order.status) && (
              <button className="bg-danger text-white px-3.5 py-2 rounded-xl text-[1.4rem] font-semibold" onClick={sos}>
                SOS
              </button>
            )}
          {isParticipant && (
            <button className="border border-secondary-text/40 px-3.5 py-2 rounded-xl text-[1.4rem] font-semibold" onClick={share}>
               <TaxiIcon name="share" className="inline-block align-[-0.2em]" /> Поделиться
            </button>
          )}
          {isParticipant && otherId && (
            <button
              className="border border-secondary-text/40 text-secondary-text px-3.5 py-2 rounded-xl text-[1.4rem] font-semibold"
              onClick={blockPeer}
            >
              Блок
            </button>
          )}
        </div>

      {error && <div className="text-danger text-[1.4rem] px-3 py-1">{error}</div>}

      {order.status === "PUBLISHED" && offers.length > 0 && (
        <div className="p-3 border-b border-secondary-text/20 space-y-2 text-center">
          <div className="text-[1.3rem] text-secondary-text">Отклики водителей · {offers.length}</div>
          <div className="space-y-2">
            {offers.map((offer) => (
              <div
                key={offer._id}
                className="flex items-center gap-3 bg-secondary rounded-2xl p-3 text-[1.6rem]"
              >
                <div className="min-w-0">
                  <div className="font-semibold">{offer.driverName}</div>
                  <div className="text-secondary-text break-words">
                    {offer.priceText} · подача {offer.etaMin} мин · {offer.carCaption}
                  </div>
                </div>
                {myRole === "passenger" && offer.status === "PENDING" && (
                  <button
                    className="ml-auto bg-success text-white px-3.5 py-2 rounded-xl text-[1.4rem] font-semibold shrink-0"
                    onClick={() => acceptOffer(offer._id)}
                  >
                    Принять
                  </button>
                )}
                {offer.status === "ACCEPTED" && (
                  <span className="ml-auto text-success text-[1.3rem] shrink-0">Принят</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
        {messages.map((message) => {
          if (message.kind === "system") {
            return (
              <div key={message._id} className="text-center text-[1.3rem] text-secondary-text py-1">
                {message.body}
              </div>
            );
          }
          if (message.kind === "order_card") {
            // Данные заказа уже показаны в шапке — карточку в ленте не дублируем
            return null;
          }
          if (message.kind === "action") {
            // Finished orders keep no actions, even if an old button message is left
            if (["COMPLETED", "CANCELLED", "NO_SHOW", "EXPIRED"].includes(order.status)) return null;
            return (
              <div key={message._id} className="flex flex-wrap gap-2">
                {(message.meta?.buttons ?? [])
                  .filter((button) => button.roles.includes(myRole))
                  .map((button) => (
                    <button
                      key={button.action + button.label}
                      className="btn-accent press px-4 py-2 rounded-xl text-[1.5rem] font-semibold"
                      onClick={() => runAction(button)}
                    >
                      {button.label}
                    </button>
                  ))}
              </div>
            );
          }
          if (message.kind === "photo") {
            return (
              <div
                key={message._id}
                className={`max-w-[82%] rounded-2xl p-2.5 text-[1.8rem] leading-snug break-words ${message.mine ? "btn-accent ml-auto text-[#111]" : "glass"}`}
              >
                {message.senderName && <div className="text-[1.2rem] text-secondary-text">{message.senderName}</div>}
                <img
                  src={message.meta?.imageUrl}
                  alt="Фото"
                  className="rounded max-h-[16rem]"
                />
              </div>
            );
          }
          if (message.kind === "voice") {
            return (
              <div
                key={message._id}
                className={`max-w-[82%] rounded-2xl p-2.5 text-[1.8rem] leading-snug break-words ${message.mine ? "btn-accent ml-auto text-[#111]" : "glass"}`}
              >
                {message.senderName && <div className="text-[1.2rem] text-secondary-text">{message.senderName}</div>}
                <div className="flex items-center gap-2">
                   <TaxiIcon name="microphone" />
                  <audio controls src={message.meta?.voiceNoteUrl} />
                  {message.meta?.voiceNoteDuration && (
                    <span className="text-[1.2rem] text-secondary-text">
                      {message.meta.voiceNoteDuration} с
                    </span>
                  )}
                </div>
              </div>
            );
          }
          return (
            <div
              key={message._id}
              className={`max-w-[82%] rounded-2xl p-2.5 text-[1.8rem] leading-snug break-words ${message.mine ? "btn-accent ml-auto text-[#111]" : "glass"}`}
            >
              {message.senderName && <div className="text-[1.2rem] text-secondary-text">{message.senderName}</div>}
              {message.body}
            </div>
          );
        })}
      </div>

      {isParticipant && order.status === "COMPLETED" && order.driverId && (
        <div className="p-3 border-t border-secondary-text/20">
          <div className="text-[1.4rem] mb-1">
            {rated
              ? `Вы оценили поездку: ${stars} из 5`
              : myRole === "driver"
                ? "Оцените пассажира:"
                : "Оцените водителя и поездку:"}
          </div>
          <div className="flex gap-1" onMouseLeave={() => setHoverStars(0)}>
            {[1, 2, 3, 4, 5].map((value) => {
              const filled = value <= (hoverStars || stars);
              return (
                <button
                  key={value}
                  type="button"
                  disabled={rated}
                  className={`press p-1 rounded-lg ${filled ? "text-warning" : "text-secondary-text/60"} ${rated ? "cursor-default" : ""}`}
                  onMouseEnter={() => !rated && setHoverStars(value)}
                  onFocus={() => !rated && setHoverStars(value)}
                  onClick={() => !rated && rate(value)}
                  aria-label={rated
                    ? `Ваша оценка: ${value} из 5`
                    : `Оценить поездку на ${value} ${
                        value === 1 ? "звезду" : value < 5 ? "звезды" : "звёзд"
                      }`}
                  aria-pressed={rated && value <= stars}
                >
                  <TaxiIcon name={filled ? "starFilled" : "star"} size={30} />
                </button>
              );
            })}
          </div>
        </div>
      )}

      <form
        className="flex items-end gap-1 p-1.5 pl-2 rounded-[1.6rem] bg-[#141414]/90 border border-secondary-text/25 safe-area-bottom"
        onSubmit={(event) => {
          event.preventDefault();
          send(text);
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          hidden
          onChange={onPickPhoto}
        />
        <button
          type="button"
          className="shrink-0 w-[3.2rem] h-[3.2rem] rounded-full flex items-center justify-center text-[1.4rem] hover:bg-white/10"
          title="Фото"
          onClick={() => fileInputRef.current?.click()}
        >
           <TaxiIcon name="camera" />
        </button>
        <button
          type="button"
          className={`shrink-0 w-[3.2rem] h-[3.2rem] rounded-full flex items-center justify-center text-[1.4rem] hover:bg-white/10 ${recording ? "text-danger animate-pulse" : ""}`}
          title="Голосовое сообщение"
          onClick={voice.toggle}
        >
           <TaxiIcon name={recording ? "record" : "microphone"} />{recording ? ` ${recordSeconds}с` : null}
        </button>
        <textarea
          ref={messageRef}
          rows={1}
          enterKeyHint="send"
          className="block flex-1 min-w-0 bg-transparent text-white placeholder:text-secondary-text px-2 py-1.5 text-[1.8rem] leading-snug resize-none max-h-[12rem] overflow-y-auto focus:outline-none"
          value={text}
          // Keyboard opens only after an explicit tap or focus on the field
          readOnly={!armed}
          onPointerDown={() => setArmed(true)}
          onFocus={() => setArmed(true)}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            if (text.trim() && !busy && !recording) send(text);
          }}
          placeholder={busy ? "Загрузка..." : "Введите сообщение"}
          disabled={busy || recording}
        />
         <button className="press btn-accent shrink-0 w-[3.6rem] h-[3.6rem] rounded-full flex items-center justify-center text-[1.4rem] font-bold disabled:opacity-40" type="submit" onMouseDown={(event) => event.preventDefault()} disabled={!text.trim() || busy || recording} aria-label="Отправить"><TaxiIcon name="send" /></button>
      </form>
    </div>
  );
};

export default OrderChat;


