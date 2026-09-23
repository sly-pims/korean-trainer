import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSpeechRecognition } from './useSpeechRecognition';

interface FakeEventLike {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}

class FakeRec {
  static instances: FakeRec[] = [];
  onresult: ((e: FakeEventLike) => void) | null = null;
  onerror: ((e: { error?: string }) => void) | null = null;
  onspeechstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  lang = '';
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  started = false;
  stopped = false;
  aborted = false;
  constructor() {
    FakeRec.instances.push(this);
  }
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
  abort() {
    this.aborted = true;
  }
}

function finalResult(text: string): { resultIndex: 0; results: ArrayLike<{ isFinal: true; 0: { transcript: string } }> } {
  return { resultIndex: 0, results: { length: 1, 0: { isFinal: true, 0: { transcript: text } } } };
}
function interimResult(text: string) {
  return { resultIndex: 0, results: { length: 1, 0: { isFinal: false, 0: { transcript: text } } } };
}

beforeEach(() => {
  FakeRec.instances = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function installRecognition(RecCtor: typeof FakeRec) {
  vi.stubGlobal('SpeechRecognition', RecCtor);
  vi.stubGlobal('webkitSpeechRecognition', RecCtor);
}

describe('useSpeechRecognition', () => {
  it('auto-restarts once on a spurious abort at start, then delivers the transcript', () => {
  installRecognition(FakeRec);
  const { result } = renderHook(() => useSpeechRecognition('ko-KR'));
  const finals: string[] = [];
  act(() => result.current.onFinal((t) => finals.push(t)));

  act(() => result.current.start());
  expect(result.current.supported).toBe(true);
  expect(result.current.listening).toBe(true);
  expect(FakeRec.instances.length).toBe(1);

  // Chromium aborts the freshly-started session for no reason.
  act(() => FakeRec.instances[0].onerror?.({ error: 'aborted' }));
  act(() => vi.advanceTimersByTime(600));
  expect(FakeRec.instances.length).toBe(2);
  expect(result.current.listening).toBe(true);

  // Second session hears speech and finishes normally.
  act(() => FakeRec.instances[1].onresult?.(finalResult('안녕하세요')));
  act(() => FakeRec.instances[1].onend?.());
  expect(result.current.listening).toBe(false);
  expect(finals).toEqual(['안녕하세요']);
  expect(result.current.error).toBe('');
});

it('does NOT auto-restart when the user taps Stop after speaking', () => {
  installRecognition(FakeRec);
  const { result } = renderHook(() => useSpeechRecognition('ko-KR'));
  const finals: string[] = [];
  act(() => result.current.onFinal((t) => finals.push(t)));

  act(() => result.current.start());
  const rec1 = FakeRec.instances[0];
  act(() => rec1.onresult?.(interimResult('오늘 날씨가 너무 좋아요')));

  // User taps Stop (mid/after speech) -> Chromium reports 'aborted'.
  act(() => result.current.stop());
  act(() => rec1.onerror?.({ error: 'aborted' }));
  act(() => vi.advanceTimersByTime(1000));
  expect(FakeRec.instances.length).toBe(1); // no retry, no restart

  // The transcript still gets finalized (onend follows the aborted error).
  act(() => rec1.onend?.());
  expect(result.current.listening).toBe(false);
  expect(finals).toEqual(['오늘 날씨가 너무 좋아요']);
  expect(result.current.error).toBe('');
});

it('shows a permission error and never retries when mic access is blocked', () => {
  installRecognition(FakeRec);
  const { result } = renderHook(() => useSpeechRecognition('ko-KR'));
  act(() => result.current.start());
  act(() => FakeRec.instances[0].onerror?.({ error: 'not-allowed' }));
  act(() => vi.advanceTimersByTime(1000));
  expect(FakeRec.instances.length).toBe(1);
  expect(result.current.listening).toBe(false);
  expect(result.current.error).toMatch(/Microphone access was blocked/i);
});

it('ignores a second start() while a session is already active', () => {
  installRecognition(FakeRec);
  const { result } = renderHook(() => useSpeechRecognition('ko-KR'));
  act(() => result.current.start());
  act(() => result.current.start());
  expect(FakeRec.instances.length).toBe(1);
});

it('aborts the active recognizer on unmount', () => {
  installRecognition(FakeRec);
  const { result, unmount } = renderHook(() => useSpeechRecognition('ko-KR'));
  act(() => result.current.start());
  unmount();
  expect(FakeRec.instances[0].aborted).toBe(true);
});

it('reports unsupported when no SpeechRecognition is exposed', () => {
  installRecognition(
    class EmptyRec extends FakeRec {
      static instances: FakeRec[] = [];
    },
  );
  vi.stubGlobal('SpeechRecognition', undefined);
  vi.stubGlobal('webkitSpeechRecognition', undefined);
  const { result } = renderHook(() => useSpeechRecognition('ko-KR'));
  expect(result.current.supported).toBe(false);
  expect(() => act(() => result.current.start())).not.toThrow();
  expect(result.current.listening).toBe(false);
});
});