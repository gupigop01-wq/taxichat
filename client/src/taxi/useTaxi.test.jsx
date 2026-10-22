import { StrictMode } from "react";
import { act, renderHook } from "@testing-library/react";
import useTaxi from "./useTaxi";
import useSocket, { reconnectSocket } from "../hooks/useSocket";

jest.mock("../hooks/useSocket", () => ({
  __esModule: true, default: jest.fn(), reconnectSocket: jest.fn(),
}));

const originalFetch = global.fetch;
const profile = {
  user: { _id: "passenger", homeCityId: "home" },
  memberships: [{ _id: "membership", role: "passenger", status: "ACTIVE", cityId: { _id: "home" } }],
};
const cities = [{ _id: "default", name: "Слюдянка" }, { _id: "home", name: "Иркутск" }];
const response = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
let socket;
let listeners;

const flush = () => act(async () => { await Promise.resolve(); });
const deliverMembership = () => act(() => listeners.get("membership:updated")?.forEach((fn) => fn()));

beforeEach(() => {
  jest.useFakeTimers();
  listeners = new Map();
  socket = {
    on: jest.fn((name, fn) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
    }),
    off: jest.fn((name, fn) => listeners.get(name)?.delete(fn)),
    emit: jest.fn(),
  };
  useSocket.mockReturnValue({ socket });
  global.fetch = jest.fn(async (url) => response(url === "/api/user/me" ? profile : { cities }));
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  global.fetch = originalFetch;
});

test("startup preserves the user's home city, passes real AbortSignals and announces online", async () => {
  localStorage.setItem("bombila.lastCityId", "default");
  const { result } = renderHook(() => useTaxi());
  await flush();
  expect(result.current.me).toEqual(profile);
  expect(result.current.cities).toEqual(cities);
  expect(result.current.cityId).toBe("home");
  expect(reconnectSocket).toHaveBeenCalledTimes(1);
  expect(socket.emit).toHaveBeenCalledWith("user:online", "passenger");
  global.fetch.mock.calls.forEach(([, options]) => {
    expect(options.credentials).toBe("include");
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal.aborted).toBe(false);
  });
});

test("startup retry waits are actually canceled on unmount, with no later fetch", async () => {
  global.fetch.mockRejectedValue(new Error("offline"));
  const { unmount } = renderHook(() => useTaxi());
  await flush();
  expect(global.fetch).toHaveBeenCalledTimes(2);
  expect(jest.getTimerCount()).toBe(2);
  const signals = global.fetch.mock.calls.map(([, options]) => options.signal);
  unmount();
  expect(jest.getTimerCount()).toBe(0);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  act(() => jest.advanceTimersByTime(60000));
  await flush();
  expect(global.fetch).toHaveBeenCalledTimes(2);
});

test("late startup results do not announce online or update state after unmount", async () => {
  const pending = deferred();
  global.fetch.mockReturnValue(pending.promise);
  const { result, unmount } = renderHook(() => useTaxi());
  unmount();
  await act(async () => pending.resolve(response(profile)));
  expect(result.current.me).toBeNull();
  expect(result.current.cities).toEqual([]);
  expect(reconnectSocket).not.toHaveBeenCalled();
  expect(socket.emit).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});

test("the retry limit reports a real error rather than leaving startup silently stuck", async () => {
  global.fetch.mockRejectedValue(new Error("offline"));
  const { result } = renderHook(() => useTaxi());
  await flush();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    act(() => jest.advanceTimersByTime(1000 * 2 ** attempt));
    await flush();
  }
  expect(global.fetch).toHaveBeenCalledTimes(12);
  expect(jest.getTimerCount()).toBe(0);
  expect(result.current.error).toBe("offline");
});

test("transient startup failures retry and still load both user and city state", async () => {
  let failures = 2;
  global.fetch.mockImplementation(async (url) => {
    if (failures-- > 0) throw new Error("offline");
    return response(url === "/api/user/me" ? profile : { cities });
  });
  const { result } = renderHook(() => useTaxi());
  await flush();
  act(() => jest.advanceTimersByTime(1000));
  await flush();
  expect(result.current.me).toEqual(profile);
  expect(result.current.cities).toEqual(cities);
  expect(result.current.error).toBeNull();
  expect(global.fetch).toHaveBeenCalledTimes(4);
});

test("membership refresh failures are caught and visible, and later updates remain live", async () => {
  const { result } = renderHook(() => useTaxi());
  await flush();
  global.fetch.mockRejectedValueOnce(new Error("membership update failed"));
  deliverMembership();
  await flush();
  expect(result.current.error).toBe("membership update failed");
  const updated = { ...profile, user: { ...profile.user, name: "Updated passenger" } };
  global.fetch.mockResolvedValueOnce(response(updated));
  deliverMembership();
  await flush();
  expect(result.current.me).toEqual(updated);
  expect(socket.on).toHaveBeenCalledTimes(1);
});

test("an in-flight membership refresh is aborted and cannot update after unmount", async () => {
  const { result, unmount } = renderHook(() => useTaxi());
  await flush();
  const pending = deferred();
  global.fetch.mockReturnValueOnce(pending.promise);
  deliverMembership();
  const signal = global.fetch.mock.calls[2][1].signal;
  unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => pending.resolve(response({ ...profile, user: { _id: "late" } })));
  expect(result.current.me).toEqual(profile);
  expect(listeners.get("membership:updated").size).toBe(0);
});

test("calling a retained refreshMe after unmount rejects cancellation without fetching", async () => {
  const { result, unmount } = renderHook(() => useTaxi());
  await flush();
  const refreshMe = result.current.refreshMe;
  unmount();
  await expect(refreshMe()).rejects.toMatchObject({ name: "AbortError" });
  expect(global.fetch).toHaveBeenCalledTimes(2);
});

test("StrictMode replay cancels the old requests and only announces the live mount", async () => {
  const { result } = renderHook(() => useTaxi(), {
    wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
  });
  await flush();
  expect(global.fetch).toHaveBeenCalledTimes(4);
  expect(global.fetch.mock.calls[0][1].signal.aborted).toBe(true);
  expect(global.fetch.mock.calls[2][1].signal.aborted).toBe(false);
  expect(result.current.me).toEqual(profile);
  expect(reconnectSocket).toHaveBeenCalledTimes(1);
});
