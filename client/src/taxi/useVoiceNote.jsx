import { useEffect, useRef, useState } from "react";
import { useReactMediaRecorder } from "react-media-recorder";
import { apiUpload } from "./api";

// Voice note recording for a conversation: the elapsed time is tracked in a
// ref so the recorder's onStop callback always sees the real duration (a
// closure over state would report 0 on the first render).
const useVoiceNote = ({ fileType = "audio", context = {}, onBlob } = {}) => {
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const timerRef = useRef(null);
  const secondsRef = useRef(0);
  const contextRef = useRef(context);
  const onBlobRef = useRef(onBlob);
  contextRef.current = context;
  onBlobRef.current = onBlob;

  useEffect(() => () => clearInterval(timerRef.current), []);

  const { startRecording, stopRecording } = useReactMediaRecorder({
    audio: true,
    onStop: async (_, blob) => {
      clearInterval(timerRef.current);
      try {
        if (!blob) throw new Error("Запись не получилась");
        setUploading(true);
        // A falsy context (e.g. a blocked dialog) means "do not upload"
        if (!contextRef.current) return;
        const uploadData = await apiUpload(blob, fileType, contextRef.current);
        await onBlobRef.current?.(uploadData, Math.max(1, secondsRef.current));
      } catch (err) {
        setError(err.message);
      } finally {
        setUploading(false);
        setRecording(false);
      }
    },
  });

  const toggle = () => {
    if (recording) {
      clearInterval(timerRef.current);
      stopRecording();
      return;
    }
    secondsRef.current = 0;
    setRecordSeconds(0);
    setRecording(true);
    timerRef.current = setInterval(() => {
      secondsRef.current += 1;
      setRecordSeconds(secondsRef.current);
    }, 1000);
    startRecording();
  };

  return { recording, recordSeconds, uploading, error, toggle };
};

export default useVoiceNote;
