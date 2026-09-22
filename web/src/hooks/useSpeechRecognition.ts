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
  onend: (() => void) | null;
  lang: string;
  continuous: boolean;
  interimResults: boolean;
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

/** Wraps the (vendor-prefixed) Web Speech API for ko-KR dictation. */
export function useSpeechRecognition(lang = 'ko-KR') {
  const [supported] = useState(() => getRecognition() !== null);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [final, setFinal] = useState('');
  const [error, setError] = useState('');
  const recRef = useRef<RecLike | null>(null);
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

  const stop = useCallback(() => {
    recRef.current?.stop();
  }, []);

  const start = useCallback(() => {
    const Ctor = getRecognition();
    if (!Ctor) return;
    setError('');
    const rec = new Ctor();
    rec.lang = langRef.current;
    rec.continuous = false;
    rec.interimResults = true;
    rec.onresult = (e) => {
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
      setListening(false);
      const done = finalRef.current;
      if (done.trim()) onFinalRef.current(done.trim());
      finalRef.current = '';
      interimRef.current = '';
      setFinal('');
      setInterim('');
    };
    rec.onerror = (event) => {
      setListening(false);
      const reason = event.error === 'not-allowed' || event.error === 'service-not-allowed'
        ? 'Microphone access was blocked. Allow microphone access or type the transcript below.'
        : `Speech recognition failed${event.error ? `: ${event.error}` : ''}. You can type the transcript below.`;
      setError(reason);
    };
    recRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      setListening(false);
      setError('Could not start speech recognition. You can type the transcript below.');
    }
  }, []);

  useEffect(() => {
    return () => {
      recRef.current?.abort();
    };
  }, []);

  return { supported, listening, start, stop, final, interim, error, onFinal, onInterim };
}