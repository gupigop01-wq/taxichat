import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiPost, apiUpload } from "./api";
import useSocket from "../hooks/useSocket";
import { useDialog } from "./AppDialog";
import { IconText } from "./TaxiIcon";
import useVoiceNote from "./useVoiceNote";

// Direct dialog between a passenger and a driver after a call (concept 1.6)
const DirectChat = ({ chatId, me, onBack }) => {
  const { confirm } = useDialog();
  const { socket } = useSocket();
  const [chat, setChat] = useState(null);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState("");
  const [error, setError] = useState(null);
  const [blocked, setBlocked] = useState(false);
  const [uploading, setUploading] = useState(false);

  const load = useCallback(async () => {
    try {
      const history = await apiGet(`/api/chats/${chatId}/messages`);
      setMessages(history.data.messages);
    } catch (err) {
      setError(err.message);
    }
  }, [chatId]);

  useEffect(() => {
    apiGet("/api/chats/my")
      .then((res) => {
        const found = res.data.chats.find((item) => String(item._id) === String(chatId));
        setChat(found ?? { peer: { name: "Диалог" } });
      })
      .catch((err) => setError(err.message));
    load();
    // Mark the dialog as read while it is open
    apiPost(`/api/chats/${chatId}/read`, {}).catch(() => {});
    const onChanged = () => {
      load();
      apiPost(`/api/chats/${chatId}/read`, {}).catch(() => {});
    };
    socket.on("chat:message", onChanged);
    return () => {
      socket.off("chat:message", onChanged);
    };
  }, [chatId, load, socket]);

  const send = useCallback(async (payload) => {
    try {
      await apiPost(`/api/chats/${chatId}/messages`, payload);
      setText("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }, [chatId, load]);

  const voice = useVoiceNote({
    // No context while blocked: the hook skips the upload altogether
    context: blocked ? null : { chatId },
    onBlob: (uploadData, seconds) => {
      // The block may have landed while the recording was in flight
      if (blocked) return undefined;
      return send({ kind: "voice", voiceNoteUrl: uploadData.secure_url, voiceNoteDuration: seconds });
    },
  });
  // A recording error is shown in the same banner as the send errors
  useEffect(() => {
    if (voice.error) setError(voice.error);
  }, [voice.error]);

  const blockPeer = async () => {
    if (!chat?.peer?._id) return;
    if (!(await confirm({ title: "Заблокировать собеседника?", text: "Звонки и диалоги станут недоступны.", okText: "Заблокировать", danger: true }))) return;
    try {
      await apiPost("/api/blocks", { userId: String(chat.peer._id) });
      setBlocked(true);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  };

  const fileInputRef = useRef();
  const recording = voice.recording;
  const recordSeconds = voice.recordSeconds;
  const busy = uploading || voice.uploading;

  const onPickPhoto = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || blocked) return;
    try {
      setUploading(true);
      const uploadData = await apiUpload(file, "image", { chatId });
      await send({ kind: "photo", imageUrl: uploadData.secure_url });
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  };

  const renderMessage = (message) => {
    if (message.kind === "photo") {
      return (
        <div
          key={message._id}
          className={`max-w-[82%] rounded-2xl p-2.5 text-[1.8rem] leading-snug ${message.mine ? "btn-accent ml-auto" : "glass"}`}
        >
          {message.senderName && <div className="text-xs text-secondary-text">{message.senderName}</div>}
          <img src={message.meta?.imageUrl} alt={`Фото от ${message.senderName ?? "участника"}`} className="rounded max-h-[16rem]" />
        </div>
      );
    }
    if (message.kind === "voice") {
      return (
        <div
          key={message._id}
          className={`max-w-[82%] rounded-2xl p-2.5 text-[1.8rem] leading-snug ${message.mine ? "btn-accent ml-auto" : "glass"}`}
        >
          {message.senderName && <div className="text-xs text-secondary-text">{message.senderName}</div>}
          <div className="flex flex-wrap items-center gap-2 min-w-0">
             <span className="shrink-0"><IconText>🎤</IconText></span>
            <audio controls src={message.meta?.voiceNoteUrl} className="w-full max-w-[13rem] min-w-0" />
          </div>
        </div>
      );
    }
    return (
      <div
        key={message._id}
        className={`max-w-[82%] rounded-2xl p-2.5 text-[1.8rem] leading-snug break-words ${message.mine ? "btn-accent ml-auto" : "glass"}`}
      >
        {message.senderName && <div className="text-xs text-secondary-text">{message.senderName}</div>}
        {message.body}
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 p-3 border-b border-secondary-text/20">
        <button type="button" className="underline shrink-0 text-sm" onClick={onBack}>← Назад</button>
        <div className="text-center flex-1 min-w-0 font-semibold truncate">
          Диалог: {chat?.peer?.name ?? "..."}
        </div>
        {chat?.peer?._id && (
          <button
            type="button"
            className="shrink-0 underline text-secondary-text text-sm"
            aria-label="Заблокировать собеседника"
            onClick={blockPeer}
          >
            Блок
          </button>
        )}
      </div>

      {blocked && (
        <div role="status" className="text-success text-sm px-3 py-1">
          Диалог заблокирован: отправка сообщений недоступна
        </div>
      )}
      {error && <div role="alert" className="text-danger text-sm px-3 py-1">{error}</div>}

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2" role="log" aria-label="Сообщения диалога" aria-live="polite" aria-relevant="additions text">
        {messages.length === 0 && (
          <div className="text-secondary-text text-sm">
            Сообщений пока нет. Диалог появился после звонка.
          </div>
        )}
        {messages.map(renderMessage)}
      </div>

      <form
        className="flex gap-2 p-3 border-t border-secondary-text/20 min-w-0"
        onSubmit={(event) => {
          event.preventDefault();
          if (blocked) return;
          if (text.trim() && !busy && !recording) send({ body: text });
        }}
      >
        <input ref={fileInputRef} type="file" accept="image/*" hidden aria-label="Выбрать фото" onChange={onPickPhoto} />
        <button type="button" aria-label="Прикрепить фото" disabled={blocked || busy || recording} className="px-2 text-lg shrink-0" onClick={() => fileInputRef.current?.click()}>
           <IconText>📷</IconText>
        </button>
        <button
          type="button"
          aria-label={recording ? "Остановить запись голосового сообщения" : "Записать голосовое сообщение"}
          aria-pressed={recording}
          disabled={blocked || busy}
          className={`px-2 text-lg shrink-0 ${recording ? "text-danger animate-pulse" : ""}`}
          onClick={voice.toggle}
        >
           <IconText>{recording ? `⏺ ${recordSeconds}с` : "🎤"}</IconText>
        </button>
        <input
          aria-label="Сообщение"
          className="flex-1 min-w-0 bg-[#0d0d0d] text-white placeholder:text-secondary-text border border-secondary-text/30 rounded-2xl px-3 sm:px-4 py-2.5 text-[1.5rem] focus:border-accent focus:outline-none transition-colors"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={blocked ? "Диалог заблокирован" : busy ? "Загрузка..." : "Сообщение..."}
          disabled={blocked || busy || recording}
        />
         <button className="press btn-accent px-3 sm:px-4 rounded-2xl font-display font-bold shrink-0" type="submit" onMouseDown={(event) => event.preventDefault()} aria-label="Отправить сообщение" disabled={blocked || !text.trim() || busy || recording}><IconText>➤</IconText></button>
      </form>
    </div>
  );
};

export default DirectChat;
