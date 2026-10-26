import { useEffect } from "react";

// An installed PWA can stay open for days and keep serving the JavaScript it
// loaded on the first launch (the service worker streams HTML from the network,
// but nothing reloads the page itself). Poll the shell and reload once the
// published bundle differs, so a deploy reaches every phone on its own.
const loadedBundle = () => {
  const script = [...document.querySelectorAll("script[src]")].find((item) =>
    /\/main\.[a-z0-9]+\.js/.test(item.src)
  );
  return script ? script.src.split("/").pop() : null;
};

const useBundleRefresh = () => {
  useEffect(() => {
    const current = loadedBundle();
    if (!current) return undefined;

    let checking = false;
    const check = async () => {
      if (checking || document.visibilityState !== "visible") return;
      checking = true;
      try {
        const res = await fetch(`/index.html?ts=${Date.now()}`, {
          cache: "no-store",
          credentials: "omit",
        });
        if (!res.ok) return;
        const html = await res.text();
        const next = html.match(/main\.[a-z0-9]+\.js/)?.[0];
        if (next && next !== current) window.location.reload();
      } catch (error) {
        // Offline or a flaky network: keep the bundle that already works
      } finally {
        checking = false;
      }
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    const timer = setInterval(check, 5 * 60 * 1000);
    document.addEventListener("visibilitychange", onVisible);
    check();
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
};

export default useBundleRefresh;
