import { configureStore } from "@reduxjs/toolkit";
import { Provider } from "react-redux";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import authReducer from "./store/authSlice";
import modalReducer from "./store/modalSlice";
import notificationReducer from "./store/notificationSlice";
import { reconnectSocket } from "./hooks/useSocket";

// Test the real authentication UI without bootstrapping taxi/media services.
jest.mock("./hooks/useInit", () => () => {
  const { useSelector } = jest.requireActual("react-redux");
  return { loggedIn: useSelector((state) => state.authReducer.loggedIn) };
});
jest.mock("./hooks/useSocket", () => ({ reconnectSocket: jest.fn() }));
jest.mock("react-media-recorder", () => ({ useReactMediaRecorder: jest.fn() }));
jest.mock("./taxi/TaxiApp", () => () => <main aria-label="Рабочая область такси" />);
jest.mock("./pages/UserProfile", () => () => null);
jest.mock("./components/globals/DeleteChat", () => () => null);
jest.mock("./components/globals/DeleteContact", () => () => null);
jest.mock("./components/globals/NewContactForm", () => () => null);
jest.mock("./components/globals/VoiceCallModal", () => () => null);

const originalFetch = global.fetch;

const renderApp = (loggedIn = false) => {
  const store = configureStore({
    reducer: { authReducer, modalReducer, notificationReducer },
    preloadedState: { authReducer: { loggedIn, isNew: {} } },
  });
  render(<Provider store={store}><App /></Provider>);
  return { store };
};

beforeEach(() => {
  global.fetch = jest.fn();
});

afterEach(() => {
  global.fetch = originalFetch;
});

test("renders the real login shell for an unauthenticated user", () => {
  renderApp();
  expect(screen.getByText("Бомбила")).toBeInTheDocument();
  expect(screen.getByLabelText(/Логин/)).toBeRequired();
  expect(screen.getByLabelText(/Пароль/)).toHaveAttribute("type", "password");
  expect(screen.getByRole("button", { name: "Войти" })).toBeEnabled();
  expect(screen.getByRole("button", { name: /Зарегистрироваться/ })).toBeInTheDocument();
  expect(screen.queryByRole("main")).not.toBeInTheDocument();
  expect(global.fetch).not.toHaveBeenCalled();
});

test("a successful login changes the authenticated shell and reconnects once", async () => {
  global.fetch.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
  const { store } = renderApp();
  await userEvent.type(screen.getByLabelText(/Логин/), "passenger");
  await userEvent.type(screen.getByLabelText(/Пароль/), "Bombila2026");
  userEvent.click(screen.getByRole("button", { name: "Войти" }));

  expect(await screen.findByRole("main", { name: "Рабочая область такси" })).toBeInTheDocument();
  expect(store.getState().authReducer.loggedIn).toBe(true);
  expect(screen.queryByLabelText(/Пароль/)).not.toBeInTheDocument();
  expect(global.fetch).toHaveBeenCalledWith("/api/user/login", expect.objectContaining({
    method: "POST", body: JSON.stringify({ username: "passenger", password: "Bombila2026" }),
  }));
  expect(reconnectSocket).toHaveBeenCalledTimes(1);
});

test("renders the workspace rather than login for an authenticated user", () => {
  renderApp(true);
  expect(screen.getByRole("main", { name: "Рабочая область такси" })).toBeInTheDocument();
  expect(screen.queryByLabelText(/Логин/)).not.toBeInTheDocument();
});

