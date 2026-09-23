import { useCallback, useEffect, useRef, useState } from 'react';

export interface RecordingState {
  supported: boolean;
  recording: boolean;
  elapsedMs: number;
  blob: Blob | null;
  mimeType: string;
  error: string | null;
}

const MIME_PRIORITY = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

function pickMime(): { mime: string; ext: string } | null {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return null;
  if (typeof MediaRecorder === 'undefined') return null;
  for (const m of MIME_PRIORITY) {
    if (MediaRecorder.isTypeSupported(m)) return { mime: m, ext: m.includes('mp4') ? 'audio/mp4' : m.includes('ogg') ? 'audio/ogg' : 'audio/webm' };
  }
  return { mime: '', ext: 'audio/webm' };
}

/** MediaRecorder wrapper for ≤60 s voice notes. Returns a Blob for upload. */
export function useMediaRecorder(onStartError?: (msg: string) => void): RecordingState & {
  ready(): Blob | null; // returns the recording when stopped
  start(): Promise<void>;
  stop(): void;
  reset(): void;
} {
  const mediaRef = useRef<MediaStream | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const [state, setState] = useState<RecordingState>({
    supported: pickMime() !== null,
    recording: false,
    elapsedMs: 0,
    blob: null,
    mimeType: '',
    error: null,
  });
  const chunksRef = useRef<Blob[]>([]);
  const startMsRef = useRef<number>(0);

  const reset = useCallback(() => {
    setState((s) => ({ ...s, blob: null, elapsedMs: 0, error: null }));
  }, []);

  const stop = useCallback(() => {
    const rec = recRef.current;
    if (rec && rec.state !== 'inactive') {
      // Flush any buffered audio *before* stopping so a final blob always
      // materialises (some Android builds drop empty final dataavailable events).
      try {
        rec.requestData();
      } catch {
        // requestData is optional on some platforms; ignore.
      }
      rec.stop();
    }
    mediaRef.current?.getTracks().forEach((t) => t.stop());
    mediaRef.current = null;
    setState((s) => ({ ...s, recording: false }));
  }, []);

  const start = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      onStartError?.('Microphone not available (requires HTTPS).');
      return;
    }
    const { mime, ext } = pickMime()!;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Hard cap at 60 s: if the user keeps talking, cut the recording.
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        const blob = chunksRef.current.length ? new Blob(chunksRef.current, { type: ext }) : null;
        setState((s) => ({
          ...s,
          recording: false,
          blob,
          mimeType: ext,
          elapsedMs: Date.now() - startMsRef.current,
          error: blob ? null : s.error ?? 'No audio was captured — please try again.',
        }));
      };
      rec.onerror = () => {
        setState((s) => ({ ...s, recording: false, error: 'Recording failed.' }));
      };
      recRef.current = rec;
      mediaRef.current = stream;
      startMsRef.current = Date.now();
      // Timeslice forces periodic dataavailable events, which some Android
      // builds skip when the recording is stopped without one.
      rec.start(250);
      setState((s) => ({ ...s, recording: true }));
    } catch (err) {
      onStartError?.(err instanceof Error ? err.message : 'Could not open the microphone.');
    }
  }, [onStartError]);

  const ready = useCallback(() => state.blob, [state.blob]);

  useEffect(() => {
    return () => {
      // Release the mic if a component unmounts mid-recording.
      mediaRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return { ...state, ready, start, stop, reset };
}