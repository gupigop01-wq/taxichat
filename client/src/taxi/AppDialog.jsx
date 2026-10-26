import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import { IconText } from "./TaxiIcon";

// Styled replacement for window.prompt / window.confirm.
// Usage: const { ask, confirm } = useDialog();
//   const text = await ask({ title, placeholder, initial });   // string | null
//   const ok   = await confirm({ title, text, danger });       // boolean
const DialogContext = createContext(null);

export const DialogProvider = ({ children }) => {
  const [dialog, setDialog] = useState(null);
  const [value, setValue] = useState("");
  const resolver = useRef(null);
  const boxRef = useRef(null);
  const inputRef = useRef(null);
  const cancelRef = useRef(null);
  const okRef = useRef(null);
  const titleId = useId();
  const descriptionId = useId();


  const open = useCallback((config) => {
    return new Promise((resolve) => {
      resolver.current = resolve;
      setValue(config.initial ?? "");
      setDialog(config);
    });
  }, []);

  const finish = (result) => {
    resolver.current?.(result);
    resolver.current = null;
    setDialog(null);
  };

  const ask = useCallback((config) => open({ ...config, kind: "ask" }), [open]);
  const confirm = useCallback((config) => open({ ...config, kind: "confirm" }), [open]);

  useEffect(() => {
    if (!dialog) return undefined;
    const previousFocus = document.activeElement;
    (dialog.kind === "ask" ? inputRef.current : (cancelRef.current ?? okRef.current))?.focus();
    // Editing an existing value: typing must replace it, not append to it
    if (dialog.kind === "ask" && dialog.autoSelect) inputRef.current?.select();
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(dialog.kind === "ask" ? null : false);
      } else if (event.key === "Tab") {
        const controls = [...boxRef.current.querySelectorAll('input:not(:disabled), button:not(:disabled)')];
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || !boxRef.current.contains(document.activeElement))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !boxRef.current.contains(document.activeElement))) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus?.();
    };
  }, [dialog]);

  return (
    <DialogContext.Provider value={{ ask, confirm }}>
      {children}
      {dialog && (
        <div className="fixed inset-0 z-[11000] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4 anim-fade">
          <div ref={boxRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={dialog.text ? descriptionId : undefined} className="glass-strong w-full max-w-[32rem] rounded-3xl p-4 space-y-3 anim-rise max-h-[90dvh] overflow-y-auto">
             <div id={titleId} className="font-display font-bold text-[1.5rem] text-center"><IconText>{dialog.title}</IconText></div>
             {dialog.text && <div id={descriptionId} className="text-[1.3rem] text-secondary-text text-center"><IconText>{dialog.text}</IconText></div>}
            {dialog.kind === "ask" && (
              <input
                ref={inputRef}
                aria-label={dialog.placeholder || dialog.title}
                type={dialog.inputType ?? "text"}
                inputMode={dialog.inputMode}
                className="w-full bg-[#0d0d0d] text-white placeholder:text-secondary-text border border-secondary-text/30 rounded-xl px-3 py-2 text-[1.4rem] focus:border-accent focus:outline-none"
                placeholder={dialog.placeholder}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                onFocus={() => setTimeout(() => boxRef.current?.scrollIntoView({ block: "center" }), 300)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") finish(value.trim() || null);
                }}
              />
            )}
            <div className={`grid ${dialog.cancelText === null ? "grid-cols-1" : "grid-cols-2"} gap-2`}>
              {dialog.cancelText !== null && (
                <button
                  ref={cancelRef}
                  type="button"
                  className="rounded-xl py-2 text-[1.3rem] bg-white/10 border border-white/10"
                  onClick={() => finish(dialog.kind === "ask" ? null : false)}
                >
                  {dialog.cancelText ?? "Отмена"}
                </button>
              )}
              <button
                ref={okRef}
                type="button"
                className={`rounded-xl py-2 text-[1.3rem] font-bold ${dialog.danger ? "bg-danger text-white" : "btn-accent"}`}
                onClick={() =>
                  finish(dialog.kind === "ask" ? value.trim() || null : true)
                }
              >
                {dialog.okText ?? "Готово"}
              </button>
            </div>
          </div>
        </div>
      )}
    </DialogContext.Provider>
  );
};

export const useDialog = () => {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error("useDialog must be used inside DialogProvider");
  return ctx;
};
