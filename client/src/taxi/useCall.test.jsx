import { act, renderHook, waitFor } from "@testing-library/react";
import Peer from "simple-peer";
import useCall from "./useCall";
import useSocket from "../hooks/useSocket";
import { apiGet } from "./api";

jest.mock("simple-peer", () => jest.fn());
jest.mock("../hooks/useSocket", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("./api", () => ({ apiGet: jest.fn() }));

const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
const outgoing = { kind: "order", target: "driver", orderId: "order", name: "Driver" };
const incoming = {
  callId: "call", orderId: "order", kind: "order", from: "driver",
  fromName: "Driver", fromRole: "driver", signalData: { type: "offer" },
};
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const makeStream = () => {
  const track = { stop: jest.fn(), enabled: true };
  return { getTracks: () => [track], getAudioTracks: () => [track], track };
};

let listeners;
let socket;
let peers;
let stream;
let getUserMedia;

beforeEach(() => {
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
  apiGet.mockResolvedValue({ data: { iceServers: [{ urls: "turn:test" }], iceTransportPolicy: "relay" } });
  peers = [];
  Peer.mockImplementation(function () {
    const handlers = new Map();
    const peer = {
      on: jest.fn((name, fn) => { handlers.set(name, fn); return peer; }),
      signal: jest.fn(),
      destroy: jest.fn(() => handlers.get("close")?.()),
      fire: (name, payload) => handlers.get(name)?.(payload),
    };
    peers.push(peer);
    return peer;
  });
  stream = makeStream();
  getUserMedia = jest.fn().mockResolvedValue(stream);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true, value: { getUserMedia },
  });
});

afterEach(() => {
  if (originalMediaDevices) Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
  else delete navigator.mediaDevices;
});

const deliver = (name, payload) => act(() => listeners.get(name)?.forEach((fn) => fn(payload)));
const start = async (result, options = outgoing) => {
  await act(async () => result.current.startCall(options));
  return peers[peers.length - 1];
};
const inviteAck = (peer, payload = { callId: "call" }) => {
  act(() => peer.fire("signal", { type: "offer" }));
  const invite = socket.emit.mock.calls.filter(([name]) => name === "call:invite").pop();
  act(() => invite[2](payload));
};

test("outgoing calls keep metadata and tear down peer and all tracks on hangup", async () => {
  const onAck = jest.fn();
  const { result } = renderHook(() => useCall());
  const peer = await start(result, { ...outgoing, onAck });
  expect(Peer).toHaveBeenCalledWith(expect.objectContaining({ initiator: true, stream, config: {
    iceServers: [{ urls: "turn:test" }], iceTransportPolicy: "relay",
  } }));
  inviteAck(peer);
  expect(result.current.call).toMatchObject({ status: "ringing", callId: "call", orderId: "order" });
  expect(onAck).toHaveBeenCalledTimes(1);
  deliver("call:answer", { callId: "call", signalData: { type: "answer" } });
  expect(result.current.call.status).toBe("active");
  expect(peer.signal).toHaveBeenCalledWith({ type: "answer" });
  act(() => result.current.endCall());
  expect(peer.destroy).toHaveBeenCalledTimes(1);
  expect(stream.track.stop).toHaveBeenCalledTimes(1);
  expect(result.current.call.status).toBe("idle");
  expect(socket.emit).toHaveBeenCalledWith("call:end", { callId: "call", reason: "hangup" });
});

test("an invite acknowledgment failure destroys the peer while preserving the failure panel", async () => {
  const { result } = renderHook(() => useCall());
  const peer = await start(result);
  inviteAck(peer, { error: "busy" });
  expect(peer.destroy).toHaveBeenCalledTimes(1);
  expect(stream.track.stop).toHaveBeenCalledTimes(1);
  expect(result.current.call).toMatchObject({ status: "failed", error: "busy", peerName: "Driver" });
  act(() => result.current.endCall());
  expect(result.current.call.status).toBe("idle");
});

test.each(["call:busy", "call:error"])("%s destroys a live peer, releases media and ignores late peer events", async (event) => {
  const { result } = renderHook(() => useCall());
  const peer = await start(result);
  inviteAck(peer);
  deliver(event, { callId: "call", target: "driver", error: "unavailable" });
  expect(peer.destroy).toHaveBeenCalledTimes(1);
  expect(stream.track.stop).toHaveBeenCalledTimes(1);
  act(() => {
    peer.fire("stream", makeStream());
    peer.fire("signal", { type: "late offer" });
  });
  expect(result.current.call).toMatchObject({ status: "failed", error: "unavailable" });
  expect(socket.emit.mock.calls.filter(([name]) => name === "call:invite")).toHaveLength(1);
});

test("simple-peer error events are caught and fully release the call", async () => {
  const { result } = renderHook(() => useCall());
  const peer = await start(result);
  act(() => peer.fire("error", new Error("WebRTC failed")));
  expect(result.current.call).toMatchObject({ status: "failed", error: "WebRTC failed" });
  expect(peer.destroy).toHaveBeenCalledTimes(1);
  expect(stream.track.stop).toHaveBeenCalledTimes(1);
});

test("accepting an incoming call handles microphone rejection without an unhandled promise", async () => {
  getUserMedia.mockRejectedValue(new Error("permission denied"));
  const { result } = renderHook(() => useCall());
  deliver("call:invite", incoming);
  await act(async () => result.current.acceptCall());
  expect(result.current.call).toMatchObject({ status: "failed", error: "permission denied" });
  expect(socket.emit).toHaveBeenCalledWith("call:end", { callId: "call", reason: "cancel" });
  expect(Peer).not.toHaveBeenCalled();
});

test("a throwing peer constructor releases the microphone on incoming acceptance", async () => {
  Peer.mockImplementation(() => { throw new Error("unsupported peer"); });
  const { result } = renderHook(() => useCall());
  deliver("call:invite", incoming);
  await act(async () => result.current.acceptCall());
  expect(stream.track.stop).toHaveBeenCalledTimes(1);
  expect(result.current.call).toMatchObject({ status: "failed", error: "unsupported peer" });
});

test("a throwing incoming signal destroys the created peer and releases media", async () => {
  const { result } = renderHook(() => useCall());
  deliver("call:invite", incoming);
  Peer.mockImplementationOnce(() => {
    const peer = { on: jest.fn(), destroy: jest.fn(), signal: jest.fn(() => { throw new Error("bad signal"); }) };
    peers.push(peer);
    return peer;
  });
  await act(async () => result.current.acceptCall());
  expect(peers[0].destroy).toHaveBeenCalledTimes(1);
  expect(stream.track.stop).toHaveBeenCalledTimes(1);
  expect(result.current.call).toMatchObject({ status: "failed", error: "bad signal" });
});

test("hangup during microphone permission stops late media and never fetches ICE", async () => {
  const pending = deferred();
  getUserMedia.mockReturnValue(pending.promise);
  const { result } = renderHook(() => useCall());
  let starting;
  act(() => { starting = result.current.startCall(outgoing); });
  act(() => result.current.endCall());
  await act(async () => { pending.resolve(stream); await starting; });
  expect(stream.track.stop).toHaveBeenCalledTimes(1);
  expect(apiGet).not.toHaveBeenCalled();
  expect(Peer).not.toHaveBeenCalled();
  expect(result.current.call.status).toBe("idle");
});

test("hangup during ICE cancels the request and never creates or activates a late peer", async () => {
  const pending = deferred();
  apiGet.mockReturnValue(pending.promise);
  const { result } = renderHook(() => useCall());
  let starting;
  act(() => { starting = result.current.startCall(outgoing); });
  await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
  const signal = apiGet.mock.calls[0][1].signal;
  act(() => result.current.endCall());
  expect(signal.aborted).toBe(true);
  expect(stream.track.stop).toHaveBeenCalledTimes(1);
  await act(async () => { pending.resolve({ data: { iceServers: [] } }); await starting; });
  expect(Peer).not.toHaveBeenCalled();
  expect(result.current.call.status).toBe("idle");
});

test("a late successful invite acknowledgment ends the server call without reactivating the UI", async () => {
  const onAck = jest.fn();
  const { result } = renderHook(() => useCall());
  const peer = await start(result, { ...outgoing, onAck });
  act(() => peer.fire("signal", { type: "offer" }));
  const acknowledge = socket.emit.mock.calls.find(([name]) => name === "call:invite")[2];
  act(() => result.current.endCall());
  act(() => acknowledge({ callId: "late-call", chatId: "late-chat" }));
  expect(onAck).not.toHaveBeenCalled();
  expect(result.current.call.status).toBe("idle");
  expect(socket.emit).toHaveBeenCalledWith("call:end", { callId: "late-call", reason: "cancel" });
});

test("an incoming call canceled during acceptance cannot become active when media resolves", async () => {
  const pending = deferred();
  getUserMedia.mockReturnValue(pending.promise);
  const { result } = renderHook(() => useCall());
  deliver("call:invite", incoming);
  let accepting;
  act(() => { accepting = result.current.acceptCall(); });
  deliver("call:end", { callId: "call" });
  await act(async () => { pending.resolve(stream); await accepting; });
  expect(stream.track.stop).toHaveBeenCalledTimes(1);
  expect(Peer).not.toHaveBeenCalled();
  expect(result.current.call.status).toBe("idle");
});

test("unrelated signaling and late answers after reset cannot activate a call", async () => {
  const { result } = renderHook(() => useCall());
  const peer = await start(result);
  inviteAck(peer);
  deliver("call:answer", { callId: "other", signalData: {} });
  deliver("call:ice", { callId: "other", candidate: {} });
  deliver("call:end", { callId: "other" });
  deliver("call:error", { callId: "other", error: "old error" });
  expect(peer.signal).not.toHaveBeenCalled();
  expect(result.current.call.status).toBe("ringing");
  act(() => result.current.endCall());
  deliver("call:answer", { callId: "call", signalData: {} });
  expect(result.current.call.status).toBe("idle");
});

test("incoming calls answer normally and a remote end tears down both resources", async () => {
  const { result } = renderHook(() => useCall());
  deliver("call:invite", incoming);
  await act(async () => result.current.acceptCall());
  const peer = peers[0];
  expect(peer.signal).toHaveBeenCalledWith(incoming.signalData);
  expect(result.current.call).toMatchObject({ status: "active", accepted: true, callId: "call" });
  act(() => peer.fire("signal", { type: "answer" }));
  expect(socket.emit).toHaveBeenCalledWith("call:answer", { callId: "call", signalData: { type: "answer" } });
  deliver("call:end", { callId: "call" });
  expect(peer.destroy).toHaveBeenCalledTimes(1);
  expect(stream.track.stop).toHaveBeenCalledTimes(1);
  expect(result.current.call.status).toBe("idle");
});

test("unmount tears down a live peer, stops media and removes socket listeners", async () => {
  const { result, unmount } = renderHook(() => useCall());
  const peer = await start(result);
  inviteAck(peer);
  unmount();
  expect(peer.destroy).toHaveBeenCalledTimes(1);
  expect(stream.track.stop).toHaveBeenCalledTimes(1);
  expect(apiGet.mock.calls[0][1].signal.aborted).toBe(true);
  expect(socket.off).toHaveBeenCalledTimes(6);
  expect(socket.emit).toHaveBeenCalledWith("call:end", { callId: "call", reason: "cancel" });
});

test("unmount during microphone permission releases late tracks without ICE or peer work", async () => {
  const pending = deferred();
  getUserMedia.mockReturnValue(pending.promise);
  const { result, unmount } = renderHook(() => useCall());
  let starting;
  act(() => { starting = result.current.startCall(outgoing); });
  unmount();
  await act(async () => { pending.resolve(stream); await starting; });
  expect(stream.track.stop).toHaveBeenCalledTimes(1);
  expect(Peer).not.toHaveBeenCalled();
  expect(apiGet).not.toHaveBeenCalled();
});

test("back-to-back incoming invites are declined synchronously instead of replacing the first", () => {
  const { result } = renderHook(() => useCall());
  act(() => {
    listeners.get("call:invite").forEach((fn) => fn(incoming));
    listeners.get("call:invite").forEach((fn) => fn({ ...incoming, callId: "second" }));
  });
  expect(result.current.call.callId).toBe("call");
  expect(socket.emit).toHaveBeenCalledWith("call:end", { callId: "second", reason: "decline" });
});
