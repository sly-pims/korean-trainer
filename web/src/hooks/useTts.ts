import { useCallback, useEffect, useRef, useState } from 'react';

export interface TtsOptions {
  rate?: number;
  voiceUri?: string | null;
  lang?: string;
  onEnd?: () => void;
  onError?: (msg: string) => void;
}

const DEFAULT_VOICE = 'ko-KR-SunHiNeural';

function osVoices(): SpeechSynthesisVoice[] {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return [];
  return window.speechSynthesis.getVoices();
}

function hasRealKoreanVoice(): boolean {
  if (!('speechSynthesis' in window)) return false;
  return osVoices().some((v) => v.lang?.toLowerCase().startsWith('ko'));
}

/**
 * Korean TTS: 1) neural Edge TTS proxied through /api/tts (free, natural),
 * 2) Web Speech if a real Korean OS voice exists, 3) Google Translate fallback.
 */
export function useTts() {
  const [speaking, setSpeaking] = useState(false);
  const [supported] = useState(() => typeof window !== 'undefined' && typeof Audio !== 'undefined');
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);

  const stop = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  useEffect(() => {
    return stop;
  }, [stop]);

  const playServer = useCallback(
    async (text: string, voice: string, ratePercent: number): Promise<boolean> => {
      const q =
        `?text=${encodeURIComponent(text.slice(0, 400))}` +
        `&voice=${encodeURIComponent(voice)}&rate=${Math.max(-50, Math.min(100, ratePercent))}`;
      let res: Response;
      try {
        res = await fetch(`/api/tts${q}`);
      } catch {
        return false;
      }
      if (!res.ok) return false;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      urlRef.current = url;
      audioRef.current = audio;
      audio.onplay = () => setSpeaking(true);
      audio.onended = () => {
        setSpeaking(false);
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
        audioRef.current = null;
      };
      audio.onerror = () => {
        setSpeaking(false);
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
        audioRef.current = null;
      };
      try {
        await audio.play();
        return true;
      } catch {
        return false;
      }
    },
    [],
  );

  const speak = useCallback(
    (text: string, opts: TtsOptions = {}) => {
      stop();
      if (!supported || !text.trim()) return;
      const ratePercent = Math.round(((opts.rate ?? 1) - 1) * 100);
      const voice = opts.voiceUri ?? DEFAULT_VOICE;
      const fail = (msg: string) => opts.onError?.(msg);

      void playServer(text, voice, ratePercent).then((ok) => {
        if (ok) return;
        if (hasRealKoreanVoice()) {
          const u = new SpeechSynthesisUtterance(text);
          u.lang = opts.lang ?? 'ko-KR';
          u.rate = opts.rate ?? 1;
          const v = osVoices().find((vv) => vv.lang?.toLowerCase().startsWith('ko'));
          if (v) u.voice = v;
          u.onstart = () => setSpeaking(true);
          u.onend = () => {
            setSpeaking(false);
            opts.onEnd?.();
          };
          u.onerror = () => {
            setSpeaking(false);
            fail('speech synthesis failed');
          };
          window.speechSynthesis.cancel();
          window.speechSynthesis.speak(u);
          return;
        }
        fail('TTS unavailable');
      });
    },
    [playServer, stop, supported],
  );

  return { speak, stop, speaking, supported };
}