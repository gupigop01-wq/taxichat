// jest-dom adds custom jest matchers for asserting on DOM nodes.
import '@testing-library/jest-dom';

// Recorder dependencies create worker URLs at import time; jsdom has no blobs.
Object.defineProperties(URL, {
  createObjectURL: { configurable: true, writable: true, value: jest.fn() },
  revokeObjectURL: { configurable: true, writable: true, value: jest.fn() },
});

// jsdom lacks full matchMedia (framer-motion needs addListener too). The app is
// PWA-only, so tests run in the installed (standalone) mode by default; the
// install-gate test flips window.__pwaBrowserMode to check browser mode.
window.matchMedia = (query) => {
  const isDisplayMode = typeof query === "string" && query.includes("(display-mode:");
  const matches =
    isDisplayMode && (query.includes("standalone") || query.includes("fullscreen"))
      ? !window.__pwaBrowserMode
      : false;
  return {
    matches,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  };
};

beforeEach(() => {
  URL.createObjectURL.mockReturnValue('blob:test');
});

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  delete window.__bombilaOpenOrderId;
  delete window.__pwaBrowserMode;
});
