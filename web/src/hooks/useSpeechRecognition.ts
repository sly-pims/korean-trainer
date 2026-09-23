import { useCallback, useEffect, useRef, useState } from 'react';

interface RecResult {
  isFinal: boolean;
  0: { transcript: string };
}

interface RecEventLike {
  resultIndex: number;
  results: ArrayLike<RecResult>;
}

type RecLike = {
  onresult: ((e: RecEventLike) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onspeechstart: (() => void) | null;
  onend: (() => void) | null;
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
};

type RecCtor = new () => RecLike;

function getRecognition(): RecCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: RecCtor; webkitSpeechRecognition?: RecCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

// Chromium on Android fires these transiently (audio focus, teardown races).
const TRANSIENT_ERRORS = new Set(['aborted', 'abort', 'no-speech', 'audio-capture', 'network']);
const MAX_RETRIES = 1;
const RETRY_DELAY_MS = 600;

/** Wraps the (vendor-prefixed) Web Speech API for ko-KR dictation. */
export function useSpeechRecognition(lang = 'ko-KR') {
  const [supported] = useState(() => getRecognition() !== null);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [final, setFinal] = useState('');
  const [error, setError] = useState('');
  const recRef = useRef<RecLike | null>(null);
  const activeRef = useRef(false);
  const genRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finalRef = useRef('');
  const interimRef = useRef('');
  const langRef = useRef(lang);
  const onFinalRef = useRef<(text: string) => void>(() => {});
  const onInterimRef = useRef<(text: string) => void>(() => {});
  langRef.current = lang;

  const onFinal = useCallback((fn: (text: string) => void) => {
    onFinalRef.current = fn;
  }, []);
  const onInterim = useCallback((fn: (text: string) => void) => {
    onInterimRef.current = fn;
  }, []);

  const clearTimers = useCallback(() => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    clearTimers();
    recRef.current?.stop();
  }, [clearTimers]);

  const start = useCallback(() => {
    const Ctor = getRecognition();
    if (!Ctor || activeRef.current) return;
    activeRef.current = true;
    const gen = ++genRef.current;
    setError('');
    setFinal('');
    setInterim('');
    finalRef.current = '';
    interimRef.current = '';

    const rec = new Ctor();
    rec.lang = langRef.current;
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    recRef.current = rec;

    const endSession = () => {
      setListening(false);
      if (genRef.current === gen) activeRef.current = false;
    };

    rec.onresult = (e) => {
      if (genRef.current !== gen) return;
      let interimText = '';
      let finalText = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interimText += r[0].transcript;
      }
      finalRef.current += finalText;
      interimRef.current = interimText;
      setFinal(finalRef.current);
      setInterim(interimText);
      onInterimRef.current(finalRef.current + interimText);
    };

    rec.onend = () => {
      endSession();
      const done = finalRef.current || interimRef.current;
      if (genRef.current === gen) {
        if (done.trim()) onFinalRef.current(done.trim());
        finalRef.current = '';
        interimRef.current = '';
        setFinal('');
        setInterim('');
      }
    };

    rec.onerror = (event) => {
      if (genRef.current !== gen) return;
      const transient = TRANSIENT_ERRORS.has(event.error ?? '');
      // Don't retry permission denials — turning them into an infinite loop is worse.
      if (transient && genRef.current === gen && activeRef.current && MAX_RETRIES > 0) {
        endSession();
        if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = null;
          if (genRef.current === gen) start();
        }, RETRY_DELAY_MS);
        return;
      }
      endSession();
      const reason =
        event.error === 'not-allowed' || event.error === 'service-not-allowed'
          ? 'Microphone access was blocked. Allow microphone access in your browser settings, or type the transcript below.'
          : `Speech recognition failed${event.error ? `: ${event.error}` : ''}. You can type the transcript below.`;
      setError(reason);
    };

    try {
      rec.start();
      setListening(true);
    } catch {
      endSession();
      setError('Could not start speech recognition. You can type the transcript below.');
    }
  }, []);

  useEffect(() => {
    return () => {
      clearTimers();
      recRef.current?.abort();
    };
  }, [clearTimers]);

  return { supported, listening, start, stop, final, interim, error, onFinal, onInterim };
}