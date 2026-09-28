import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import en from '../../config/copy/en.json';
import { ApiError } from './api';

/**
 * UI copy, so the interface can be read in the reader's own language.
 *
 * Three decisions worth knowing about:
 *
 * 1. **The keys are typed from `config/copy/en.json`, imported into the
 *    bundle.** English is the reference locale: `CopyKey` is the union of its
 *    leaf paths, so `t('nav.hom')` is a compile error rather than a blank
 *    label in production. The server has a matching test that fails when the
 *    locales drift apart, so the runtime value for any valid key exists.
 *
 * 2. **English is bundled as the fallback**, which is why the first paint is
 *    never a screenful of raw key names. `/api/meta` is unauthenticated and
 *    returns the server's chosen locale; when it lands, the tree is swapped.
 *
 * 3. **No provider is required to render.** The context default is the
 *    bundled English, so a component under test does not have to stand up a
 *    provider, and a missing provider degrades to readable English instead of
 *    crashing a screen.
 *
 * The copy tree is flat at the leaves but nested in the JSON, because a
 * translator editing `config/copy/ko.json` should find `session.writeOwn`
 * grouped with its neighbours rather than in one alphabetical list.
 */
type CopyTree = typeof en;

/** Dotted leaf paths of a nested string tree, e.g. `session.writeOwn`. */
type Paths<T> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${Paths<T[K]>}`;
}[keyof T & string];

export type CopyKey = Paths<CopyTree>;
export type CopyVars = Record<string, string | number>;
export type TFn = (key: CopyKey, vars?: CopyVars) => string;

type Tree = { [k: string]: string | Tree };

/** Walks a dotted key. Returns undefined rather than throwing on a miss. */
function lookup(tree: Tree, key: string): string | undefined {
  let node: string | Tree | undefined = tree;
  for (const part of key.split('.')) {
    if (node === undefined || typeof node === 'string') return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
}

/** Replaces `{name}` with the caller's value; leaves unknown names alone. */
export function interpolate(template: string, vars?: CopyVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

const warned = new Set<string>();

function makeT(tree: Tree): TFn {
  return (key, vars) => {
    const found = lookup(tree, key);
    if (found === undefined) {
      // A key that typechecks but is absent at runtime means the server is
      // serving a different (older) copy set than this bundle. Say so once per
      // key rather than rendering a blank label, and keep the key visible so
      // the gap is obvious instead of silent.
      if (!warned.has(key)) {
        warned.add(key);
        console.warn(`[copy] missing key ${key}`);
      }
      return key;
    }
    return interpolate(found, vars);
  };
}

export interface CopyValue {
  t: TFn;
  /**
   * Turns a server `ApiError` into a sentence in the interface language.
   *
   * Falls back in three steps: the localized string for the code, then the
   * server's own English message, then a generic localized failure. The middle
   * step matters most — it is what a code this bundle has never heard of (an
   * older client, a newer server) degrades to, so the user sees something
   * actionable instead of a bare status number.
   */
  serverError: (err: unknown) => string;
  /** The locale the copy is currently in, e.g. `en`. */
  uiLang: string;
  appName: string;
  appTagline: string;
}

/**
 * Server error code -> copy key, mirroring `ERROR_CODES` in
 * `server/src/errors.ts`. `copy.test.tsx` asserts the two stay in step.
 *
 * A `Record` keyed by `ServerErrorCode` rather than a lookup into the copy
 * tree, so a code without a translation is a compile error rather than a
 * silently missing sentence.
 */
export type ServerErrorCode =
  | 'invalid_password'
  | 'invalid_credentials'
  | 'unauthorized'
  | 'not_found'
  | 'language_not_supported'
  | 'enrollment_exists'
  | 'validation_failed'
  | 'unknown_voice'
  | 'sentence_index_required'
  | 'empty_recording'
  | 'transcription_failed'
  | 'llm_not_configured'
  | 'daily_cap_reached'
  | 'no_completed_session'
  | 'reset_confirm_required'
  | 'text_required'
  | 'text_too_long'
  | 'recording_too_large'
  | 'tts_unavailable';

export const SERVER_ERROR_KEYS: Record<ServerErrorCode, CopyKey> = {
  invalid_password: 'error.invalidPassword',
  // A wrong username and a wrong password get the same sentence, so the login
  // form cannot be used to find out which accounts exist.
  invalid_credentials: 'error.invalidCredentials',
  unauthorized: 'error.unauthorized',
  not_found: 'error.notFound',
  language_not_supported: 'error.languageNotSupported',
  enrollment_exists: 'error.enrollmentExists',
  validation_failed: 'error.validationFailed',
  unknown_voice: 'error.unknownVoice',
  sentence_index_required: 'error.sentenceIndexRequired',
  empty_recording: 'error.emptyRecording',
  transcription_failed: 'error.transcriptionFailed',
  llm_not_configured: 'error.llmNotConfigured',
  daily_cap_reached: 'error.dailyCapReached',
  no_completed_session: 'error.noCompletedSession',
  reset_confirm_required: 'error.resetConfirmRequired',
  text_required: 'error.textRequired',
  text_too_long: 'error.textTooLong',
  recording_too_large: 'error.recordingTooLarge',
  tts_unavailable: 'error.ttsUnavailable',
};

function isServerErrorCode(value: unknown): value is ServerErrorCode {
  return typeof value === 'string' && Object.hasOwn(SERVER_ERROR_KEYS, value);
}

function makeServerError(t: TFn): (err: unknown) => string {
  return (err) => {
    const code = err instanceof ApiError ? err.code : undefined;
    if (isServerErrorCode(code)) return t(SERVER_ERROR_KEYS[code]);
    // Unknown or absent code: the server's message is English but specific,
    // which beats a vague localized string. It is a fallback, not the norm.
    if (err instanceof ApiError && err.message && !/^HTTP \d+$/.test(err.message)) return err.message;
    return t('common.error');
  };
}

const CopyContext = createContext<CopyValue>({
  t: makeT(en as Tree),
  serverError: makeServerError(makeT(en as Tree)),
  uiLang: 'en',
  appName: en.appName,
  appTagline: en.appTagline,
});

export function useCopy(): CopyValue {
  return useContext(CopyContext);
}

interface Meta {
  defaultUiLang: string;
  appName: string;
  appTagline: string;
  copy: Tree;
}

/**
 * Which language the interface is in.
 *
 * Signed out, that is the deployment default from `/api/meta`. Signed in, it is
 * the active enrollment's `uiLang` and its copy comes from `/api/account`
 * instead — the same tree, but chosen per person rather than per box. Passing
 * both in is what lets one provider serve the login screen and the app without
 * either of them knowing which state it is in.
 */
export interface CopyProviderProps {
  children: ReactNode;
  /** The active enrollment's copy. Omitted means "signed out": use the default. */
  copy?: Tree;
  /** The active enrollment's interface language, alongside `copy`. */
  uiLang?: string;
  /** App name for the current language, from the account payload. */
  appName?: string;
  appTagline?: string;
}

export function CopyProvider({ children, copy, uiLang, appName, appTagline }: CopyProviderProps) {
  const [meta, setMeta] = useState<Meta | null>(null);

  // Only when signed out. Signed in, the copy is already in hand and a second
  // fetch would be both redundant and a chance for the two to disagree.
  const needsDefault = copy === undefined;
  useEffect(() => {
    if (!needsDefault) return;
    let live = true;
    void (async () => {
      try {
        const res = await fetch('/api/meta', { credentials: 'same-origin' });
        if (!res.ok) return;
        const body = (await res.json()) as Meta;
        if (live && body?.copy) setMeta(body);
      } catch {
        // Offline or the server is restarting. The bundled English stands in;
        // there is nothing useful to show the user about a failed copy fetch.
      }
    })();
    return () => {
      live = false;
    };
  }, [needsDefault]);

  const value = useMemo<CopyValue>(() => {
    const tree = copy ?? (needsDefault && meta ? meta.copy : undefined) ?? (en as Tree);
    const t = makeT(tree);
    return {
      t,
      serverError: makeServerError(t),
      uiLang: uiLang ?? (needsDefault && meta ? meta.defaultUiLang : 'en'),
      appName: appName ?? (needsDefault && meta ? meta.appName : en.appName),
      appTagline: appTagline ?? (needsDefault && meta ? meta.appTagline : en.appTagline),
    };
  }, [copy, uiLang, appName, appTagline, meta, needsDefault]);

  return <CopyContext.Provider value={value}>{children}</CopyContext.Provider>;
}
