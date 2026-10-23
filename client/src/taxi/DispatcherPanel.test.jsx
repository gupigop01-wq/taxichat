import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DispatcherPanel from "./DispatcherPanel";
import { DialogProvider } from "./AppDialog";

// The panel imports "../taxi/api" (resolved relative to src/taxi), so this
// specifier is what Jest has to mock. CRA resets mock implementations before
// each test, so every implementation is installed in beforeEach.
jest.mock("./api", () => ({
  __esModule: true,
  apiGet: jest.fn(),
  apiPost: jest.fn(),
  apiPatch: jest.fn(),
  apiDelete: jest.fn(),
  apiUpload: jest.fn(),
}));

jest.mock("../hooks/useSocket", () => ({
  __esModule: true,
  default: () => ({
    socketListen: jest.fn(),
    socketEmit: jest.fn(),
    socket: { on: jest.fn(), off: jest.fn() },
  }),
  reconnectSocket: jest.fn(),
}));

// The panel renders OrderChat for "open order"; its recorder is browser-only
jest.mock("react-media-recorder", () => ({
  useReactMediaRecorder: () => ({ startRecording: jest.fn(), stopRecording: jest.fn() }),
}));

jest.mock("react-redux", () => ({
  useDispatch: () => jest.fn(),
}));

const api = require("./api");
const asked = [];
const placed = [];

const signals = () => [
  {
    _id: "sos-1",
    orderId: "order-1",
    status: "OPEN",
    text: "Кнопка SOS нажата во время заказа",
    phone: "+79021112233",
    reporter: { _id: "p1", name: "Анна" },
    takenBy: null,
  },
  {
    _id: "sos-2",
    orderId: "order-2",
    status: "IN_REVIEW",
    text: "Второй сигнал",
    phone: null,
    reporter: { _id: "p2", name: "Пётр" },
    takenBy: { _id: "d2", name: "Диспетчер Ольга" },
  },
];

const answer = (url) => {
  const target = String(url);
  asked.push(target);
  if (target.startsWith("/api/admin/")) {
    const error = new Error("Требуются права администратора региона");
    error.status = 403;
    return Promise.reject(error);
  }
  if (target.includes("/sos")) return Promise.resolve({ data: { signals: signals() } });
  if (target.includes("/api/orders")) return Promise.resolve({ data: { orders: [] } });
  return Promise.resolve({ data: { drivers: [] } });
};

beforeEach(() => {
  asked.length = 0;
  placed.length = 0;
  api.apiGet.mockImplementation(answer);
  api.apiPost.mockImplementation((url) => {
    placed.push({ method: "POST", url, body: null });
    return Promise.resolve({ data: { signal: { _id: "sos-1", status: "IN_REVIEW" } } });
  });
  api.apiPatch.mockImplementation((url, body) => {
    placed.push({ method: "PATCH", url, body });
    return Promise.resolve({ data: { signal: { _id: "sos-1", status: "RESOLVED" } } });
  });
});

const renderPanel = (role = "dispatcher") =>
  render(
    <DialogProvider>
      <DispatcherPanel cityId="city-1" role={role} me={{ user: { _id: "u1" } }} />
    </DialogProvider>
  );

test("a dispatcher loads the city queue without calling region-admin endpoints", async () => {
  renderPanel();

  await waitFor(() => expect(asked.some((url) => url.includes("/api/orders"))).toBe(true));
  expect(asked.filter((url) => url.startsWith("/api/admin/"))).toEqual([]);
  expect(screen.queryByText(/Требуются права администратора региона/)).not.toBeInTheDocument();
  expect(screen.queryByText("Управление регионом")).not.toBeInTheDocument();
});

test("a region admin still gets the region management sections", async () => {
  renderPanel("region_admin");

  expect(await screen.findByText("Управление регионом")).toBeInTheDocument();
  await waitFor(() =>
    expect(asked.some((url) => url.startsWith("/api/admin/applications"))).toBe(true)
  );
});

test("the SOS banner shows the caller, the phone and who already took the signal", async () => {
  renderPanel();

  const banner = await screen.findByRole("alert");
  expect(within(banner).getByText(/SOS · 2/)).toBeInTheDocument();
  expect(within(banner).getByText(/Анна/)).toBeInTheDocument();
  expect(within(banner).getByText(/Диспетчер Ольга/)).toBeInTheDocument();
  const call = within(banner).getByRole("link", { name: /Позвонить пассажиру/ });
  expect(call).toHaveAttribute("href", "tel:+79021112233");
});

test("taking a signal calls the take endpoint", async () => {
  renderPanel();

  const banner = await screen.findByRole("alert");
  await userEvent.click(within(banner).getByRole("button", { name: /Взять в работу/ }));

  await waitFor(() =>
    expect(placed.some((call) => call.url.endsWith("/api/dispatch/sos/sos-1/take"))).toBe(true)
  );
});

test("closing a signal requires a note and sends the outcome", async () => {
  renderPanel();

  const banner = await screen.findByRole("alert");
  await userEvent.click(within(banner).getAllByRole("button", { name: /^Обработан$/ })[0]);

  const note = await screen.findByPlaceholderText(/Что сделано/);
  await userEvent.type(note, "Связались с пассажиром");
  await userEvent.click(screen.getByRole("button", { name: /Закрыть/ }));

  await waitFor(() =>
    expect(placed).toContainEqual({
      method: "PATCH",
      url: "/api/dispatch/sos/sos-1",
      body: { outcome: "resolved", resolution: "Связались с пассажиром" },
    })
  );
});
