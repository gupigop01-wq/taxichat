import { render, screen, waitFor } from "@testing-library/react";
import DispatcherPanel from "./DispatcherPanel";
import { DialogProvider } from "./AppDialog";

const asked = [];
const respond = (url) => {
  asked.push(String(url));
  if (String(url).startsWith("/api/admin/")) {
    return Promise.resolve({
      ok: false,
      status: 403,
      json: async () => ({ status: "fail", message: "Требуются права администратора региона" }),
    });
  }
  const data = String(url).includes("/api/orders")
    ? { orders: [] }
    : { drivers: [] };
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ status: "success", data }) });
};

jest.mock("./api", () => ({
  apiGet: (url) => respond(url),
  apiPost: jest.fn(),
  apiPatch: jest.fn(),
}));

// The panel renders OrderChat for "open order"; its recorder is browser-only
jest.mock("react-media-recorder", () => ({
  useReactMediaRecorder: () => ({ startRecording: jest.fn(), stopRecording: jest.fn() }),
}));

jest.mock("../hooks/useSocket", () => ({
  __esModule: true,
  default: () => ({ socketListen: jest.fn(), socket: { off: jest.fn() }, socketEmit: jest.fn() }),
  reconnectSocket: jest.fn(),
}));

jest.mock("react-redux", () => ({
  useDispatch: () => jest.fn(),
}));

beforeEach(() => {
  asked.length = 0;
});

test("a dispatcher loads the city queue without calling region-admin endpoints", async () => {
  render(<DialogProvider><DispatcherPanel cityId="city-1" role="dispatcher" me={{ user: { _id: "u1" } }} /></DialogProvider>);

  await waitFor(() => expect(asked.some((url) => url.includes("/api/orders"))).toBe(true));
  expect(asked.filter((url) => url.startsWith("/api/admin/"))).toEqual([]);
  expect(screen.queryByText(/Требуются права администратора региона/)).not.toBeInTheDocument();
  expect(screen.queryByText("Управление регионом")).not.toBeInTheDocument();
});

test("a region admin still gets the region management sections", async () => {
  render(<DialogProvider><DispatcherPanel cityId="city-1" role="region_admin" me={{ user: { _id: "u1" } }} /></DialogProvider>);

  expect(await screen.findByText("Управление регионом")).toBeInTheDocument();
  await waitFor(() =>
    expect(asked.some((url) => url.startsWith("/api/admin/applications"))).toBe(true)
  );
});
