import { useEffect, useRef, useState } from "react";
import { useDispatch } from "react-redux";
import { notificationActions } from "../store/notificationSlice";
import { useReactMediaRecorder } from "react-media-recorder";
import { apiGet, apiPost, apiUpload } from "./api";
import useSocket from "../hooks/useSocket";
import { statusBadge, formatWhen } from "./statusLabels";
import Marquee from "./Marquee";
import TaxiIcon, { IconText } from "./TaxiIcon";
import { useDialog } from "./AppDialog";

// Chat of a single order: bot card, system messages, quick action buttons,
// offers, SOS and the trip rating (concept 1.7)
const OrderChat = ({ orderId, me, onBack, startCall }) => {
  const { ask, confirm } = useDialog();
  const dispatch = useDispatch();
  const { socketListen, socketEmit, socket } = useSocket();
  const [order, setOrder] = useState(null);
  const [messages, setMessages] = useState([]);
  const [offers, setOffers] = useState([]);
  const [text, setText] = useState("");
  const [error, setError] = useState(null);
  const [stars, setStars] = useState(0);
  const [rated, setRated] = useState(false);

  // Все хуки объявляются до ранних return, иначе число хуков меняется при загрузке заказа
  const fileInputRef = useRef();
  const [armed, setArmed] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const recordTimerRef = useRef();

  const { startRecording, stopRecording } = useReactMediaRecorder({
    audio: true,
    onStop: async (_, blob) => {
      try {
        setUploading(true);
        const uploadData = await apiUpload(blob, "audio");
        await apiPost(`/api/orders/${orderId}/messages`, {
          kind: "voice",
          voiceNoteUrl: uploadData.secure_url,
          voiceNoteDuration: Math.max(1, recordSeconds),
        });
        load();
      } catch (err) {
        setError(err.message);
      } finally {
        setUploading(false);
        setRecording(false);
        setRecordSeconds(0);
      }
    },
  });

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

  const load = async () => {
    try {
      const res = await apiGet(`/api/orders/${orderId}`);
      setOrder(res.data.order);
      const history = await apiGet(`/api/orders/${orderId}/messages`);
      setMessages(history.data.messages);
      const offersRes = await apiGet(`/api/orders/${orderId}/offers`);
      setOffers(offersRes.data.offers);
    } catch (err) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
    // Mark the chat as read while it is open
    apiPost(`/api/orders/${orderId}/read`, {}).catch(() => {});
    const onChanged = () => {
      load();
      apiPost(`/api/orders/${orderId}/read`, {}).catch(() => {});
    };
    socketListen("chat:message", onChanged);
    socketListen("order:status", onChanged);
    socketListen("order:offersChanged", onChanged);

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
  }, [orderId]);

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
      dispatch(
        notificationActions.addNotification({
          message: "Отклик принят — водитель назначен",
          type: "success",
        })
      );
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

  const toggleRecording = () => {
    if (recording) {
      clearInterval(recordTimerRef.current);
      stopRecording();
    } else {
      setRecordSeconds(0);
      recordTimerRef.current = setInterval(
        () => setRecordSeconds((seconds) => seconds + 1),
        1000
      );
      setRecording(true);
      startRecording();
    }
  };

  const onPickPhoto = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      setUploading(true);
      const uploadData = await apiUpload(file, "image");
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
    return (
      <div className="p-6 text-danger">
        {error}
        <button className="btn-back" onClick={onBack}><TaxiIcon name="back" /> Назад</button>
      </div>
    );
  }
  if (!order) return <div className="p-6">Загрузка...</div>;

  const CALLABLE = ["ASSIGNED", "ARRIVING", "WAITING", "IN_RIDE"];
  const canRate = order.status === "COMPLETED" && !rated;
  const peerLine = myRole === "passenger" && order.driver
    ? `${order.driver.displayName}${order.driver.carCaption ? ` · ${order.driver.carCaption}` : ""}`
    : myRole === "driver" && order.passenger?.name
      ? order.passenger.name
      : null;

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
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[1.4rem] text-secondary-text">
             <span><IconText>{statusBadge(order.status)}</IconText></span>
             <span><TaxiIcon name="time" className="inline-block align-[-0.2em]" /> {formatWhen(order.when)}</span>
             {order.priceAgreed ? <span className="text-cta-icon font-semibold"><TaxiIcon name="cash" className="inline-block align-[-0.2em]" /> {order.priceAgreed}</span> : null}
          </div>
          {peerLine && (
            <div className="mt-1 break-words text-[1.4rem] text-primary-text">
              {myRole === "passenger"
                ? <><TaxiIcon name="driver" className="inline-block align-[-0.2em]" /> {peerLine}</>
                : <><TaxiIcon name="passenger" className="inline-block align-[-0.2em]" /> {peerLine}</>}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 mt-2 justify-center">
          {isParticipant && CALLABLE.includes(order.status) && otherId && (
            <button
              className="bg-success text-white px-3 py-1.5 rounded-lg text-sm"
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
            ["ASSIGNED", "ARRIVING", "WAITING", "IN_RIDE", "PUBLISHED"].includes(order.status) && (
              <button className="bg-danger text-white px-3 py-1.5 rounded-lg text-sm" onClick={sos}>
                SOS
              </button>
            )}
          {isParticipant && (
            <button className="border border-secondary-text/40 px-3 py-1.5 rounded-lg text-sm" onClick={share}>
               <TaxiIcon name="share" className="inline-block align-[-0.2em]" /> Поделиться
            </button>
          )}
          {isParticipant && otherId && (
            <button className="underline text-secondary-text text-sm" onClick={blockPeer}>
              Блок
            </button>
          )}
        </div>

      {error && <div className="text-danger text-sm px-3 py-1">{error}</div>}

      {order.status === "PUBLISHED" && offers.length > 0 && (
        <div className="p-3 border-b border-secondary-text/20 space-y-2 text-center">
          <div className="text-xs text-secondary-text">Отклики водителей · {offers.length}</div>
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
                    className="ml-auto bg-success text-white px-3 py-1 rounded shrink-0"
                    onClick={() => acceptOffer(offer._id)}
                  >
                    Принять
                  </button>
                )}
                {offer.status === "ACCEPTED" && (
                  <span className="ml-auto text-success text-xs shrink-0">Принят</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {messages.map((message) => {
          if (message.kind === "system") {
            return (
              <div key={message._id} className="text-center text-xs text-secondary-text py-1">
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
                      className="btn-accent press px-3 py-1 rounded-xl text-sm font-semibold"
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
                {message.senderName && <div className="text-xs text-secondary-text">{message.senderName}</div>}
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
                {message.senderName && <div className="text-xs text-secondary-text">{message.senderName}</div>}
                <div className="flex items-center gap-2">
                   <TaxiIcon name="microphone" />
                  <audio controls src={message.meta?.voiceNoteUrl} />
                  {message.meta?.voiceNoteDuration && (
                    <span className="text-xs text-secondary-text">
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
              {message.senderName && <div className="text-xs text-secondary-text">{message.senderName}</div>}
              {message.body}
            </div>
          );
        })}
      </div>

      {isParticipant && canRate && (
        <div className="p-3 border-t border-secondary-text/20">
          <div className="text-sm mb-1">Оцените поездку:</div>
          <div className="flex gap-1">
            {[1, 2, 3, 4, 5].map((value) => (
              <button
                key={value}
                className={`text-xl ${value <= stars ? "text-warning" : "text-secondary-text"}`}
                onClick={() => rate(value)}
                aria-label={`Оценить поездку на ${value} ${
                  value === 1 ? "звезду" : value < 5 ? "звезды" : "звёзд"
                }`}
              >
                 <TaxiIcon name="starFilled" />
              </button>
            ))}
          </div>
        </div>
      )}

      <form
        className="flex items-center gap-1 p-1.5 pl-2 rounded-full bg-[#141414]/90 border border-secondary-text/25 safe-area-bottom"
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
          onClick={toggleRecording}
        >
           <TaxiIcon name={recording ? "record" : "microphone"} />{recording ? ` ${recordSeconds}с` : null}
        </button>
        <input
          className="flex-1 min-w-0 bg-transparent text-white placeholder:text-secondary-text px-2 py-1.5 text-[1.8rem] focus:outline-none"
          value={text}
          // Keyboard opens only after an explicit tap or focus on the field
          readOnly={!armed}
          onPointerDown={() => setArmed(true)}
          onFocus={() => setArmed(true)}
          onChange={(event) => setText(event.target.value)}
          placeholder={uploading ? "Загрузка..." : "Введите сообщение"}
          disabled={uploading || recording}
        />
         <button className="press btn-accent shrink-0 w-[3.6rem] h-[3.6rem] rounded-full flex items-center justify-center text-[1.4rem] font-bold disabled:opacity-40" type="submit" disabled={!text.trim() || uploading || recording} aria-label="Отправить"><TaxiIcon name="send" /></button>
      </form>
    </div>
  );
};

export default OrderChat;


