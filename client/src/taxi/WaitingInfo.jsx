import { useEffect, useState } from "react";
import TaxiIcon from "./TaxiIcon";

const mmss = (ms) => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

// Free/paid waiting counter. The server sends the snapshot taken at "Я на
// месте" (free window, rate, billing stop), so all roles see the same numbers;
// the client only ticks the clock while the waiting is still running.
const WaitingInfo = ({ waiting, className = "" }) => {
  const active = Boolean(waiting && !waiting.endedAt);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  if (!waiting) return null;

  const startedAtMs = new Date(waiting.startedAt).getTime();
  const freeEndsAt = new Date(waiting.freeEndsAt).getTime();
  const endMs = waiting.endedAt ? new Date(waiting.endedAt).getTime() : now;
  const paidMs = Math.max(0, endMs - freeEndsAt);
  const paidMinutes = Math.ceil(paidMs / 60000);
  const fee = paidMinutes * (waiting.pricePerMin ?? 0);
  const rate = waiting.pricePerMin > 0 ? ` · далее ${waiting.pricePerMin} ₽/мин` : "";

  // A booking's free window is anchored to the booked time: an early check-in
  // waits for that moment and is not billed before it.
  if (waiting.endedAt && endMs < startedAtMs) {
    return (
      <div className={`flex items-center gap-2 text-secondary-text ${className}`}>
        <TaxiIcon name="time" size={18} className="shrink-0" />
        <span>Ожидание по брони не начиналось</span>
      </div>
    );
  }

  if (!waiting.endedAt && now < startedAtMs) {
    return (
      <div className={`flex items-center gap-2 text-secondary-text ${className}`}>
        <TaxiIcon name="time" size={18} className="shrink-0" />
        <span>Ожидание по брони · старт через {mmss(startedAtMs - now)}</span>
      </div>
    );
  }

  if (paidMs <= 0) {
    return (
      <div className={`flex items-center gap-2 text-secondary-text ${className}`}>
        <TaxiIcon name="time" size={18} className="shrink-0" />
        <span>
          Бесплатное ожидание
          {active ? ` · осталось ${mmss(freeEndsAt - now)}` : ""}
          {active ? rate : ""}
        </span>
      </div>
    );
  }

  if (fee > 0) {
    return (
      <div className={`flex items-center gap-2 text-danger font-semibold ${className}`}>
        <TaxiIcon name="cash" size={18} className="shrink-0" />
        <span>
          Платное ожидание · {paidMinutes} мин · {fee} ₽
          {active ? ` · ${waiting.pricePerMin} ₽/мин` : ""}
        </span>
      </div>
    );
  }

  // The free window is over, but the city has no rate: show the elapsed time
  return (
    <div className={`flex items-center gap-2 text-secondary-text ${className}`}>
      <TaxiIcon name="time" size={18} className="shrink-0" />
      <span>
        Ожидание · {Math.ceil(Math.max(0, endMs - new Date(waiting.startedAt).getTime()) / 60000)} мин
      </span>
    </div>
  );
};

export default WaitingInfo;
