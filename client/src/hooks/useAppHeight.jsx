import { useEffect } from "react";

// Keeps #root at the visible viewport height on mobile so the fixed shell does
// not fight browser UI. One listener per mount, removed on unmount.
const useAppHeight = () => {
  useEffect(() => {
    const root = document.querySelector("#root");
    if (!root) return undefined;

    const setHeight = () => {
      const height = window.visualViewport?.height ?? window.innerHeight;
      root.style.height = `${height}px`;
    };

    const media = window.matchMedia("(max-width: 1024px)");
    const apply = () => {
      if (media.matches) setHeight();
      else root.style.height = "";
    };

    apply();
    window.addEventListener("resize", apply);
    window.visualViewport?.addEventListener("resize", apply);
    media.addEventListener("change", apply);
    return () => {
      window.removeEventListener("resize", apply);
      window.visualViewport?.removeEventListener("resize", apply);
      media.removeEventListener("change", apply);
      root.style.height = "";
    };
  }, []);
};

export default useAppHeight;
