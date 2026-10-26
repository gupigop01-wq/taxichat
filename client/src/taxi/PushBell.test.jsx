import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PushBell from "./PushBell";
import { DialogProvider } from "./AppDialog";

jest.mock("./pushClient", () => ({
  __esModule: true,
  enablePushNotifications: jest.fn(),
  disablePushNotifications: jest.fn(),
}));

const push = require("./pushClient");

const HINT = "Включите/разрешите уведомления этой кнопкой";
const OFF_LABEL = "Включить уведомления";

let subscription = null;

const setupEnvironment = (permission = "default") => {
  subscription = null;
  Object.defineProperty(window, "Notification", {
    configurable: true,
    value: { permission, requestPermission: jest.fn(async () => permission) },
  });
  Object.defineProperty(window, "PushManager", {
    configurable: true,
    value: function PushManager() {},
  });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { ready: Promise.resolve({ pushManager: { getSubscription: async () => subscription } }) },
  });
};

const renderBell = () => render(
  <DialogProvider>
    <PushBell />
  </DialogProvider>
);

afterEach(() => {
  delete window.Notification;
  delete window.PushManager;
  delete navigator.serviceWorker;
  jest.clearAllMocks();
});

test("keeps the pointing hint while notifications are off", async () => {
  setupEnvironment("default");
  renderBell();

  expect(await screen.findByText(HINT)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: OFF_LABEL })).toHaveAttribute("aria-pressed", "false");
});

test("hides the hint and marks the bell once the subscription is live", async () => {
  setupEnvironment("default");
  push.enablePushNotifications.mockImplementation(async () => {
    // Chrome flips the permission as soon as the user accepts the prompt
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: { permission: "granted", requestPermission: jest.fn(async () => "granted") },
    });
    subscription = { endpoint: "https://push.test/1" };
    return { ok: true };
  });
  renderBell();

  const bell = await screen.findByRole("button", { name: OFF_LABEL });
  expect(await screen.findByText(HINT)).toBeInTheDocument();
  await userEvent.click(bell);

  await waitFor(() => expect(screen.queryByText(HINT)).toBeNull());
  expect(push.enablePushNotifications).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Уведомления включены" })).toHaveAttribute("aria-pressed", "true");
});

test("explains how to unblock when the browser denied notifications", async () => {
  setupEnvironment("denied");
  push.enablePushNotifications.mockResolvedValue({
    ok: false,
    reason: "Уведомления для сайта заблокированы. Откройте меню Chrome.",
  });
  renderBell();

  await userEvent.click(await screen.findByRole("button", { name: OFF_LABEL }));

  expect(await screen.findByText("Уведомления не включились")).toBeInTheDocument();
  expect(screen.getByText("Уведомления для сайта заблокированы. Откройте меню Chrome.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Понятно" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Отмена" })).toBeNull();
});

test("turns push off again through the same bell after asking first", async () => {
  setupEnvironment("granted");
  subscription = { endpoint: "https://push.test/2" };
  push.disablePushNotifications.mockImplementation(async () => {
    subscription = null;
  });
  renderBell();

  const bell = await screen.findByRole("button", { name: "Уведомления включены" });
  await userEvent.click(bell);

  // Nothing is dropped before the user confirms
  expect(push.disablePushNotifications).not.toHaveBeenCalled();
  expect(await screen.findByText("Выключить уведомления?")).toBeInTheDocument();

  await act(async () => {
    screen.getByRole("button", { name: "Выключить" }).click();
  });

  expect(push.disablePushNotifications).toHaveBeenCalledTimes(1);
  expect(await screen.findByRole("button", { name: OFF_LABEL })).toBeInTheDocument();
});
