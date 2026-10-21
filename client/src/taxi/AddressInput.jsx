import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import STREETS from "./streetsData";
import { IconText } from "./TaxiIcon";

// Поле адреса с текстовыми подсказками: чисто по названию, без координат и
// геокодинга. Панель выносится в портал, раскрывается ВВЕРХ над полем, поэтому
// не уходит под шапку, не перекрывает вводимый текст и прокручивается.
// Подсказываются улицы, города (в т.ч. межгород) и слова-связки маршрута.
const normalize = (text) =>
  String(text ?? "").toLowerCase().replace(/ё/g, "е").replace(/\./g, "").trim();

// \b не работает с кириллицей, поэтому тип слова ловим по границам строки и пробелов
const SHORT = [
  [/(^|\s)улица(\s|$)/gi, "$1ул.$2"],
  [/(^|\s)переулок(\s|$)/gi, "$1пер.$2"],
  [/(^|\s)проспект(\s|$)/gi, "$1просп.$2"],
  [/(^|\s)площадь(\s|$)/gi, "$1пл.$2"],
  [/(^|\s)бульвар(\s|$)/gi, "$1б-р$2"],
  [/(^|\s)шоссе(\s|$)/gi, "$1ш.$2"],
  [/(^|\s)тракт(\s|$)/gi, "$1тр.$2"],
  [/(^|\s)микрорайон(\s|$)/gi, "$1мкр$2"],
  [/(^|\s)проезд(\s|$)/gi, "$1пр-д$2"],
];
const shorten = (name) =>
  SHORT.reduce((acc, [re, to]) => acc.replace(re, to), String(name ?? "")).trim();

const tailWord = (query) => {
  const q = normalize(query);
  if (!q) return "";
  const words = q.split(/[\s,]+/).filter(Boolean);
  return words[words.length - 1] ?? q;
};

const matchStreets = (query, limit = 8) => {
  const tail = tailWord(query);
  if (!tail) return [];
  const starts = [];
  const contains = [];
  for (const street of STREETS) {
    const short = shorten(street.n);
    const shortN = normalize(short);
    const fullN = normalize(street.n);
    const hit = { ...street, short };
    if (shortN.startsWith(tail) || fullN.startsWith(tail)) starts.push(hit);
    else if (shortN.includes(tail) || fullN.includes(tail)) contains.push(hit);
  }
  return [...starts, ...contains].slice(0, limit);
};

// Города: подсказка межгорода, кроме текущего города
const matchCities = (query, cities, currentCity, limit = 6) => {
  const tail = tailWord(query);
  const list = (cities ?? []).filter((name) => name && name !== currentCity);
  if (!tail) return list.slice(0, limit);
  return list
    .filter((name) => normalize(name).includes(tail))
    .slice(0, limit);
};

// Слова-связки: заезд доступен в любой точке маршрута
const routeChips = (text) => {
  const t = String(text ?? "");
  const hasOrigin = /^\s*(от|с)\s/i.test(t);
  const chips = [];
  if (!hasOrigin) chips.push("от", "с");
  else chips.push("до", "на", "с заездом на");
  chips.push("туда-обратно");
  return chips;
};

const chipText = (chip) => {
  if (chip === "от" || chip === "с") return `${chip} `;
  if (chip === "до" || chip === "на") return `, ${chip} `;
  if (chip === "заезд на") return `, заезд на `;
  if (chip === "с заездом на") return `, с заездом на `;
  if (chip === "туда-обратно") return ", туда-обратно";
  return `${chip} `;
};

const AddressInput = ({ value, onChange, onEnter, placeholder, cityName, cities, label }) => {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const wrapRef = useRef(null);
  const panelRef = useRef(null);
  const [rect, setRect] = useState(null);

  const streets = useMemo(() => matchStreets(value), [value]);
  const citySuggestions = useMemo(
    () => matchCities(value, cities, cityName),
    [value, cities, cityName]
  );
  const chips = useMemo(() => routeChips(value), [value]);

  // Панель считается от верхнего края поля и выводится над ним
  const measure = () => {
    const el = inputRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setRect({ left: r.left, width: r.width, top: r.top });
  };

  useLayoutEffect(() => {
    if (!open) return undefined;
    measure();
    const onShift = () => measure();
    window.addEventListener("resize", onShift);
    window.visualViewport?.addEventListener("resize", onShift);
    window.visualViewport?.addEventListener("scroll", onShift);
    return () => {
      window.removeEventListener("resize", onShift);
      window.visualViewport?.removeEventListener("resize", onShift);
      window.visualViewport?.removeEventListener("scroll", onShift);
    };
  }, [open]);

  useEffect(() => {
    const onOutside = (event) => {
      const inside =
        (wrapRef.current && wrapRef.current.contains(event.target)) ||
        (panelRef.current && panelRef.current.contains(event.target));
      if (!inside) setOpen(false);
    };
    document.addEventListener("click", onOutside);
    return () => document.removeEventListener("click", onOutside);
  }, []);

  const insert = (text) => {
    const el = inputRef.current;
    const start = el?.selectionStart ?? String(value ?? "").length;
    const end = el?.selectionEnd ?? start;
    const current = String(value ?? "");
    onChange(current.slice(0, start) + text + current.slice(end));
    requestAnimationFrame(() => {
      if (!el) return;
      const pos = start + text.length;
      el.setSelectionRange(pos, pos);
      el.focus();
    });
  };

  const applyText = (name) => {
    const current = String(value ?? "");
    const trailing = current.match(/[^\s,]*$/);
    if (trailing && trailing[0]) {
      onChange(`${current.slice(0, current.length - trailing[0].length)}${name}, `);
    } else {
      insert(`${name}, `);
    }
    setActive(0);
  };

  const onKeyDown = (event) => {
    if (open && streets.length) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((i) => (i + 1) % streets.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((i) => (i - 1 + streets.length) % streets.length);
        return;
      }
      if (event.key === "Enter" && streets[active]) {
        event.preventDefault();
        applyText(streets[active].short);
        return;
      }
      if (event.key === "Escape") {
        setOpen(false);
        return;
      }
    }
    if (event.key === "Enter") onEnter?.(event);
  };

  return (
    <div ref={wrapRef} className="relative">
      <input
        ref={inputRef}
        className="w-full bg-[#0d0d0d] text-white placeholder:text-secondary-text border border-secondary-text/30 rounded-2xl p-3 focus:border-accent focus:outline-none transition-colors text-[1.4rem] text-primary-text"
        required
        placeholder={placeholder}
        value={value}
        aria-label={label}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        autoComplete="off"
      />

      {open && rect && createPortal(
        <div
          ref={panelRef}
          style={{
            position: "fixed",
            left: rect.left,
            width: rect.width,
            bottom: Math.max(window.innerHeight - rect.top + 4, 4),
            maxHeight: "46dvh",
          }}
          className="z-[100000] glass-strong rounded-2xl overflow-hidden flex flex-col shadow-2xl"
        >
          <div className="flex flex-wrap gap-1.5 p-2 border-b border-white/10 shrink-0">
            {chips.map((chip) => (
              <button
                key={chip}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insert(chipText(chip))}
                className="press px-2.5 py-1 rounded-xl text-[1.2rem] glass text-cta-icon font-semibold"
              >
                {chip}
              </button>
            ))}
          </div>

          <div className="overflow-y-auto overscroll-contain">
            {streets.length > 0 && (
              <div className="px-3 py-1.5 text-[1.1rem] text-secondary-text">
                 <IconText>🛣 Улицы</IconText> · {cityName ?? "город"} и район
              </div>
            )}
            {streets.map((street, index) => (
              <button
                key={`${street.l}-${street.n}-${index}`}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => applyText(street.short)}
                className={`w-full text-left px-3 py-2 text-[1.4rem] flex items-center justify-between gap-2 ${
                  index === active ? "bg-white/15" : ""
                }`}
              >
                <span className="truncate">{street.short}</span>
                <span className="shrink-0 text-[1.1rem] text-secondary-text">{street.l}</span>
              </button>
            ))}

            {citySuggestions.length > 0 && (
              <div className="px-3 py-1.5 text-[1.1rem] text-secondary-text border-t border-white/10">
                 <IconText>🏙 Города</IconText> · межгород из {cityName ?? "города"}
              </div>
            )}
            {citySuggestions.map((name, index) => (
              <button
                key={`city-${name}-${index}`}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => applyText(name)}
                className="w-full text-left px-3 py-2 text-[1.4rem] flex items-center gap-2"
              >
                 <span className="truncate"><IconText>🏙</IconText> {name}</span>
              </button>
            ))}

            {streets.length === 0 && citySuggestions.length === 0 && (
              <div className="px-3 py-2 text-[1.2rem] text-secondary-text">
                Продолжайте вводить название улицы или города
              </div>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};

export default AddressInput;
