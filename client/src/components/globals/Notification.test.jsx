import { configureStore } from "@reduxjs/toolkit";
import { Provider } from "react-redux";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { NotificationItem } from "./Notification";
import notificationReducer from "../../store/notificationSlice";
import { apiPost } from "../../taxi/api";

jest.mock("../../taxi/api", () => ({ apiPost: jest.fn().mockResolvedValue({ status: "success" }) }));

jest.useFakeTimers();

const offerItem = {
  id: 7,
  kind: "offer",
  type: "info",
  message: "New driver offer",
  offer: { orderId: "order-1", offerId: "offer-1", driverName: "Ivan", priceText: "330", etaMin: 5, carCaption: "White 456 Lada" },
  orderId: "order-1",
};

const onDismiss = jest.fn();

const renderNotice = (item) => {
  const store = configureStore({ reducer: { notificationReducer } });
  return { store, ...render(<Provider store={store}><NotificationItem item={item} onDismiss={onDismiss} /></Provider>) };
};

beforeEach(() => {
  onDismiss.mockClear();
});

test("regular notices auto-dismiss after a minute", () => {
  renderNotice({ id: 1, kind: "status", type: "info", message: "Regular notice" });
  act(() => { jest.advanceTimersByTime(59999); });
  expect(onDismiss).not.toHaveBeenCalled();
  act(() => { jest.advanceTimersByTime(1); });
  expect(onDismiss).toHaveBeenCalledWith(1);
});

test("offer notices survive minutes without a decision", () => {
  renderNotice(offerItem);
  act(() => { jest.advanceTimersByTime(10 * 60000); });
  expect(onDismiss).not.toHaveBeenCalled();
  expect(screen.getByText("Ivan")).toBeInTheDocument();
});

test("a 409 accept rejection shows the server reason as an error toast and closes the card", async () => {
  const { store } = renderNotice(offerItem);
  const busy = Object.assign(new Error("Водитель уже выполняет другой заказ"), { status: 409 });
  apiPost.mockRejectedValueOnce(busy);
  fireEvent.click(screen.getByTestId("notice-accept"));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  const notices = store.getState().notificationReducer;
  const errorToast = notices.find((n) => n.type === "error");
  expect(errorToast?.message).toContain("Водитель уже выполняет другой заказ");
  // The stale offer card is closed; fine to try the next driver's offer
  expect(onDismiss).toHaveBeenCalledWith(offerItem.id);
});

test("network failures keep the offer card open for another attempt", async () => {
  const { store } = renderNotice({ ...offerItem, id: 9 });
  apiPost.mockRejectedValueOnce(new Error("network down"));
  fireEvent.click(screen.getByTestId("notice-accept"));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  const notices = store.getState().notificationReducer;
  const errorToast = notices.find((n) => n.type === "error");
  expect(errorToast?.message).toContain("network down");
  // transient failure: no dismissal, the card stays for a retry
  expect(onDismiss).not.toHaveBeenCalled();
});
