import type {
  HomeData,
  LanguageDescriptor as LanguageProfile,
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
  /**
   * Stable token from the server, e.g. `unknown_voice`. Undefined when the
   * response was not JSON or came from something older than `server/src/errors.ts`.
   * Screens translate this rather than `message`, so an error on a French
   * learner's screen does not turn into an English sentence.
   */
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Reads `{ code, error }` off a failed response, tolerating a non-JSON body. */
async function readError(res: Response): Promise<{ msg: string; code?: string }> {
  const fallback = { msg: `HTTP ${res.status}` };
  try {
    const body = (await res.json()) as { code?: string; error?: string };
    const msg = body.error ?? fallback.msg;
    return { msg, code: typeof body.code === 'string' ? body.code : undefined };
  } catch {
    return fallback;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...((init?.headers as Record<string, string> | undefined) ?? {}) };
  if (!('Content-Type' in headers)) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { ...init, headers });
  if (res.status === 401) {
    const { msg, code } = await readError(res);
    if (path !== '/api/login') {
      // Session expired -> let the router send the user to the login screen.
      window.dispatchEvent(new CustomEvent('kt:unauthorized'));
    }
    throw new ApiError(401, msg, code);
  }
  if (!res.ok) {
    const { msg, code } = await readError(res);
    throw new ApiError(res.status, msg, code);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface LanguageDescriptor {
  code: string;
  name: string;
  endonym: string;
  htmlLang: string;
  levels?: Record<string, { name: string }>;
}

export interface EnrollmentSummary {
  id: number;
  targetLang: string;
  nativeLang: string;
  uiLang: string;
  displayName: string;
  lang: LanguageDescriptor;
}

/**
 * `/api/account`: who is signed in, and which language they are currently in.
 *
 * The whole point of the type is that `activeEnrollmentId` and `settings.lang`
 * always describe the *same* enrollment. A client that renders copy from one and
 * saves settings to the other is how a French learner ends up writing their
 * settings into the Korean row.
 */
export interface AccountPayload {
  user: { id: number; username: string; display_name: string };
  activeEnrollmentId: number;
  enrollments: EnrollmentSummary[];
  /** Target languages this deployment offers that this account has not added. */
  availableTargetLangs: string[];
  targetLangs: LanguageDescriptor[];
  uiLangs: string[];
  /**
   * The active language's *full* profile, not the short descriptor the
   * enrollment list carries: this is `languageDescriptor(profile)` server-side,
   * so it has the level names, the voice allowlist and the locale that
   * `Settings.lang` does. Typing it as the short one let a caller reach for
   * `voices` and get a compile error for something the server does send.
   */
  lang: LanguageProfile;
  copy: Record<string, unknown>;
  settings: Settings;
}

export interface MetaPayload {
  defaultUiLang: string;
  supportedTargetLangs: string[];
  supportedUiLangs: string[];
  targetLangs: LanguageDescriptor[];
  uiLangs: string[];
  appName: string;
  appTagline: string;
  copy: Record<string, unknown>;
}

export const api = {
  login: (username: string, password: string) =>
    request<{ ok: boolean; account: AccountPayload }>('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request<{ ok: boolean }>('/api/logout', { method: 'POST', body: '{}' }),
  me: () => request<{ authenticated: boolean; username: string; enrollment_id: number; target_lang: string }>('/api/me'),
  health: () => request<{ ok: boolean; tz: string }>('/api/health'),
  /** Reachable without a session: a login screen needs the language list. */
  meta: () => request<MetaPayload>('/api/meta'),
  account: () => request<AccountPayload>('/api/account'),

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
  reviewCard: (wordId: number, rating: SrsRating) =>
    request<{ due_date: string }>('/api/srs/review', { method: 'POST', body: JSON.stringify({ word_id: wordId, rating }) }),

  srsDue: () => request<{ cards: SrsCardRow[]; due_total: number }>('/api/srs/due'),

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
  readAloudAudio: (id: number, sentenceIndex: number, audio: Blob, mime: string) =>
    request<{ percent: number; attempt_id: number; transcript: string }>(`/api/session/${id}/speaking/read-aloud`, {
      method: 'POST',
      body: audio,
      headers: { 'Content-Type': mime, 'X-Sentence-Index': String(sentenceIndex) },
    }),
  transcribe: (audio: Blob, mime: string) =>
    request<{ transcript: string }>('/api/transcribe', {
      method: 'POST',
      body: audio,
      headers: { 'Content-Type': mime },
    }),
  resetProgress: () =>
    request<{ ok: boolean }>('/api/progress', {
      method: 'DELETE',
      body: JSON.stringify({ confirm: 'reset' }),
    }),
  gradeReadAloudSelf: (target: string, transcript: string) =>
    request<{ percent: number; attempt_id: number }>('/api/practice/read-aloud', {
      method: 'POST',
      body: JSON.stringify({ target, transcript }),
    }),
  freeSpeech: (id: number | null, audio: Blob, mime: string) => {
    const url = id === null ? '/api/practice/free-response' : `/api/session/${id}/speaking/free-response`;
    return request<{ attempt_id: number; queued: boolean; feedback: import('./types').SpeakingFeedback | null }>(url, {
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
  addWord: (input: {
    lemma: string;
    surface: string;
    meaning_native: string;
    pos?: string;
    level?: number;
    source?: 'manual' | 'suggested';
    example_target?: string;
    example_native?: string;
  }) => request<{ word: WordRow; isNew: boolean }>('/api/words', { method: 'POST', body: JSON.stringify(input) }),
  suggestWords: (opts: { level?: number; topic?: string; count?: number }) =>
    request<{ suggestions: import('./types').WordSuggestion[] }>('/api/words/suggest', {
      method: 'POST',
      body: JSON.stringify(opts),
    }),

  progress: () => request<ProgressData>('/api/progress'),
  sessions: () => request<{ sessions: import('./types').SessionHistoryRow[] }>('/api/sessions'),
  sessionDetail: (id: number) =>
    request<{ detail: import('./types').SessionDetail | null }>(`/api/sessions/${id}/detail`),
  llmStatus: () => request<LlmStatus>('/api/llm/status'),
  getSettings: () => request<Settings>('/api/settings'),
  updateSettings: (patch: Partial<Settings>) =>
    request<Settings>('/api/settings', { method: 'PUT', body: JSON.stringify(patch) }),

  /**
   * Add a language. Returns `account` describing the enrollment that is *still*
   * active, plus the new one separately: adding is not switching, and
   * `activateEnrollment` is the only call that moves the session.
   */
  createEnrollment: (input: { target_lang: string; native_lang?: string; ui_lang?: string }) =>
    request<{ created: boolean; enrollment: EnrollmentSummary; account: AccountPayload }>('/api/enrollments', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  activateEnrollment: (id: number) =>
    request<{ ok: boolean; account: AccountPayload }>(`/api/enrollments/${id}/activate`, {
      method: 'POST',
      body: '{}',
    }),
};

/**
 * A level's name on the active language's own scale.
 *
 * This used to be a hardcoded array returning "Beginner 2" and "Advanced",
 * which is a guess at what TOPIK levels mean and simply wrong for a language
 * measured on CEFR. The server sends the real names, so the UI says `TOPIK 2`
 * or `CEFR B1` without knowing anything about either.
 *
 * `levels` is the descriptor's map, keyed by level number as a string.
 */
export const humanizeLevel = (level: number, levels: LevelMap): string => {
  const name = levels?.[String(level)]?.name;
  if (name) return name;
  // Before the descriptor arrives there is nothing to name the level, so show
  // the number rather than inventing a proficiency label for it.
  return `Level ${level}`;
};

/** The level map a {@link humanizeLevel} call needs, from wherever settings came. */
export type LevelMap = Settings['lang']['levels'];

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

export function levelSuggestionToPrompt(
  s: LevelSuggestion | null | undefined,
  levels: LevelMap,
): string {
  if (!s) return 'No level change suggested yet.';
  if (s.action === 'up') return `Well done! Consider moving up to ${humanizeLevel(s.suggested_level, levels)}.`;
  if (s.action === 'down') return `Today was tough. Consider easing back to ${humanizeLevel(s.suggested_level, levels)}.`;
  return 'You are right on track. Keep practising!';
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}