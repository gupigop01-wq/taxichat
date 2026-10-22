import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cityStatusEmoji, cityStatusShort } from "./statusLabels";
import { IconText } from "./TaxiIcon";

// Выбор города: кнопка с текущим городом, панель — порталом поверх шапки,
// поэтому её ширина не зажата колонкой города+роли. Города группируются
// по первой букве; строка пункта — всегда две строки: имя + статус,
// чтобы длинные названия не обрезались.
const PANEL_MIN_WIDTH = 320; // px
const PANEL_GAP = 8;

const CityPicker = ({ cities, cityId, onSelect }) => {
  const [open, setOpen] = useState(false);
  const [letter, setLetter] = useState(null);
  const [rect, setRect] = useState(null);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const focusLastRef = useRef(false);
  const listId = useId();
  const current = cities.find((item) => String(item._id) === String(cityId));

  const sorted = useMemo(
    () => [...cities].sort((a, b) => a.name.localeCompare(b.name, "ru")),
    [cities]
  );
  const letters = useMemo(
    () => [...new Set(sorted.map((item) => item.name.charAt(0).toUpperCase()))],
    [sorted]
  );
  const shown = useMemo(
    () => (letter ? sorted.filter((item) => item.name.charAt(0).toUpperCase() === letter) : sorted),
    [sorted, letter]
  );

  const measure = () => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setRect({ left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width });
  };

  useEffect(() => {
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
    if (!open) return;
    const options = panelRef.current?.querySelectorAll('[role="option"]');
    const option = focusLastRef.current
      ? options?.[options.length - 1]
      : panelRef.current?.querySelector('[aria-selected="true"]') ?? options?.[0];
    (option ?? panelRef.current?.querySelector("button"))?.focus();
  }, [open]);

  // Close on a click outside the picker or on Escape
  useEffect(() => {
    if (!open) return undefined;
    const onOutside = (event) => {
      if (!rootRef.current?.contains(event.target) && !panelRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("click", onOutside);
    document.addEventListener("focusin", onOutside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onOutside);
      document.removeEventListener("focusin", onOutside);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const choose = (item) => {
    onSelect(String(item._id));
    setOpen(false);
    setLetter(null);
    triggerRef.current?.focus();
  };

  const onNavigate = (event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const options = [...panelRef.current.querySelectorAll('[role="option"]')];
    const index = options.indexOf(event.target);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0
      : event.key === "End" ? options.length - 1
      : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
    options[next].focus();
    options[next].scrollIntoView?.({ block: "nearest" });
  };

  // Geometry: full width on phones, anchored panel on desktop; open below the
  // trigger when there is room, otherwise above it.
  const viewport = typeof window === "undefined" ? null : window.visualViewport;
  const vw = viewport?.width ?? (typeof window === "undefined" ? 360 : window.innerWidth);
  const vh = viewport?.height ?? (typeof window === "undefined" ? 800 : window.innerHeight);
  const viewportLeft = viewport?.offsetLeft ?? 0;
  const viewportTop = viewport?.offsetTop ?? 0;
  const width = Math.min(Math.max(0, vw - 16), Math.max(PANEL_MIN_WIDTH, rect?.width ?? PANEL_MIN_WIDTH));
  const left = Math.max(viewportLeft + 8, Math.min(rect?.left ?? 8, viewportLeft + vw - width - 8));
  const spaceBelow = rect ? viewportTop + vh - rect.bottom - PANEL_GAP - 8 : vh / 2;
  const spaceAbove = rect ? rect.top - viewportTop - PANEL_GAP - 8 : vh / 2;
  const openAbove = Boolean(rect) && spaceBelow < 220 && spaceAbove > spaceBelow;
  const maxHeight = Math.min(Math.max(0, vh - 16), Math.max(180, Math.min(vh * 0.62, openAbove ? spaceAbove : spaceBelow)));
  const anchorTop = rect
    ? openAbove
      ? rect.top - maxHeight - PANEL_GAP
      : rect.bottom + PANEL_GAP
    : vh / 2 - maxHeight / 2;
  const panelTop = Math.max(viewportTop + 8, Math.min(anchorTop, viewportTop + vh - maxHeight - 8));

  return (
    <div ref={rootRef} className="relative w-full">
      <button
        ref={triggerRef}
        type="button"
        className="press w-full min-h-[42px] flex items-center justify-between gap-2 rounded-[14px] border border-white/10 bg-[#252525] px-3 py-2 text-[1.3rem]"
        onClick={() => {
          if (!open) {
            focusLastRef.current = false;
            measure();
          }
          setOpen((value) => !value);
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          focusLastRef.current = event.key === "ArrowUp";
          measure();
          setOpen(true);
        }}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listId : undefined}
      >
        <span className="flex items-center gap-2 min-w-0">
           <span aria-hidden><IconText>📍</IconText></span>
          <span className="font-semibold truncate text-primary-text">
            {current ? current.name : "Выберите город"}
          </span>
        </span>
        <span className="flex items-center gap-1 shrink-0 text-secondary-text text-[1.4rem]">
           {current && <span aria-hidden><IconText>{cityStatusEmoji(current.status)}</IconText></span>}
           <span aria-hidden><IconText>{open ? "🔼" : "🔽"}</IconText></span>
        </span>
      </button>

      {open && rect && createPortal(
        <div
          ref={panelRef}
          onKeyDown={onNavigate}
          style={{ position: "fixed", left, top: panelTop, width, maxHeight }}
          className="z-[100000] glass-strong rounded-2xl overflow-hidden flex flex-col shadow-2xl"
        >
          <div className="flex flex-wrap gap-1.5 p-3 border-b border-white/10 shrink-0">
            {letters.map((item) => (
              <button
                key={item}
                type="button"
                aria-pressed={letter === item}
                onClick={() => setLetter(letter === item ? null : item)}
                className={`w-[3.4rem] h-[3.4rem] rounded-lg text-[1.4rem] font-bold ${
                  letter === item ? "btn-accent" : "glass"
                }`}
              >
                {item}
              </button>
            ))}
          </div>
          <div id={listId} className="overflow-y-auto overscroll-contain p-2 flex flex-col gap-1.5" role="listbox" aria-label="Города">
            {shown.map((item) => {
              const selected = String(item._id) === String(cityId);
              return (
                <button
                  key={item._id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => choose(item)}
                  className={`w-full flex items-center justify-between gap-3 px-3.5 py-3 rounded-xl text-left ${
                    selected ? "btn-accent font-extrabold" : "glass"
                  }`}
                >
                  <span className={`truncate text-[1.55rem] leading-tight font-semibold ${selected ? "text-[#111111]" : "text-primary-text"}`}>
                    {item.name}
                  </span>
                  <span className={`shrink-0 inline-flex items-center gap-1.5 text-[1.1rem] leading-none font-normal ${selected ? "text-[#3a3200]" : "text-secondary-text"}`}>
                    <span aria-hidden className="inline-flex"><IconText size={13}>{cityStatusEmoji(item.status)}</IconText></span>
                    <span>{cityStatusShort(item.status)}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};

export default CityPicker;
