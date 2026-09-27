import { useCallback, useEffect, useRef, useState } from 'react';

export interface TtsOptions {
  rate?: number;
  voiceUri?: string | null;
  onEnd?: () => void;
  onError?: (msg: string) => void;
}

/**
 * What the hook needs to know about the language being spoken.
 *
 * Supplied by the caller from `settings.lang` rather than imported from a
 * context, so a hook used before the descriptor has loaded still has a defined
 * behaviour instead of reaching for a default.
 */
export interface TtsLanguage {
  /** BCP-47 tag, e.g. `ko-KR` or `fr-FR`. */
  locale: string;
  defaultVoice: string;
}

function osVoices(): SpeechSynthesisVoice[] {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return [];
  return window.speechSynthesis.getVoices();
}

/** The language part of a BCP-47 tag, lowercased: `fr-FR` -> `fr`. */
function baseLanguage(locale: string): string {
  return locale.split('-')[0].toLowerCase();
}

function osVoiceFor(locale: string): SpeechSynthesisVoice | undefined {
  const base = baseLanguage(locale);
  return osVoices().find((v) => v.lang?.toLowerCase().startsWith(base));
}

/**
 * Neural TTS for the active language: 1) Edge TTS proxied through /api/tts
 * (free, natural), 2) the Web Speech API if the OS has a voice for this
 * language, 3) give up.
 *
 * The Web Speech fallback used to look specifically for a `ko` voice and fall
 * back to speaking with `u.lang = 'ko-KR'`, so on a machine with only a French
 * OS voice a French learner either got silence or, worse, an utterance tagged
 * as Korean — the browser's own version of the leak /api/tts now refuses.
 */
export function useTts(lang: TtsLanguage) {
  const { locale, defaultVoice } = lang;
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
      const voice = opts.voiceUri ?? defaultVoice;
      const fail = (msg: string) => opts.onError?.(msg);

      void playServer(text, voice, ratePercent).then((ok) => {
        if (ok) return;
        const osVoice = 'speechSynthesis' in window ? osVoiceFor(locale) : undefined;
        if (osVoice) {
          const u = new SpeechSynthesisUtterance(text);
          u.lang = locale;
          u.rate = opts.rate ?? 1;
          u.voice = osVoice;
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
    [defaultVoice, locale, playServer, stop, supported],
  );

  return { speak, stop, speaking, supported };
}