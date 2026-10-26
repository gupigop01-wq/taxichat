import { useEffect, useId, useRef, useState } from "react";
import { startRingtone, stopRingtone, playDialTone } from "./ringtone";
import { IconText } from "./TaxiIcon";

// Full-screen call UI in the Android style.
// Incoming: accept / decline. Outgoing: "Вызов...". Active: duration, mute,
// speaker and a dialpad, no recording (as requested).
const formatDuration = (seconds) => {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
};

const CallModal = ({ call, acceptCall, endCall }) => {
  const audioRef = useRef();
  const actionRef = useRef(null);
  const panelRef = useRef(null);
  const nameId = useId();
  const [seconds, setSeconds] = useState(0);
  const [muted, setMuted] = useState(false);
  const [speaker, setSpeaker] = useState(false);
  const [dialOpen, setDialOpen] = useState(false);
  const [digits, setDigits] = useState("");

  useEffect(() => {
    const audio = audioRef.current;
    if (!call.remoteStream || !audio) return undefined;
    audio.srcObject = call.remoteStream;
    audio.play().catch(() => {});
    return () => {
      audio.pause();
      audio.srcObject = null;
    };
  }, [call.remoteStream]);

  // Ring while incoming; dial tone while the other side is being called
  useEffect(() => {
    if (call.status === "incoming") startRingtone(call.whoLabel);
    else if (call.status === "calling" || call.status === "ringing") {
      playDialTone();
      const id = setInterval(playDialTone, 3200);
      return () => {
        clearInterval(id);
        stopRingtone();
      };
    } else stopRingtone();
    return () => stopRingtone();
    // The ringtone follows the call state only: call changes identity on every status event
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call.status, call.whoLabel]);

  // Talk timer once the line is active
  useEffect(() => {
    if (call.status !== "active") { setSeconds(0); return undefined; }
    const id = setInterval(() => setSeconds((v) => v + 1), 1000);
    return () => clearInterval(id);
  }, [call.status]);

  // Mute / speaker on the live audio tracks
  useEffect(() => {
    if (call.audioTracks) call.audioTracks.forEach((t) => { t.enabled = !muted; });
  }, [muted, call.audioTracks]);
  useEffect(() => {
    // The sink is a stable callback from useCall: depending on it avoids extra runs
    if (call.speakerSink) call.speakerSink(speaker);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speaker, call.speakerSink]);

  useEffect(() => {
    if (call.status === "idle") return undefined;
    const previousFocus = document.activeElement;
    actionRef.current?.focus();
    const onKeyDown = (event) => {
      if (event.key !== "Tab") return;
      const controls = [...panelRef.current.querySelectorAll("button:not(:disabled)")];
      if (event.shiftKey && document.activeElement === controls[0]) {
        event.preventDefault();
        controls[controls.length - 1].focus();
      } else if (!event.shiftKey && document.activeElement === controls[controls.length - 1]) {
        event.preventDefault();
        controls[0].focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus?.();
    };
    // The trap follows visibility only; call is a new object on every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call.status]);

  if (call.status === "idle") return null;

  const incoming = call.status === "incoming";
  const active = call.status === "active";
  const failed = call.status === "failed";
  const outgoing = call.status === "calling" || call.status === "ringing" || call.status === "connecting";

  const statusText = incoming
    ? `Входящий звонок · ${call.peerRoleLabel ?? "участник"}`
    : outgoing
      ? `Вызов... · ${call.peerRoleLabel ?? "участник"}`
      : active
        ? formatDuration(seconds)
        : call.error ?? "Звонок не состоялся";

  return (
    <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={nameId} className="fixed inset-0 z-[12000] flex flex-col overflow-y-auto bg-[#0b0f14] text-white">
      <audio ref={audioRef} data-call-audio autoPlay />

      <div className="flex-1 flex flex-col items-center justify-center gap-3 px-4 py-4 text-center min-h-0">
        <div className="w-[6rem] h-[6rem] sm:w-[9rem] sm:h-[9rem] shrink-0 rounded-full bg-white/10 flex items-center justify-center text-[3rem] sm:text-[3.4rem]">
           <IconText>{call.peerEmoji ?? "👤"}</IconText>
        </div>
        <div id={nameId} className="font-display font-extrabold text-[1.7rem] sm:text-[2rem] break-words min-w-0 max-w-full">
          {call.peerName ?? "Участник"}
        </div>
        <div className={`text-[1.5rem] ${active ? "text-success" : "text-white/70"}`} aria-live={active ? "off" : "polite"}>
          {statusText}
        </div>
        {call.error && <div role="alert" className="text-danger text-[1.4rem]">{call.error}</div>}
      </div>

      {dialOpen && active && (
        <div className="px-4 sm:px-6 pb-4">
          <div className="text-center text-[1.8rem] min-h-[2.2rem] mb-2 break-all" aria-label={`Набрано: ${digits || "пусто"}`}>{digits}</div>
          <div className="grid grid-cols-3 gap-2 max-w-[22rem] mx-auto">
            {["1","2","3","4","5","6","7","8","9","*","0","#"].map((d) => (
              <button
                key={d}
                type="button"
                aria-label={`Набрать ${d}`}
                onClick={() => setDigits((v) => v + d)}
                className="py-3 rounded-xl bg-white/10 text-[1.6rem] font-semibold"
              >
                {d}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="p-4 sm:p-6 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {failed ? (
          <div className="flex justify-center">
            <button
              type="button"
              ref={actionRef}
              className="btn-accent press px-8 py-3 rounded-2xl font-semibold"
              onClick={() => endCall("hangup")}
            >
              Закрыть
            </button>
          </div>
        ) : incoming ? (
          <div className="flex items-center justify-around">
            <button
              type="button"
              ref={actionRef}
              className="w-[7rem] h-[7rem] rounded-full bg-danger flex items-center justify-center text-[2.4rem]"
              onClick={() => endCall("decline")}
              aria-label="Отклонить"
            >
               <IconText>📵</IconText>
            </button>
            <button
              type="button"
              className="w-[7rem] h-[7rem] rounded-full bg-success flex items-center justify-center text-[2.4rem] animate-pulse"
              onClick={acceptCall}
              aria-label="Ответить"
            >
               <IconText>📞</IconText>
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-center gap-2 sm:gap-4 mb-4 sm:mb-5">
              <button
                type="button"
                aria-pressed={muted}
                aria-label="Отключить микрофон"
                onClick={() => setMuted((v) => !v)}
                className={`w-[5rem] h-[5rem] sm:w-[6rem] sm:h-[6rem] rounded-full flex flex-col items-center justify-center text-[1.1rem] ${muted ? "bg-white text-black" : "bg-white/10"}`}
              >
                 <span className="text-[1.8rem]"><IconText>{muted ? "🔇" : "🎙"}</IconText></span>
                Микро
              </button>
              <button
                type="button"
                aria-pressed={speaker}
                aria-label="Громкая связь"
                onClick={() => setSpeaker((v) => !v)}
                className={`w-[5rem] h-[5rem] sm:w-[6rem] sm:h-[6rem] rounded-full flex flex-col items-center justify-center text-[1.1rem] ${speaker ? "bg-white text-black" : "bg-white/10"}`}
              >
                 <span className="text-[1.8rem]"><IconText>🔊</IconText></span>
                Громко
              </button>
              <button
                type="button"
                aria-pressed={dialOpen}
                aria-label="Клавиатура набора"
                onClick={() => setDialOpen((v) => !v)}
                className={`w-[5rem] h-[5rem] sm:w-[6rem] sm:h-[6rem] rounded-full flex flex-col items-center justify-center text-[1.1rem] ${dialOpen ? "bg-white text-black" : "bg-white/10"}`}
              >
                 <span className="text-[1.8rem]"><IconText>🔢</IconText></span>
                Клавиши
              </button>
            </div>
            <div className="flex justify-center">
              <button
                type="button"
                ref={actionRef}
                className="w-[7rem] h-[7rem] rounded-full bg-danger flex items-center justify-center text-[2.4rem]"
                onClick={() => endCall("hangup")}
                aria-label="Завершить"
              >
                 <IconText>📵</IconText>
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default CallModal;
