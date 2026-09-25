export interface GlossaryEntry {
  surface: string;
  lemma: string;
  pos: string;
  meaning_en: string;
}

export interface Question {
  q_ko: string;
  q_en: string;
  choices: string[];
  answer_index: number;
  explanation_en: string;
}

export interface ContentPack {
  level: number;
  topic: string;
  title_ko: string;
  passage_ko: string;
  passage_en: string;
  sentences: { ko: string; en: string }[];
  glossary: GlossaryEntry[];
  questions: Question[];
  writing_prompt: { ko: string; en: string; target_grammar: string };
  speaking_prompt: { ko: string; en: string };
}

export interface SessionRow {
  id: number;
  date: string;
  passage_id: number;
  status: 'in_progress' | 'done';
  current_step: string;
  read_score: number | null;
  write_score: number | null;
  listen_score: number | null;
  speak_score: number | null;
  vocab_score: number | null;
  duration_s: number | null;
}

export interface SessionWithPack {
  session: SessionRow;
  pack: ContentPack;
}

export interface Settings {
  level: number;
  tts_rate: number;
  tts_voice: string;
  show_romanization: boolean;
  keep_recordings_days: number;
  streak: number;
  last_session_date: string | null;
  timezone: string;
}

export interface HomeData {
  tz: string;
  todaySession: SessionWithPack | null;
  settings: Settings;
  tomorrowPackReady: boolean;
}

export interface SrsCardRow {
  word_id: number;
  ease: number;
  interval_days: number;
  due_date: string;
  reps: number;
  lapses: number;
  lemma: string;
  surface_example: string;
  meaning_en: string;
  pos: string;
  level: number;
}

export type SrsRating = 'again' | 'hard' | 'good' | 'easy';

export interface WordRow {
  id: number;
  lemma: string;
  surface_example: string;
  meaning_en: string;
  pos: string;
  level: number;
  first_seen_at: string;
  source_passage_id: number | null;
  source?: 'reading' | 'manual' | 'suggested' | null;
  example_ko?: string | null;
  example_en?: string | null;
  card?: SrsCardRow | null;
}

export interface WordSuggestion {
  lemma: string;
  pos: 'noun' | 'verb' | 'adjective' | 'adverb' | 'particle' | 'other';
  meaning_en: string;
  example_ko: string;
  example_en: string;
}

export interface WritingFeedback {
  corrected_ko: string;
  score: number;
  issues: {
    original: string;
    fix: string;
    type: string;
    explanation_en: string;
  }[];
  more_natural_ko: string;
  encouragement_en: string;
}

export interface SpeakingFeedback {
  transcript_ko: string;
  corrected_ko: string;
  score: number;
  issues: {
    original: string;
    fix: string;
    type: string;
    explanation_en: string;
  }[];
  more_natural_ko: string;
  pronunciation_notes: {
    word: string;
    note_en: string;
    confidence: 'low' | 'medium' | 'high';
  }[];
  fluency_note_en: string;
  encouragement_en: string;
}

export interface ListeningResult {
  score: number;
  perSentence: {
    target: string;
    typed: string;
    matched: number;
    segments: { type: 'equal' | 'delete' | 'insert'; text: string }[];
    percent: number;
  }[];
}

export interface LevelSuggestion {
  action: 'up' | 'down' | 'stay';
  suggested_level: number;
  overall: number;
}

export interface SessionCompleteResult {
  streak: number;
  suggestion: LevelSuggestion | null;
  scores: {
    read: number | null;
    write: number | null;
    listen: number | null;
    speak: number | null;
    vocab: number | null;
  };
}

export interface ProgressData {
  settings: Settings;
  sessions: {
    id: number;
    date: string;
    read_score: number | null;
    write_score: number | null;
    listen_score: number | null;
    speak_score: number | null;
    vocab_score: number | null;
    duration_s: number | null;
  }[];
  streakCalendar: string[];
  history: { change_date: string; from_level: number; to_level: number; reason: string }[];
}

export interface SessionHistoryRow {
  id: number;
  date: string;
  topic: string;
  title_ko: string | null;
  read_score: number | null;
  write_score: number | null;
  listen_score: number | null;
  speak_score: number | null;
  vocab_score: number | null;
  duration_s: number | null;
}

export interface ReadAnswerRow {
  index: number;
  q_ko: string;
  q_en: string;
  choices: string[];
  chosen_index: number | null;
  answer_index: number;
  correct: boolean;
  explanation_en: string;
}

export interface WritingEntryRow {
  id: number;
  prompt: { ko: string; en: string; target_grammar?: string; level?: number };
  user_text: string;
  feedback: WritingFeedback | null;
}

export interface DictationEntryRow {
  id: number;
  sentence_index: number;
  target_ko: string;
  typed_text: string;
  score: number;
  percent: number;
  segments: { type: 'equal' | 'delete' | 'insert'; text: string }[];
}

export interface SpeakingEntryRow {
  id: number;
  mode: 'read_aloud' | 'free_speech';
  target: string | null;
  transcript: string | null;
  score: number | null;
  percent: number | null;
  segments: { type: 'equal' | 'delete' | 'insert'; text: string }[] | null;
  feedback: SpeakingFeedback | null;
}

export interface SessionDetail {
  session: {
    id: number;
    date: string;
    status: string;
    current_step: string;
    read_score: number | null;
    write_score: number | null;
    listen_score: number | null;
    speak_score: number | null;
    vocab_score: number | null;
    duration_s: number | null;
  };
  pack: ContentPack;
  read: ReadAnswerRow[];
  writing: WritingEntryRow[];
  dictation: DictationEntryRow[];
  speaking: SpeakingEntryRow[];
}

export interface LlmStatus {
  enabled: boolean;
  provider: string;
  model: string;
  callsToday: number;
  cap: number;
  lastError: string | null;
}