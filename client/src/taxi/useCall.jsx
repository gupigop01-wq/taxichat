import { useCallback, useEffect, useRef, useState } from "react";
import Peer from "simple-peer";
import useSocket from "../hooks/useSocket";
import { apiGet } from "./api";

// Voice calls over WebRTC with the server-side signaling (concept 1.7.1):
// call:invite -> call:answer -> call:end. Audio only, relay via TURN when
// configured, so participant IP addresses stay hidden.
const useCall = () => {
  const { socketEmit, socketListen, socket } = useSocket();
  const [call, setCall] = useState({ status: "idle" });

  const peerRef = useRef();
  const streamRef = useRef();
  const callRef = useRef();
  const onAckRef = useRef();

  callRef.current = call;

  const stopStream = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

  const reset = () => {
    peerRef.current?.destroy();
    peerRef.current = null;
    stopStream();
    setCall({ status: "idle" });
  };

  const getIceConfig = async (orderId) => {
    try {
      const res = await apiGet(
        `/api/calls/ice${orderId ? `?orderId=${orderId}` : ""}`
      );
      return {
        iceServers: res.data.iceServers,
        iceTransportPolicy: res.data.iceTransportPolicy,
      };
    } catch {
      return { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
    }
  };

  const createPeer = async ({ initiator, stream, orderId }) => {
    const config = await getIceConfig(orderId);
    const peer = new Peer({ initiator, trickle: false, stream, config });
    peerRef.current = peer;
    return peer;
  };

// Speaker routing: when the browser exposes audio output devices, switch the
// remote audio element between the earpiece and the loudspeaker.
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
  const startCall = useCallback(async (options) => {
    const { kind, target, orderId, cityId, chatId, name, fromRole, onAck } = options;
    onAckRef.current = onAck;
    try {
      setCall({ status: "calling", peerName: name, peerRoleLabel: name, peerEmoji: "🧑‍✈️", kind });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const peer = await createPeer({ initiator: true, stream, orderId });

      peer.on("signal", (signalData) => {
        socketEmit(
          "call:invite",
          { kind, target, orderId, cityId, chatId, fromRole, signalData },
          (ack) => {
            if (ack?.error) {
              // Keep the failure on screen until the user closes the call panel
              stopStream();
              setCall({ status: "failed", error: ack.error, peerName: name });
            } else {
              setCall((prev) => ({
                ...prev,
                status: "ringing",
                callId: ack.callId,
                chatId: ack.chatId,
                orderId: ack.orderId,
                audioTracks: streamRef.current?.getAudioTracks?.() ?? [],
                speakerSink: setSpeakerOutput,
              }));
              onAckRef.current?.({ callId: ack.callId, chatId: ack.chatId });
            }
          }
        );
      });

      peer.on("stream", (remoteStream) => {
        setCall((prev) => ({ ...prev, remoteStream }));
      });
    } catch (error) {
      stopStream();
      setCall({ status: "failed", error: error.message });
    }
  }, [socketEmit]);

  useEffect(() => {
    const onInvite = async ({ callId, orderId, chatId, kind, from, fromName, fromRole, signalData }) => {
      if (callRef.current.status !== "idle") {
        socketEmit("call:end", { callId, reason: "decline" });
        return;
      }
      setCall({
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

    const onAnswer = ({ signalData }) => {
      peerRef.current?.signal(signalData);
      setCall((prev) => ({ ...prev, status: "active" }));
    };

    const onIce = ({ candidate }) => {
      peerRef.current?.signal(candidate);
    };

    const onEnd = () => {
      reset();
    };

    const onBusy = ({ error }) => {
      stopStream();
      setCall({ status: "failed", error });
    };

    socketListen("call:invite", onInvite);
    socketListen("call:answer", onAnswer);
    socketListen("call:ice", onIce);
    socketListen("call:end", onEnd);
    socketListen("call:busy", onBusy);

    return () => {
      socket.off("call:invite", onInvite);
      socket.off("call:answer", onAnswer);
      socket.off("call:ice", onIce);
      socket.off("call:end", onEnd);
      socket.off("call:busy", onBusy);
    };
  }, [socket, socketListen]);

  const acceptCall = async () => {
    const current = callRef.current;
    setCall((prev) => ({ ...prev, status: "connecting" }));
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;

    const peer = await createPeer({
      initiator: false,
      stream,
      orderId: current.orderId,
    });
    peer.on("signal", (signalData) => {
      socketEmit("call:answer", { callId: current.callId, signalData });
    });
    peer.on("stream", (remoteStream) => {
      setCall((prev) => ({ ...prev, status: "active", remoteStream }));
    });

    peer.signal(current.signalData);
    setCall((prev) => ({
      ...prev,
      status: "active",
      accepted: true,
      audioTracks: streamRef.current?.getAudioTracks?.() ?? [],
      speakerSink: setSpeakerOutput,
    }));
  };

  const endCall = (reason = "hangup") => {
    const current = callRef.current;
    if (current.callId) {
      socketEmit("call:end", { callId: current.callId, reason });
    }
    reset();
  };

  return { call, startCall, acceptCall, endCall };
};

export default useCall;
