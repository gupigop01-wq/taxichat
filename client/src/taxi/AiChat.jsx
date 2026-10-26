import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiGet, apiPost } from "./api";
import useSocket from "../hooks/useSocket";
import TaxiIcon, { IconText } from "./TaxiIcon";
import { useDialog } from "./AppDialog";

// AI dispatcher tab: one conversation per user + city + role. The server
// answers either from the deterministic router (instant) or from the LLM,
// and every database change goes through validated tools.
const AI_ROLE = {
  passenger: "passenger",
  driver: "driver",
  dispatcher: "dispatcher",
  region_admin: "dispatcher",
};

const ROLE_LABEL = {
  passenger: "Пассажир",
  driver: "Водитель",
  dispatcher: "Диспетчер",
};

const PROVIDER_LABEL = {
  local: "Локальная",
  groq: "Groq",
  gemini: "Gemini",
  openrouter: "OpenRouter",
  gigachat: "GigaChat",
  custom: "LLM",
  off: "Правила",
};

const PLACEHOLDER = {
  passenger: "Куда едем?",
  driver: "Напишите «на линии»",
  dispatcher: "Например: «обстановка»",
};

const VOICE_KEY = "bombila.aiVoice";

const recognitionCtor = () =>
  typeof window !== "undefined"
    ? window.SpeechRecognition || window.webkitSpeechRecognition
    : null;

const speak = (text) => {
  if (typeof window === "undefined" || !window.speechSynthesis || !text) return;
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "ru-RU";
    utterance.rate = 1.05;
    window.speechSynthesis.speak(utterance);
  } catch (err) {
    // Synthesizer unavailable: keep the chat silent instead of crashing
  }
};

const timeOf = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
};

// Suggestion chips share one row and one width. A label longer than its pill
// scrolls inside the pill as a ticker instead of stretching the row.
const QuickChip = ({ label, disabled, onPick }) => {
  const holderRef = useRef(null);
  const [shift, setShift] = useState(0);

  useEffect(() => {
    const holder = holderRef.current;
    if (!holder) return undefined;
    const measure = () => setShift(Math.max(0, holder.scrollWidth - holder.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(holder);
    return () => observer.disconnect();
  }, [label]);

  return (
    <button
      type="button"
      className="press flex-1 basis-0 min-w-0 only:flex-none only:max-w-full rounded-full border border-secondary-text/40 bg-secondary px-3.5 py-2 text-[1.4rem] font-medium text-primary-text"
      disabled={disabled}
      onClick={onPick}
    >
      <span
        ref={holderRef}
        className={`quick-chip-holder block ${shift ? "text-left" : "text-center"}`}
      >
        <span
          className={`quick-chip-track ${shift ? "is-scrolling" : ""}`}
          style={
            shift
              ? {
                  "--chip-shift": `-${shift}px`,
                  animationDuration: `${Math.max(2.5, shift / 22).toFixed(1)}s`,
                }
              : undefined
          }
        >
          {label}
        </span>
      </span>
    </button>
  );
};

const AiChat = ({ cityId, cityName, role }) => {
  const { socket } = useSocket();
  const { ask } = useDialog();
  const aiRole = AI_ROLE[role] ?? "passenger";

  const chatIdRef = useRef(null);
  const [messages, setMessages] = useState([]);
  const [quick, setQuick] = useState([]);
  const [pending, setPending] = useState(null);
  const [input, setInput] = useState("");
  const [typing, setTyping] = useState(false);
  const [sending, setSending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [ai, setAi] = useState(null);
  const [latency, setLatency] = useState(null);
  const [online, setOnline] = useState(socket.connected);
  const [listening, setListening] = useState(false);
  const [actionState, setActionState] = useState({});
  const [settledAt, setSettledAt] = useState({});
  const [voiceOut, setVoiceOut] = useState(
    () => typeof window !== "undefined" && localStorage.getItem(VOICE_KEY) === "1"
  );

  const listRef = useRef(null);
  const messageRef = useRef(null);
  const recognitionRef = useRef(null);
  const canSpeak = typeof window !== "undefined" && "speechSynthesis" in window;
  const canListen = Boolean(recognitionCtor());

  const addMessage = useCallback((message) => {
    if (!message) return;
    setMessages((prev) => {
      if (prev.some((item) => String(item._id) === String(message._id))) return prev;
      let next = prev;
      // Replace the optimistic bubble with the stored message
      if (message.mine) {
        const index = prev.findIndex((item) => item.temp && item.body === message.body);
        if (index !== -1) next = [...prev.slice(0, index), ...prev.slice(index + 1)];
      }
      return [...next, message].sort(
        (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
      );
    });
  }, []);

  // History of the current city + role thread
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setMessages([]);
    setQuick([]);
    setPending(null);
    chatIdRef.current = null;
    setTyping(false);
    setLatency(null);
    setActionState({});
    setSettledAt({});

    apiGet(`/api/ai/chat?cityId=${encodeURIComponent(cityId)}&role=${aiRole}`)
      .then((res) => {
        if (cancelled) return;
        const data = res.data;
        chatIdRef.current = String(data.chatId);
        setMessages(data.messages ?? []);
        setQuick(data.quick ?? []);
        setPending(data.pending ? { summary: data.pending.summary, tool: data.pending.tool } : null);
        setAi(data.ai ?? null);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [cityId, aiRole]);

  // Live replies arrive through the user room; the REST response carries the
  // same messages, so addMessage dedupes by _id.
  useEffect(() => {
    const onMessage = (payload) => {
      if (!payload?.message) return;
      if (String(payload.chatId) !== chatIdRef.current) return;
      addMessage(payload.message);
      if (payload.message.senderType === "bot" && payload.message.meta?.quick?.length) {
        setQuick(payload.message.meta.quick);
      }
    };
    const onTyping = (payload) => {
      if (String(payload?.chatId) !== chatIdRef.current) return;
      setTyping(Boolean(payload.typing));
    };
    // The cleanup sweep tells open threads which bubbles it removed, so stale
    // events vanish without waiting for a reload.
    const onCleanup = (payload) => {
      if (String(payload?.chatId) !== chatIdRef.current) return;
      const ids = new Set((payload.ids ?? []).map(String));
      if (!ids.size) return;
      setMessages((prev) => prev.filter((item) => !ids.has(String(item._id))));
    };
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);

    // The socket may have connected before this effect subscribed
    setOnline(socket.connected);
    socket.on("ai:message", onMessage);
    socket.on("ai:typing", onTyping);
    socket.on("ai:cleanup", onCleanup);
    socket.on("connect", onOnline);
    socket.on("disconnect", onOffline);
    return () => {
      socket.off("ai:message", onMessage);
      socket.off("ai:typing", onTyping);
      socket.off("ai:cleanup", onCleanup);
      socket.off("connect", onOnline);
      socket.off("disconnect", onOffline);
    };
  }, [socket, addMessage]);

  useEffect(() => {
    const view = listRef.current;
    if (view) view.scrollTop = view.scrollHeight;
  }, [messages, typing, pending, loading]);

  // rows={1} textareas do not grow on their own, so the height is measured after
  // every change; the CSS max-height caps it at roughly five lines and the
  // overflow then scrolls inside the field. An empty field keeps its one-line
  // height instead of stretching to the wrapped placeholder.
  useEffect(() => {
    const field = messageRef.current;
    if (!field) return;
    if (!input) {
      field.style.height = "";
      return;
    }
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight}px`;
  }, [input]);

  useEffect(
    () => () => {
      try {
        recognitionRef.current?.stop();
      } catch (err) {
        // Already stopped
      }
      if (canSpeak) window.speechSynthesis?.cancel?.();
    },
    [canSpeak]
  );

  const send = useCallback(
    async (raw) => {
      const value = String(raw ?? "").trim();
      if (!value || sending || !cityId) return;
      if (listening) {
        try {
          recognitionRef.current?.stop();
        } catch (err) {
          // Already stopped
        }
      }

      setSending(true);
      setError(null);
      // A new message always abandons the pending action on the server
      setPending(null);
      setInput("");
      setTyping(true);
      const temp = {
        _id: `temp-${Date.now()}`,
        body: value,
        mine: true,
        temp: true,
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, temp]);

      try {
        const res = await apiPost("/api/ai/messages", { cityId, role: aiRole, text: value });
        const data = res.data;
        chatIdRef.current = String(data.chatId);
        addMessage(data.userMessage);
        addMessage(data.reply);
        setQuick(data.quick ?? []);
        setPending(data.confirm ? { ...data.confirm } : null);
        setLatency(data.latencyMs ?? null);
        if (voiceOut) speak(data.text);
      } catch (err) {
        setMessages((prev) => prev.filter((item) => item._id !== temp._id));
        setInput(value);
        setError(err.message);
      } finally {
        setSending(false);
        setTyping(false);
      }
    },
    [cityId, aiRole, sending, listening, addMessage, voiceOut]
  );

  const decide = async (approve) => {
    if (!pending || confirming) return;
    setConfirming(true);
    setError(null);
    setTyping(true);
    try {
      const res = await apiPost("/api/ai/confirm", { cityId, role: aiRole, approve });
      const data = res.data;
      addMessage(data.userMessage);
      addMessage(data.reply);
      setQuick(data.quick ?? []);
      setPending(null);
      if (voiceOut) speak(data.text);
    } catch (err) {
      setError(err.message);
    } finally {
      setConfirming(false);
      setTyping(false);
    }
  };

  const toggleListening = () => {
    const Ctor = recognitionCtor();
    if (!Ctor) {
      setError("Голосовой ввод не поддерживается этим браузером");
      return;
    }
    if (listening) {
      try {
        recognitionRef.current?.stop();
      } catch (err) {
        // Already stopped
      }
      return;
    }

    const recognition = new Ctor();
    recognition.lang = "ru-RU";
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => {
      const transcript = event.results?.[0]?.[0]?.transcript?.trim();
      if (transcript) setInput((prev) => (prev ? `${prev} ${transcript}` : transcript));
    };
    recognition.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        setError("Разрешите доступ к микрофону в настройках браузера");
      } else if (event.error !== "no-speech" && event.error !== "aborted") {
        setError("Не удалось распознать речь, попробуйте ещё раз");
      }
    };
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    setListening(true);
    setError(null);
    try {
      recognition.start();
    } catch (err) {
      setListening(false);
    }
  };

  const toggleVoiceOut = () => {
    setVoiceOut((prev) => {
      const next = !prev;
      localStorage.setItem(VOICE_KEY, next ? "1" : "0");
      if (!next && canSpeak) window.speechSynthesis?.cancel?.();
      return next;
    });
  };

  const providerLabel = ai?.configured
    ? `${PROVIDER_LABEL[ai.provider] ?? ai.provider}${
        ai.keyCount > 1 ? ` ×${ai.keyCount}` : ""
      }`
    : "Правила";

  // Status feed messages carry their own buttons, so the order can be run from
  // the chat. After a successful action every button on older messages of the
  // same order is retired, and so is every message that a newer feed event has
  // already superseded: the newest event always holds the valid next step.
  const latestEventAt = useMemo(() => {
    const map = {};
    for (const message of messages) {
      const orderId = message.meta?.orderId;
      if (message.meta?.kind !== "order_event" || !orderId) continue;
      const key = String(orderId);
      const at = new Date(message.createdAt).getTime();
      if (!map[key] || at > map[key]) map[key] = at;
    }
    return map;
  }, [messages]);

  const actionKey = (message, action) => `${message._id}:${action.key}`;
  const isSettled = (message) => {
    const key = String(message.meta?.orderId);
    const at = new Date(message.createdAt).getTime();
    if (latestEventAt[key] && at < latestEventAt[key]) return true;
    const settled = settledAt[key];
    return settled ? at <= settled : false;
  };

  // An offer is the driver's own bid, so the button asks price and ETA in the
  // same two steps as the order card and sends it without leaving the chat.
  const sendOffer = async (message) => {
    const priceText = await ask({
      title: "Цена поездки",
      placeholder: "Например: 350",
      okText: "Далее",
    });
    if (!priceText) return false;
    let note = "За сколько минут подадите машину";
    let etaMin = null;
    while (etaMin === null) {
      const raw = await ask({
        title: "Время подачи, минут",
        text: note,
        initial: "10",
        inputMode: "numeric",
        autoSelect: true,
        okText: "Отправить",
      });
      if (raw === null) return false;
      const value = Number(raw);
      if (Number.isInteger(value) && value >= 1 && value <= 180) etaMin = value;
      else note = "Целое число от 1 до 180 минут";
    }
    await apiPost(`/api/orders/${message.meta.orderId}/offers`, { priceText, etaMin });
    return true;
  };

  const runAction = async (message, action) => {
    const key = actionKey(message, action);
    if (actionState[key] === "busy" || actionState[key] === "done") return;
    if (action.type === "open") {
      window.dispatchEvent(
        new CustomEvent("bombila:open-order", {
          detail: { orderId: String(message.meta.orderId) },
        })
      );
      return;
    }
    if (action.type === "offer") {
      try {
        const sent = await sendOffer(message);
        if (!sent) return;
        setActionState((prev) => ({ ...prev, [key]: "done" }));
        setSettledAt((prev) => ({
          ...prev,
          [String(message.meta.orderId)]: Date.now(),
        }));
      } catch (err) {
        setActionState((prev) => ({ ...prev, [key]: "error" }));
        setError(err.message);
      }
      return;
    }
    setActionState((prev) => ({ ...prev, [key]: "busy" }));
    setError(null);
    try {
      await apiPost(action.path, action.body ?? {});
      setActionState((prev) => ({ ...prev, [key]: "done" }));
      setSettledAt((prev) => ({
        ...prev,
        [String(message.meta.orderId)]: Date.now(),
      }));
    } catch (err) {
      setActionState((prev) => ({ ...prev, [key]: "error" }));
      setError(err.message);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-secondary-text/15 text-[1.1rem] text-secondary-text">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${online ? "bg-success" : "bg-danger"}`}
          aria-hidden="true"
        />
        <span>{online ? "на связи" : "нет сети"}</span>
        <span className="opacity-40">·</span>
        <span className="truncate">{providerLabel}</span>
        {latency != null && (
          <>
            <span className="opacity-40">·</span>
            <span className="shrink-0">
              {latency < 1000 ? `${latency} мс` : `${(latency / 1000).toFixed(1)} с`}
            </span>
          </>
        )}
        <span className="ml-auto shrink-0">{ROLE_LABEL[aiRole]}</span>
        {canSpeak && (
          <button
            type="button"
            className={`ml-1 shrink-0 ${voiceOut ? "text-accent" : ""}`}
            aria-label={voiceOut ? "Выключить озвучивание ответов" : "Озвучивать ответы"}
            aria-pressed={voiceOut}
            onClick={toggleVoiceOut}
          >
            <IconText>{voiceOut ? "🔊" : "🔇"}</IconText>
          </button>
        )}
      </div>

      {error && (
        <div role="alert" className="text-danger text-sm px-3 py-1">
          {error}
        </div>
      )}

      <div
        ref={listRef}
        className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2"
        role="log"
        aria-label={`Диалог с AI-диспетчером${cityName ? `, ${cityName}` : ""}`}
        aria-live="polite"
        aria-relevant="additions text"
      >
        {loading && <div className="text-secondary-text text-sm">Загружаю диалог…</div>}
        {!loading && messages.length === 0 && (
          <div className="text-secondary-text text-sm">
            Напишите или скажите, что нужно, — я оформлю заказ, покажу отклики и проведу по поездке.
          </div>
        )}

        {messages.map((message) => (
          <div
            key={message._id}
            className={`max-w-[86%] rounded-2xl px-3.5 py-2.5 text-[1.45rem] leading-snug whitespace-pre-line break-words ${
              message.mine ? "btn-accent ml-auto" : "glass"
            } ${message.temp ? "opacity-60" : ""}`}
          >
            {message.body}
            {!message.mine && message.meta?.orderId && (
              <button
                type="button"
                className="press mt-2.5 flex items-center gap-2 rounded-full border border-secondary-text/40 bg-secondary px-4 py-2.5 text-[1.35rem] font-semibold text-primary-text"
                aria-label={`Открыть карточку заказа #${String(message.meta.orderId).slice(-6)}`}
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent("bombila:open-order", {
                      detail: { orderId: String(message.meta.orderId) },
                    })
                  )
                }
              >
                <TaxiIcon name="route" size={17} />
                Карточка заказа #{String(message.meta.orderId).slice(-6)}
              </button>
            )}
            {!message.mine && message.meta?.actions?.length > 0 && (
              <div className="mt-2.5 flex flex-wrap gap-2">
                {message.meta.actions.map((action) => {
                  const state = actionState[actionKey(message, action)];
                  const done = state === "done" || isSettled(message);
                  return (
                    <button
                      key={action.key}
                      type="button"
                      className={`press rounded-xl border px-4 py-2.5 text-[1.35rem] font-semibold ${
                        action.danger
                          ? "border-danger/60 text-danger"
                          : "border-accent/60 text-accent"
                      } ${done ? "opacity-45" : ""}`}
                      disabled={state === "busy" || done}
                      onClick={() => runAction(message, action)}
                    >
                      {state === "busy"
                        ? "Выполняю…"
                        : done
                          ? `✓ ${action.label}`
                          : action.label}
                    </button>
                  );
                })}
              </div>
            )}
            <div
              className={`mt-1 text-right text-[1.1rem] ${
                message.mine ? "text-black/50" : "text-secondary-text"
              }`}
            >
              {timeOf(message.createdAt)}
            </div>
          </div>
        ))}

        {typing && (
          <div className="glass inline-flex items-center gap-1 rounded-2xl px-3 py-2" aria-label="AI-диспетчер печатает">
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-secondary-text" style={{ animationDelay: "-0.2s" }} />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-secondary-text" style={{ animationDelay: "-0.1s" }} />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-secondary-text" />
          </div>
        )}
      </div>

      {pending && (
        <div className="glass-strong mx-3 mb-2 rounded-2xl p-3 space-y-2.5" role="group" aria-label="Подтверждение действия">
          <div className="text-[1.5rem]">{pending.summary}.</div>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-accent press flex-1 rounded-xl py-2.5 text-[1.4rem] font-bold"
              disabled={confirming}
              onClick={() => decide(true)}
            >
              Подтвердить
            </button>
            <button
              type="button"
              className="press flex-1 rounded-xl border border-secondary-text/30 bg-secondary py-2.5 text-[1.4rem] font-semibold"
              disabled={confirming}
              onClick={() => decide(false)}
            >
              Отмена
            </button>
          </div>
        </div>
      )}

      {!loading && quick.length > 0 && !typing && !pending && (
        <div className="flex flex-nowrap gap-2 px-3 pb-1">
          {quick.map((item) => (
            <QuickChip key={item} label={item} disabled={sending} onPick={() => send(item)} />
          ))}
        </div>
      )}

      <form
        className="flex items-end gap-2 p-3 border-t border-secondary-text/20 min-w-0"
        onSubmit={(event) => {
          event.preventDefault();
          send(input);
        }}
      >
        <button
          type="button"
          aria-label={listening ? "Остановить голосовой ввод" : "Сказать голосом"}
          aria-pressed={listening}
          disabled={sending || !canListen}
          className={`px-2 py-2.5 text-lg shrink-0 ${listening ? "text-danger animate-pulse" : ""}`}
          onClick={toggleListening}
        >
          <IconText>🎤</IconText>
        </button>
        <textarea
          ref={messageRef}
          rows={1}
          aria-label="Сообщение AI-диспетчеру"
          enterKeyHint="send"
          className="block flex-1 min-w-0 resize-none max-h-[12rem] overflow-y-auto bg-[#0d0d0d] text-white placeholder:text-secondary-text border border-secondary-text/30 rounded-2xl px-3 sm:px-4 py-2.5 text-[1.5rem] leading-snug focus:border-accent focus:outline-none transition-colors"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            if (!sending && input.trim()) send(input);
          }}
          placeholder={
            listening ? "Говорите…" : sending ? "Диспетчер отвечает…" : PLACEHOLDER[aiRole]
          }
          disabled={sending}
        />
        <button
          className="press btn-accent px-3 sm:px-4 py-2.5 rounded-2xl font-display font-bold shrink-0"
          type="submit"
          onMouseDown={(event) => event.preventDefault()}
          aria-label="Отправить сообщение"
          disabled={sending || !input.trim()}
        >
          <IconText>➤</IconText>
        </button>
      </form>
    </div>
  );
};

export default AiChat;
