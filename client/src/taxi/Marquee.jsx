// Live scrolling line for text that does not fit the width.
// Fits -> static. Too long -> the text scrolls in a loop inside a clipped box.
// With reduced motion (or when there is no room to scroll) the text wraps
// instead of being clipped by the static marquee.
import { useEffect, useState } from "react";

const Marquee = ({ text, className = "" }) => {
  const value = text ?? "";
  const [wrap, setWrap] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setWrap(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const long = value.length > 22;
  return (
    <div className={`min-w-0 overflow-hidden ${className}`} title={value}>
      {value === "" ? null : wrap ? (
        <span className="block break-words leading-snug">{value}</span>
      ) : long ? (
        <div className="flex w-max animate-marquee whitespace-nowrap">
          <span className="pr-12">{value}</span>
          <span className="pr-12" aria-hidden>{value}</span>
        </div>
      ) : (
        <span className="block truncate">{value}</span>
      )}
    </div>
  );
};

export default Marquee;
