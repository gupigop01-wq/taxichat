import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconText } from "./TaxiIcon";
import { zonedWallToUtc, cityTimeZone } from "./statusLabels";

// Выбор времени «на время»: слайдеры часов (0–23) и минут (0–59) и полоса дат
// на две недели вперёд. Табло показывает часы ГОРОДА, а не устройства: Date
// внутри хранит настенное время в UTC-полях, поэтому getUTC* — это и есть
// выбранные человеком часы. Значение отдаётся как datetime-local.
const pad = (v) => String(v).padStart(2, "0");

const toLocalValue = (date) =>
  `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(
    date.getUTCDate()
  )}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;

const parseValue = (value) => {
  const match = String(value ?? "").match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/
  );
  if (!match) return new Date(Date.now() + 3600000);
  return new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]))
  );
};

const cityToday = (tz) => {
  const iso = new Intl.DateTimeFormat("en-CA", {
    timeZone: cityTimeZone(tz),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return new Date(`${iso}T00:00:00Z`);
};

const relativeLabel = (date, tz) => {
  const at = zonedWallToUtc(toLocalValue(date), tz);
  const diff = Math.round(((at?.getTime() ?? 0) - Date.now()) / 60000);
  if (diff <= 0) return "сейчас";
  if (diff < 60) return `через ${diff} мин`;
  const hours = Math.floor(diff / 60);
  const minutes = diff % 60;
  return `через ${hours} ч${minutes ? ` ${minutes} мин` : ""}`;
};

const isSameDay = (a, b) =>
  a.getUTCFullYear() === b.getUTCFullYear() &&
  a.getUTCMonth() === b.getUTCMonth() &&
  a.getUTCDate() === b.getUTCDate();

const dayLabel = (date, index) => {
  if (index === 0) return "Сегодня";
  if (index === 1) return "Завтра";
  return date.toLocaleDateString("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" });
};

const TimePicker = ({ value, onChange, open, onClose, title, tz }) => {
  const [cursor, setCursor] = useState(() => parseValue(value));
  const panelRef = useRef(null);
  const closeRef = useRef(null);
  const titleId = useId();
  const hourId = useId();
  const minuteId = useId();

  useEffect(() => {
    if (open) setCursor(parseValue(value));
  }, [open, value]);

  useEffect(() => {
    if (!open) return undefined;
    const previousFocus = document.activeElement;
    closeRef.current?.focus();
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "Tab") {
        const controls = [...panelRef.current.querySelectorAll("button, input")];
        if (event.shiftKey && document.activeElement === controls[0]) {
          event.preventDefault();
          controls[controls.length - 1].focus();
        } else if (!event.shiftKey && document.activeElement === controls[controls.length - 1]) {
          event.preventDefault();
          controls[0].focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  const today = cityToday(tz);
  const days = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() + i);
    return d;
  });

  const setDay = (day) => {
    const next = new Date(cursor);
    next.setUTCFullYear(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
    setCursor(next);
  };

  const setHour = (hour) => {
    const next = new Date(cursor);
    next.setUTCHours(hour);
    setCursor(next);
  };

  const setMinute = (minute) => {
    const next = new Date(cursor);
    next.setUTCMinutes(minute);
    setCursor(next);
  };

  const commit = () => {
    onChange(toLocalValue(cursor));
    onClose();
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[12000] flex items-center justify-center bg-black/70 px-3 py-4 anim-fade"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-[34rem] max-h-[calc(100dvh-2rem)] overflow-y-auto glass-strong rounded-3xl p-4 space-y-4 anim-sheet"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2">
           <div id={titleId} className="font-display font-extrabold text-[1.7rem]"><IconText>🕓</IconText> {title ?? "Когда подать"}</div>
           <button ref={closeRef} type="button" className="btn-back" onClick={onClose} aria-label="Закрыть"><IconText>✖️</IconText></button>
        </div>

        <div className="rounded-2xl bg-[#0d0d0d] border border-secondary-text/25 py-3 text-center">
          <div className="font-display font-extrabold text-[4rem] leading-none tracking-wide">
            {pad(cursor.getUTCHours())}
            <span className="text-secondary-text">:</span>
            {pad(cursor.getUTCMinutes())}
          </div>
          <div className="mt-1 text-[1.3rem] text-cta-icon font-semibold">
            {cursor.toLocaleDateString("ru-RU", {
              day: "numeric",
              month: "long",
              timeZone: "UTC",
            })}{" "}
            · {relativeLabel(cursor, tz)}
          </div>
        </div>

        <div className="flex gap-2 overflow-x-auto hide-scrollbar pb-1">
          {days.map((day, index) => {
            const selected = isSameDay(cursor, day);
            return (
              <button
                key={day.toISOString()}
                type="button"
                aria-pressed={selected}
                aria-label={day.toLocaleDateString("ru-RU", {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                  timeZone: "UTC",
                })}
                className={`press shrink-0 px-3 py-2 rounded-2xl text-[1.3rem] ${
                  selected ? "btn-accent font-bold" : "glass text-secondary-text"
                }`}
                onClick={() => setDay(day)}
              >
                {dayLabel(day, index)}
              </button>
            );
          })}
        </div>

        <div className="space-y-3">
          <div>
            <div className="flex items-center justify-between text-[1.3rem] text-secondary-text mb-1">
               <label htmlFor={hourId}><IconText>🕐 Час</IconText></label>
              <span className="text-cta-icon font-bold text-[1.5rem]">{pad(cursor.getUTCHours())}</span>
            </div>
            <input
              type="range"
              id={hourId}
              min="0"
              max="23"
              step="1"
              value={cursor.getUTCHours()}
              onChange={(event) => setHour(Number(event.target.value))}
              className="time-range w-full"
            />
          </div>

          <div>
            <div className="flex items-center justify-between text-[1.3rem] text-secondary-text mb-1">
               <label htmlFor={minuteId}><IconText>⏱ Минуты</IconText></label>
              <span className="text-cta-icon font-bold text-[1.5rem]">{pad(cursor.getUTCMinutes())}</span>
            </div>
            <input
              type="range"
              id={minuteId}
              min="0"
              max="59"
              step="1"
              value={cursor.getUTCMinutes()}
              onChange={(event) => setMinute(Number(event.target.value))}
              className="time-range w-full"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button type="button" className="press rounded-2xl py-3 text-[1.4rem] glass" onClick={onClose}>
            Отмена
          </button>
          <button type="button" className="press rounded-2xl py-3 text-[1.4rem] btn-accent font-bold" onClick={commit}>
            Готово
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default TimePicker;
