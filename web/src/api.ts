import type {
  HomeData,
  LevelSuggestion,
  ListeningResult,
  LlmStatus,
  ProgressData,
  SessionCompleteResult,
  SessionWithPack,
  Settings,
  SrsCardRow,
  SrsRating,
  WordRow,
  WritingFeedback,
} from './types';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...((init?.headers as Record<string, string> | undefined) ?? {}) };
  if (!('Content-Type' in headers)) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { ...init, headers });
  if (res.status === 401) {
    let msg = 'unauthorized';
    try {
      const body = await res.json();
      msg = (body as { error?: string }).error ?? msg;
    } catch {
      /* keep default */
    }
    if (path !== '/api/login') {
      // Session expired -> let the router send the user to the login screen.
      window.dispatchEvent(new CustomEvent('kt:unauthorized'));
    }
    throw new ApiError(401, msg);
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      msg = (body as { error?: string }).error ?? msg;
    } catch {
      /* keep default */
    }
    throw new ApiError(res.status, msg);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  login: (password: string) =>
    request<{ ok: boolean }>('/api/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => request<{ ok: boolean }>('/api/logout', { method: 'POST', body: '{}' }),
  me: () => request<{ authenticated: boolean }>('/api/me'),
  health: () => request<{ ok: boolean; tz: string }>('/api/health'),

  home: () => request<HomeData>('/api/home'),
  sessionToday: () => request<{ session: SessionWithPack | null }>('/api/session/today'),
  startSession: () => request<{ session: SessionWithPack }>('/api/session/start', { method: 'POST', body: '{}' }),
  setStep: (id: number, step: string) =>
    request<{ ok: boolean }>(`/api/session/${id}/step`, { method: 'POST', body: JSON.stringify({ step }) }),
  completeSession: (id: number, duration_s: number) =>
    request<SessionCompleteResult>(`/api/session/${id}/complete`, {
      method: 'POST',
      body: JSON.stringify({ duration_s }),
    }),
  applyLevel: (action: 'up' | 'down') =>
    request<{ level: number }>('/api/level', { method: 'POST', body: JSON.stringify({ action }) }),

  wordTap: (id: number, surface: string) =>
    request<{ found: boolean; isNew?: boolean; word?: WordRow }>(`/api/session/${id}/word-tap`, {
      method: 'POST',
      body: JSON.stringify({ surface }),
    }),
  warmupCards: (id: number) => request<{ cards: SrsCardRow[] }>(`/api/session/${id}/warmup`),
  reviewCard: (wordId: number, rating: SrsRating) =>
    request<{ due_date: string }>('/api/srs/review', { method: 'POST', body: JSON.stringify({ word_id: wordId, rating }) }),

  gradeRead: (id: number, answers: number[]) =>
    request<{ correct: boolean[] }>(`/api/session/${id}/read`, {
      method: 'POST',
      body: JSON.stringify({ answers }),
    }),

  submitWriting: (id: number, text: string) =>
    request<{ entry_id: number; queued: boolean; feedback: WritingFeedback | null }>(
      `/api/session/${id}/writing`,
      { method: 'POST', body: JSON.stringify({ text }) },
    ),
  getWriting: (entryId: number) =>
    request<{ entry: Record<string, unknown>; feedback: WritingFeedback | null }>(`/api/writing/${entryId}`),

  gradeListening: (id: number, transcripts: string[]) =>
    request<ListeningResult>(`/api/session/${id}/listening`, {
      method: 'POST',
      body: JSON.stringify({ transcripts }),
    }),

  readAloud: (id: number, sentenceIndex: number, transcript: string) =>
    request<{ percent: number; attempt_id: number }>(`/api/session/${id}/speaking/read-aloud`, {
      method: 'POST',
      body: JSON.stringify({ sentence_index: sentenceIndex, transcript }),
    }),
  gradeReadAloudSelf: (target: string, transcript: string) =>
    request<{ percent: number; attempt_id: number }>('/api/practice/read-aloud', {
      method: 'POST',
      body: JSON.stringify({ target, transcript }),
    }),
  freeSpeech: (id: number | null, audio: Blob, mime: string) => {
    const url = id === null ? '/api/practice/free-response' : `/api/session/${id}/speaking/free-response`;
    return request<{ attempt_id: number; queued: boolean }>(url, {
      method: 'POST',
      body: audio,
      headers: { 'Content-Type': mime },
    });
  },
  getSpeakingAttempt: (attemptId: number) =>
    request<{ attempt: { id: number; audio_path?: string | null; session_id?: number | null } | null; feedback: unknown | null }>(
      `/api/speaking/${attemptId}`,
    ),
  practiceRead: () => request<{ pack: SessionWithPack['pack'] | null }>('/api/practice/read'),

  words: () => request<{ words: WordRow[] }>('/api/words'),
  addWord: (input: { lemma: string; surface: string; meaning_en: string; pos?: string }) =>
    request<{ word: WordRow; isNew: boolean }>('/api/words', { method: 'POST', body: JSON.stringify(input) }),

  progress: () => request<ProgressData>('/api/progress'),
  llmStatus: () => request<LlmStatus>('/api/llm/status'),
  getSettings: () => request<Settings>('/api/settings'),
  updateSettings: (patch: Partial<Settings>) =>
    request<Settings>('/api/settings', { method: 'PUT', body: JSON.stringify(patch) }),
};

export const humanizeLevel = (level: number): string =>
  ['', 'Beginner 1', 'Beginner 2', 'Beginner 3', 'Intermediate 1', 'Intermediate 2', 'Advanced'][level] ?? `Level ${level}`;

export function posLabel(pos: string): string {
  const map: Record<string, string> = {
    noun: 'noun',
    verb: 'verb',
    adjective: 'adjective',
    adverb: 'adverb',
    numeral: 'numeral',
    counter: 'counter',
    expression: 'expression',
    particle: 'particle',
  };
  return map[pos] ?? pos;
}

export function scorePercent(score: number | null | undefined): number | null {
  if (score === null || score === undefined) return null;
  return Math.round((score / 5) * 100);
}

export function timeEstimate(level: number): number {
  // minutes
  return level <= 2 ? 12 : level <= 4 ? 18 : 25;
}

export function levelSuggestionToPrompt(s: LevelSuggestion | null | undefined): string {
  if (!s) return 'No level change suggested yet.';
  if (s.action === 'up') return `Well done! Consider moving up to ${humanizeLevel(s.suggested_level)}.`;
  if (s.action === 'down') return `Today was tough. Consider easing back to ${humanizeLevel(s.suggested_level)}.`;
  return 'You are right on track. Keep practising!';
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}