import { useCallback, useEffect, useRef, useState } from "react";
import Peer from "simple-peer";
import useSocket from "../hooks/useSocket";
import { apiGet } from "./api";

// Voice calls over WebRTC with the server-side signaling (concept 1.7.1):
// call:invite -> call:answer -> call:end. Audio only, relay via TURN when
// configured, so participant IP addresses stay hidden.
// TURN credentials are issued per order: a direct call borrows the order
// already linked to its chat (the call itself has no order yet).
const getIceConfig = async (orderId, signal) => {
  try {
    let id = orderId;
    if (!id) {
      const chats = await apiGet("/api/chats/my", { signal });
      const withOrder = (chats.data.chats ?? []).find((chat) => chat.orderId);
      id = withOrder?.orderId ?? null;
    }
    if (!id) throw new Error("Нет заказа для звонка");
    const res = await apiGet(`/api/calls/ice?orderId=${id}`, { signal });
    return {
      iceServers: res.data.iceServers,
      iceTransportPolicy: res.data.iceTransportPolicy,
    };
  } catch (error) {
    if (signal.aborted) throw error;
    return { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
  }
};

// Speaker routing when the browser exposes audio output devices.
const setSpeakerOutput = async (on) => {
  try {
    const el = document.querySelector("audio[data-call-audio]") ?? document.querySelector("audio");
    if (!el || typeof el.setSinkId !== "function") return;
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    const outputs = devices.filter((d) => d.kind === "audiooutput");
    const pick = outputs.find((d) => /speaker|громк/i.test(d.label)) ?? outputs[0];
    if (pick) await el.setSinkId(pick.deviceId);
  } catch {}
};

const useCall = () => {
  const { socket } = useSocket();
  const [call, setCall] = useState({ status: "idle" });
  const callRef = useRef(call);
  const sessionRef = useRef(null);
  const mountedRef = useRef(false);

  const updateCall = useCallback((next) => {
    callRef.current = typeof next === "function" ? next(callRef.current) : next;
    if (mountedRef.current) setCall(callRef.current);
  }, []);

  const finishCall = useCallback((next = { status: "idle" }, reason) => {
    const current = callRef.current;
    const session = sessionRef.current;
    sessionRef.current = null;
    // Abort invalidates pending microphone/ICE work and every peer callback.
    session?.controller.abort();
    session?.stream?.getTracks().forEach((track) => track.stop());
    session?.peer?.destroy();
    updateCall(next);
    if (reason && current.callId) socket.emit("call:end", { callId: current.callId, reason });
  }, [socket, updateCall]);

  const fail = useCallback((error) => {
    const current = callRef.current;
    finishCall({
      status: "failed",
      error: error?.message ?? error ?? "Звонок не состоялся",
      peerName: current.peerName,
      peerRoleLabel: current.peerRoleLabel,
    }, "cancel");
  }, [finishCall]);

  const createPeer = useCallback(async (session, { initiator, orderId }) => {
    const { signal } = session.controller;
    if (signal.aborted) return null;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (signal.aborted) {
      stream.getTracks().forEach((track) => track.stop());
      return null;
    }
    session.stream = stream;
    const config = await getIceConfig(orderId, signal);
    if (signal.aborted) return null;
    const peer = new Peer({ initiator, trickle: false, stream, config });
    session.peer = peer;
    peer.on("error", (error) => {
      if (!signal.aborted) fail(error);
    });
    peer.on("close", () => {
      if (!signal.aborted) finishCall(undefined, "hangup");
    });
    peer.on("stream", (remoteStream) => {
      if (!signal.aborted) updateCall((prev) => ({ ...prev, status: "active", remoteStream }));
    });
    return peer;
  }, [fail, finishCall, updateCall]);

  const startCall = useCallback(async (options) => {
    if (!mountedRef.current || callRef.current.status !== "idle") return;
    const { kind, target, orderId, cityId, chatId, name, fromRole, onAck } = options;
    const session = { controller: new AbortController(), target };
    sessionRef.current = session;
    const { signal } = session.controller;
    updateCall({ status: "calling", peerName: name, peerRoleLabel: name, peerEmoji: "🧑‍✈️", kind, orderId, chatId });
    try {
      const peer = await createPeer(session, { initiator: true, orderId });
      if (!peer || signal.aborted) return;

      peer.on("signal", (signalData) => {
        if (signal.aborted) return;
        socket.emit(
          "call:invite",
          { kind, target, orderId, cityId, chatId, fromRole, signalData },
          (ack) => {
            if (signal.aborted) {
              // An invite already sent to the server may finish after hangup.
              if (ack?.callId) socket.emit("call:end", { callId: ack.callId, reason: "cancel" });
              return;
            }
            if (ack?.error || !ack?.callId) {
              fail(ack?.error ?? "Не удалось начать звонок");
            } else {
              updateCall((prev) => ({
                ...prev,
                status: prev.status === "active" ? "active" : "ringing",
                callId: ack.callId,
                chatId: ack.chatId ?? prev.chatId,
                orderId: ack.orderId ?? prev.orderId,
                audioTracks: session.stream?.getAudioTracks?.() ?? [],
                speakerSink: setSpeakerOutput,
              }));
              onAck?.({ callId: ack.callId, chatId: ack.chatId });
            }
          }
        );
      });
    } catch (error) {
      if (!signal.aborted) fail(error);
    }
  }, [createPeer, fail, socket, updateCall]);

  useEffect(() => {
    mountedRef.current = true;
    const matchesCall = (payload) => Boolean(callRef.current.callId) &&
      String(payload?.callId) === String(callRef.current.callId);
    const onInvite = ({ callId, orderId, chatId, kind, from, fromName, fromRole, signalData }) => {
      if (callRef.current.status !== "idle") {
        socket.emit("call:end", { callId, reason: "decline" });
        return;
      }
      sessionRef.current = { controller: new AbortController(), target: from };
      updateCall({
        status: "incoming",
        callId,
        orderId,
        chatId,
        kind,
        peerId: from,
        peerName: fromName,
        peerRoleLabel: fromRole === "driver" ? "водитель" : "пассажир",
        peerEmoji: fromRole === "driver" ? "🧑‍✈️" : "🧍",
        whoLabel: fromRole === "driver" ? "driver" : "passenger",
        signalData,
      });
    };

    const onAnswer = (payload) => {
      const session = sessionRef.current;
      if (!matchesCall(payload) || !session?.peer) return;
      try {
        session.peer.signal(payload.signalData);
        if (!session.controller.signal.aborted) updateCall((prev) => ({ ...prev, status: "active" }));
      } catch (error) {
        fail(error);
      }
    };

    const onIce = (payload) => {
      if (!matchesCall(payload) || !sessionRef.current?.peer) return;
      try {
        sessionRef.current.peer.signal(payload.candidate);
      } catch (error) {
        fail(error);
      }
    };

    const onEnd = (payload) => {
      if (matchesCall(payload)) finishCall();
    };

    const onBusy = (payload) => {
      const session = sessionRef.current;
      if (!session || (payload?.target && String(payload.target) !== String(session.target))) return;
      if (payload?.callId && !matchesCall(payload)) return;
      fail(payload?.error);
    };
    const onError = (payload) => {
      if (matchesCall(payload)) fail(payload?.error);
    };

    socket.on("call:invite", onInvite);
    socket.on("call:answer", onAnswer);
    socket.on("call:ice", onIce);
    socket.on("call:end", onEnd);
    socket.on("call:busy", onBusy);
    socket.on("call:error", onError);

    return () => {
      mountedRef.current = false;
      socket.off("call:invite", onInvite);
      socket.off("call:answer", onAnswer);
      socket.off("call:ice", onIce);
      socket.off("call:end", onEnd);
      socket.off("call:busy", onBusy);
      socket.off("call:error", onError);
      finishCall(undefined, "cancel");
    };
  }, [fail, finishCall, socket, updateCall]);

  const acceptCall = async () => {
    const current = callRef.current;
    const session = sessionRef.current;
    if (!mountedRef.current || current.status !== "incoming" || !session) return;
    const { signal } = session.controller;
    updateCall((prev) => ({ ...prev, status: "connecting" }));
    try {
      const peer = await createPeer(session, { initiator: false, orderId: current.orderId });
      if (!peer || signal.aborted) return;
      peer.on("signal", (signalData) => {
        if (!signal.aborted) socket.emit("call:answer", { callId: current.callId, signalData });
      });

      peer.signal(current.signalData);
      if (signal.aborted) return;
      updateCall((prev) => ({
        ...prev,
        status: "active",
        accepted: true,
        audioTracks: session.stream?.getAudioTracks?.() ?? [],
        speakerSink: setSpeakerOutput,
      }));
    } catch (error) {
      if (!signal.aborted) fail(error);
    }
  };

  const endCall = (reason = "hangup") => {
    finishCall(undefined, reason);
  };

  return { call, startCall, acceptCall, endCall };
};

export default useCall;
