import { act, render } from "@testing-library/react";
import CallModal from "./CallModal";
import { playDialTone, startRingtone, stopRingtone } from "./ringtone";

jest.mock("./ringtone", () => ({
  startRingtone: jest.fn(), stopRingtone: jest.fn(), playDialTone: jest.fn(),
}));

beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  jest.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test("reset detaches and pauses the remote audio instead of retaining the stream", () => {
  const remoteStream = {};
  const props = { acceptCall: jest.fn(), endCall: jest.fn() };
  const { rerender } = render(<CallModal {...props} call={{ status: "active", remoteStream }} />);
  const audio = HTMLMediaElement.prototype.play.mock.instances[0];
  expect(audio.srcObject).toBe(remoteStream);
  expect(audio.play).toHaveBeenCalledTimes(1);
  rerender(<CallModal {...props} call={{ status: "idle" }} />);
  expect(audio.pause).toHaveBeenCalledTimes(1);
  expect(audio.srcObject).toBeNull();
  expect(jest.getTimerCount()).toBe(0);
});

test("unmount detaches audio and stops the active duration timer", () => {
  const { unmount } = render(<CallModal call={{ status: "active", remoteStream: {} }} />);
  const audio = HTMLMediaElement.prototype.play.mock.instances[0];
  expect(jest.getTimerCount()).toBe(1);
  unmount();
  expect(audio.pause).toHaveBeenCalledTimes(1);
  expect(audio.srcObject).toBeNull();
  expect(jest.getTimerCount()).toBe(0);
});

test("outgoing teardown stops the dial loop and ringtone effects", () => {
  const { unmount } = render(<CallModal call={{ status: "ringing" }} />);
  expect(playDialTone).toHaveBeenCalledTimes(1);
  act(() => jest.advanceTimersByTime(3200));
  expect(playDialTone).toHaveBeenCalledTimes(2);
  unmount();
  expect(stopRingtone).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

test("incoming ringtone is stopped on unmount", () => {
  const { unmount } = render(<CallModal call={{ status: "incoming", whoLabel: "driver" }} />);
  expect(startRingtone).toHaveBeenCalledWith("driver");
  unmount();
  expect(stopRingtone).toHaveBeenCalledTimes(1);
});
