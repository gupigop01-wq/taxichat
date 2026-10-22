import { configureStore } from "@reduxjs/toolkit";
import { Provider } from "react-redux";
import { act, renderHook } from "@testing-library/react";
import notificationReducer, { notificationActions } from "../store/notificationSlice";
import useOrderNotices from "./useOrderNotices";
import useSocket from "./useSocket";

jest.mock("./useSocket", () => ({ __esModule: true, default: jest.fn() }));

let socket;
let listeners;

beforeEach(() => {
  listeners = new Map();
  socket = {
    on: jest.fn((name, fn) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
    }),
    off: jest.fn((name, fn) => listeners.get(name)?.delete(fn)),
  };
  useSocket.mockReturnValue({ socket });
});

afterEach(() => jest.restoreAllMocks());

const deliver = (name, payload) => act(() => listeners.get(name)?.forEach((fn) => fn(payload)));
const renderNotices = (props = { role: "passenger", userId: "passenger" }) => {
  const store = configureStore({ reducer: { notificationReducer } });
  const view = renderHook((options) => useOrderNotices(options), {
    initialProps: props,
    wrapper: ({ children }) => <Provider store={store}>{children}</Provider>,
  });
  return { ...view, store, notices: () => store.getState().notificationReducer };
};
const status = { orderId: "order", status: "ASSIGNED", passengerId: "passenger", driverId: "driver", eventId: "change-1" };

test("personal and order-room copies give one spoken status notice off the order page", () => {
  const { notices } = renderNotices();
  deliver("order:status", { ...status, scope: "city" });
  expect(notices()).toHaveLength(0);
  deliver("order:status", { ...status, scope: "order" });
  deliver("order:status", { ...status, scope: "order" });
  expect(notices()).toHaveLength(1);
  expect(notices()[0]).toMatchObject({ orderId: "order", message: "Заказ: Водитель назначен", speak: true });
});

test("separate transitions to the same status are not falsely deduplicated", () => {
  const { notices } = renderNotices();
  deliver("order:status", { ...status, scope: "order", status: "DISPUTE", eventId: "first" });
  deliver("order:status", { ...status, scope: "order", status: "DISPUTE", eventId: "first" });
  expect(notices()).toHaveLength(1);
  // A different transition replaces the previous card instead of stacking
  deliver("order:status", { ...status, scope: "order", status: "DISPUTE", eventId: "second" });
  expect(notices()).toHaveLength(1);
});

test("old server payloads without eventId still deduplicate identical copies", () => {
  const { notices } = renderNotices();
  deliver("order:status", { ...status, scope: "order", eventId: undefined });
  deliver("order:status", { ...status, scope: "order", eventId: undefined });
  expect(notices()).toHaveLength(1);
});

test("cache eviction never forgets the most recent event at the 200-key boundary", () => {
  const { notices } = renderNotices();
  for (let i = 0; i <= 200; i += 1) {
    deliver("order:status", { ...status, scope: "order", eventId: `change-${i}` });
  }
  deliver("order:status", { ...status, scope: "order", eventId: "change-200" });
  // Only the latest notice stays on screen, but the dedupe cache still knows
  // the earlier events and does not re-show them
  expect(notices()).toHaveLength(1);
});

test("leaving PUBLISHED removes only that order's stale offers, including city copies", () => {
  const { store, notices } = renderNotices();
  store.dispatch(notificationActions.addNotification({ offer: { orderId: "order" }, message: "old offer" }));
  deliver("order:status", { ...status, scope: "city", status: "PUBLISHED" });
  expect(notices()).toHaveLength(1);
  deliver("order:status", { ...status, scope: "city", status: "CANCELLED" });
  expect(notices()).toHaveLength(0);
});

test("current roles and users are read without registering duplicate listeners", () => {
  const { rerender, notices } = renderNotices();
  deliver("order:offer", { orderId: "order", offerId: "offer" });
  deliver("order:offer", { orderId: "order", offerId: "offer" });
  expect(notices()).toHaveLength(1);
  rerender({ role: "driver", userId: "driver" });
  deliver("order:offer", { orderId: "order", offerId: "other-offer" });
  deliver("order:new", {});
  deliver("order:status", { ...status, scope: "order" });
  expect(notices()).toHaveLength(1);
  rerender({ role: "passenger", userId: "outsider" });
  deliver("order:status", { ...status, scope: "order", eventId: "other-change" });
  rerender({ role: "passenger", userId: undefined });
  deliver("order:status", { orderId: "order", status: "DISPUTE", scope: "order" });
  expect(notices()).toHaveLength(1);
  expect(socket.on).toHaveBeenCalledTimes(4);
});

test.each([
  ["visible", "order", "driver", 0],
  ["hidden", "order", "driver", 1],
  ["visible", "other-order", "driver", 1],
  ["visible", null, "driver", 1],
  ["hidden", "order", "passenger", 0],
])("message notices with visibility=%s openOrder=%s sender=%s", (visibility, openOrder, senderId, count) => {
  jest.spyOn(document, "visibilityState", "get").mockReturnValue(visibility);
  window.__bombilaOpenOrderId = openOrder;
  const { notices } = renderNotices();
  deliver("order:message", { orderId: "order", senderId, body: "hello" });
  expect(notices()).toHaveLength(count);
});

test("the open-order flag is checked at delivery time and accepts stable numeric IDs", () => {
  jest.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const { notices } = renderNotices();
  window.__bombilaOpenOrderId = 42;
  deliver("order:message", { orderId: "42", senderId: "driver", body: "visible" });
  window.__bombilaOpenOrderId = null;
  deliver("order:message", { orderId: "42", senderId: "driver", body: "offscreen" });
  expect(notices()).toHaveLength(1);
  expect(notices()[0].message).toContain("offscreen");
});

test("unmount removes only this hook's socket listeners", () => {
  const otherListener = jest.fn();
  socket.on("order:message", otherListener);
  const { unmount, notices } = renderNotices();
  unmount();
  deliver("order:message", { orderId: "order", body: "after unmount" });
  expect(notices()).toHaveLength(0);
  expect(otherListener).toHaveBeenCalledTimes(1);
  expect(socket.off).toHaveBeenCalledTimes(4);
});

