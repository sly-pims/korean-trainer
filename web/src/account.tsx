import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError, type AccountPayload, type EnrollmentSummary, type LanguageDescriptor } from './api';
import { CopyProvider } from './copy';

/**
 * The signed-in account: who, which languages, and which one is active.
 *
 * This owns exactly one piece of state — the `/api/account` payload — and every
 * screen reads its language from here rather than from a module-level constant.
 * The alternative, a `useLang` context seeded once at startup, is what this
 * replaces: it went stale the moment somebody switched languages, so the copy
 * kept saying one thing while the content said another.
 *
 * The payload is refetched after any change that can alter it (switching
 * language, adding one, saving settings), because the server is the only place
 * that knows which enrollment the cookie now points at. Guessing on the client
 * is how the two drift apart.
 */

interface AccountValue {
  account: AccountPayload;
  /** The active enrollment, resolved from the payload. Never null once loaded. */
  active: EnrollmentSummary;
  /** Switch languages: re-signs the cookie server-side, then reloads the account. */
  switchTo: (enrollmentId: number) => Promise<void>;
  /** Add a language. Does not switch — call `switchTo` for that. */
  addLanguage: (input: { target_lang: string; native_lang?: string; ui_lang?: string }) => Promise<AddResult>;
  /** Drop a locally cached settings patch after a write, so the next read is fresh. */
  refresh: () => Promise<void>;
  busy: boolean;
  /**
   * The last failure, as an `ApiError` and not a string.
   *
   * Deliberately untranslated: this provider renders the copy provider, so it
   * cannot read `useCopy()` itself. Handing the error to the consumer lets
   * `AccountPanel` run it through `serverError()` like every other screen,
   * instead of showing a French learner an English sentence about their own
   * account.
   */
  error: ApiError | null;
}

const AccountContext = createContext<AccountValue | null>(null);

/**
 * Why an "add a language" tap did not add one.
 *
 * Worth distinguishing rather than collapsing into a boolean: the server is
 * idempotent, so tapping twice is a *success* the second time in the sense
 * that the account now has that language — telling the user "that failed"
 * would be wrong, and so would telling them it was added.
 */
export type AddResult = 'added' | 'already' | 'failed';

export function useAccount(): AccountValue {
  const value = useContext(AccountContext);
  if (!value) throw new Error('useAccount used outside AccountProvider');
  return value;
}

/** The active enrollment's language descriptor, for screens that need it. */
export function useActiveLang(): LanguageDescriptor {
  return useAccount().active.lang;
}

export interface AccountProviderProps {
  children: ReactNode;
  /** Called when the session turns out to be gone, so the router can log out. */
  onUnauthorized: () => void;
  /**
   * The payload from login, when there is one.
   *
   * Skips the `/api/account` round trip right after signing in — the login
   * response already carries the same payload, and the learner is waiting on a
   * spinner.
   */
  initial?: AccountPayload | null;
}

export function AccountProvider({ children, onUnauthorized, initial = null }: AccountProviderProps) {
  const [account, setAccount] = useState<AccountPayload | null>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  /** Any thrown thing becomes an `ApiError`, so consumers have one shape to read. */
  const toApiError = (err: unknown) =>
    err instanceof ApiError ? err : new ApiError(0, err instanceof Error ? err.message : String(err));

  const load = useCallback(async () => {
    try {
      setAccount(await api.account());
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onUnauthorized();
        return;
      }
      setError(toApiError(err));
    }
  }, [onUnauthorized]);

  useEffect(() => {
    if (!account) void load();
  }, [account, load]);

  const switchTo = useCallback(
    async (enrollmentId: number) => {
      setError(null);
      setBusy(true);
      try {
        // The response carries the whole new payload, so there is no window in
        // which the copy is the old language's and the settings the new one's.
        const res = await api.activateEnrollment(enrollmentId);
        setAccount(res.account);
      } catch (err) {
        setError(toApiError(err));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const addLanguage = useCallback(
    async (input: { target_lang: string; native_lang?: string; ui_lang?: string }): Promise<AddResult> => {
      setError(null);
      setBusy(true);
      try {
        const res = await api.createEnrollment(input);
        // The account in this response still describes the *old* active
        // enrollment, so replacing state with it is correct: adding a language
        // must not look like switching to it.
        setAccount(res.account);
        return res.created ? 'added' : 'already';
      } catch (err) {
        setError(toApiError(err));
        return 'failed';
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const value = useMemo<AccountValue | null>(() => {
    if (!account) return null;
    const active = account.enrollments.find((e) => e.id === account.activeEnrollmentId);
    if (!active) return null;
    return { account, active, switchTo, addLanguage, refresh: load, busy, error };
  }, [account, switchTo, addLanguage, load, busy, error]);

  if (!value) {
    return (
      <div className="spinner" role="status" aria-live="polite">
        {/* No copy provider yet, so this one message cannot be translated. It is
            only reachable when the account itself failed to load, and the
            session is about to be unusable either way. */}
        {error ? <div className="error-banner">{error.message}</div> : null}
      </div>
    );
  }

  return (
    <AccountContext.Provider value={value}>
      {/*
        Inside, not around: the copy is per enrollment, so it cannot be read
        until the account has loaded. Nesting it here means every screen below
        gets the right language without any of them knowing it is per person.
      */}
      <CopyProvider
        copy={value.account.copy as never}
        uiLang={value.active.uiLang}
        appName={str(value.account.copy.appName)}
        appTagline={str(value.account.copy.appTagline)}
      >
        {children}
      </CopyProvider>
    </AccountContext.Provider>
  );
}

/** Undefined, not `''`, so CopyProvider can still fall back to the bundled name. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}
