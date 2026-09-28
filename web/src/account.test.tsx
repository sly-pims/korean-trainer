import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AccountProvider, useAccount } from './account';
import { App } from './App';
import { AccountPanel } from './components/AccountPanel';
import { SettingsScreen } from './screens/Settings';
import { Home } from './screens/Home';
import { useCopy } from './copy';
import type { AccountPayload, EnrollmentSummary, LanguageDescriptor as ShortLang } from './api';
import type { LanguageDescriptor as LanguageProfile } from './types';
import en from '../../config/copy/en.json';

/**
 * The account layer, tested where the bugs actually live.
 *
 * The invariants worth defending, in order of how expensive they were to get
 * wrong: the copy always belongs to the enrollment the cookie points at, adding
 * a language never moves you into it, and a 401 anywhere logs you out instead of
 * leaving a half-signed-in screen.
 */

// ---------- fixtures ----------

/** The short descriptor the enrollment list carries, as `describeLanguage` sends it. */
const ko: ShortLang = { code: 'ko', name: 'Korean', endonym: '한국어', htmlLang: 'ko' };
const fr: ShortLang = { code: 'fr', name: 'French', endonym: 'français', htmlLang: 'fr' };

/** The full profile, as `languageDescriptor(profile)` sends it for the active one. */
const koProfile: LanguageProfile = {
  ...ko,
  lexiconExample: '사람',
  locale: 'ko-KR',
  defaultVoice: 'ko-KR-SunHiNeural',
  voices: ['ko-KR-SunHiNeural', 'ko-KR-InjongNeural'],
  levelScaleName: 'TOPIK',
  levels: { '1': { name: 'TOPIK 1', note: 'Beginner' }, '2': { name: 'TOPIK 2', note: 'Elementary' } },
};
const frProfile: LanguageProfile = {
  ...fr,
  lexiconExample: 'maison',
  locale: 'fr-FR',
  defaultVoice: 'fr-FR-DeniseNeural',
  voices: ['fr-FR-DeniseNeural'],
  levelScaleName: 'CEFR',
  levels: { '1': { name: 'A1', note: 'Beginner' }, '2': { name: 'A2', note: 'Elementary' } },
};

function enrollment(over: Partial<EnrollmentSummary> & Pick<EnrollmentSummary, 'id' | 'lang'>): EnrollmentSummary {
  return {
    targetLang: over.lang.code,
    nativeLang: 'en',
    uiLang: 'en',
    displayName: over.lang.endonym,
    ...over,
  } as EnrollmentSummary;
}

/** Two different copy trees, so "the copy followed the switch" is observable. */
function copyFor(code: 'ko' | 'fr') {
  return {
    ...(en as Record<string, unknown>),
    appName: code === 'ko' ? '한국어 트레이너' : 'Traineur français',
    settings: {
      ...(en as unknown as { settings: Record<string, string> }).settings,
      title: code === 'ko' ? '설정' : 'Réglages',
    },
  };
}

function payload(over: { active?: 'ko' | 'fr'; added?: 'ko' | 'fr'; native?: 'en' | 'ko' | 'fr' } = {}): AccountPayload {
  const active = over.active ?? 'ko';
  const added = over.added;
  const enrollments = [
    enrollment({ id: 1, lang: ko, nativeLang: over.native ?? 'en' }),
    ...(added ? [enrollment({ id: 2, lang: added === 'ko' ? ko : fr, nativeLang: over.native ?? 'en' })] : []),
  ];
  const activeSummary = enrollments.find((e) => e.lang.code === active) ?? enrollments[0]!;
  const profile = activeSummary.lang.code === 'ko' ? koProfile : frProfile;
  return {
    user: { id: 1, username: 'owner', display_name: 'Owner' },
    activeEnrollmentId: activeSummary.id,
    enrollments,
    availableTargetLangs: added ? [] : [fr.code],
    targetLangs: [ko, fr],
    uiLangs: ['en', 'ko', 'fr'],
    lang: profile,
    copy: copyFor(activeSummary.lang.code === 'ko' ? 'ko' : 'fr'),
    settings: {
      level: 1,
      tts_rate: 1,
      tts_voice: profile.defaultVoice,
      show_romanization: true,
      keep_recordings_days: 14,
      streak: 0,
      last_session_date: null,
      timezone: 'Asia/Seoul',
      lang: profile,
    },
  };
}

// ---------- fetch stub ----------

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

interface Recorded {
  path: string;
  method: string;
  body: unknown;
}

let recorded: Recorded[] = [];
/** Returns the body for a path, or `undefined` to let the default 404 stand. */
let routes: (path: string, method: string) => unknown | undefined;

beforeEach(() => {
  recorded = [];
  routes = () => undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? 'GET';
      let body: unknown = null;
      if (typeof init?.body === 'string') {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      recorded.push({ path, method, body });
      const answer = routes(path, method);
      if (answer && typeof answer === 'object' && 'status' in (answer as object)) {
        return jsonResponse(answer, (answer as { status: number }).status);
      }
      if (answer !== undefined) return jsonResponse(answer);
      return jsonResponse({ code: 'not_found', error: 'not found' }, 404);
    }),
  );
});

const callsTo = (path: string) => recorded.filter((c) => c.path === path);

// ---------- probes ----------

/** Renders the app name and one settings label, i.e. what the copy says. */
function CopyProbe() {
  const { appName, t } = useCopy();
  return (
    <div>
      <span data-testid="app-name">{appName}</span>
      <span data-testid="settings-title">{t('settings.title')}</span>
    </div>
  );
}

function ActiveProbe() {
  const { active } = useAccount();
  return <span data-testid="active">{active.lang.code}</span>;
}

function renderPanel(initial: AccountPayload) {
  return render(
    <MemoryRouter>
      <AccountProvider initial={initial} onUnauthorized={() => {}}>
        <AccountPanel onSignedOut={() => {}} />
        <CopyProbe />
        <ActiveProbe />
      </AccountProvider>
    </MemoryRouter>,
  );
}

// ---------- tests ----------

describe('the account panel', () => {
  it('lists every language the account has and marks the active one', async () => {
    renderPanel(payload({ active: 'ko', added: 'fr' }));
    const list = screen.getByRole('list');
    expect(within(list).getByText('한국어')).toBeTruthy();
    expect(within(list).getByText('français')).toBeTruthy();
    // One bottom switch control replaces per-row buttons.
    expect(screen.getAllByRole('button', { name: /français/ })).toHaveLength(1);
    expect(screen.getByLabelText(/Your languages/)).toBeTruthy();
    expect(screen.getByText(/Current/)).toBeTruthy();
  });

  it('shows the copy of the enrollment that is actually active', () => {
    // Not the deployment's, and not Korean because that is the first in the list:
    // the French learner's screen must not greet them in Korean.
    renderPanel(payload({ active: 'fr', added: 'fr' }));
    expect(screen.getByTestId('app-name').textContent).toBe('Traineur français');
    expect(screen.getByTestId('settings-title').textContent).toBe('Réglages');
    expect(screen.getByTestId('active').textContent).toBe('fr');
  });

  it('switching language reloads the account and takes the copy with it', async () => {
    // The session cookie is re-signed server-side, so this is not a local
    // toggle: the whole tree below has to change language at once.
    routes = (path) => {
      if (path === '/api/enrollments/2/activate') {
        return { ok: true, account: payload({ active: 'fr', added: 'fr' }) };
      }
      return undefined;
    };
    renderPanel(payload({ active: 'ko', added: 'fr' }));

    fireEvent.click(screen.getByRole('button', { name: /français/ }));

    await waitFor(() => expect(screen.getByTestId('active').textContent).toBe('fr'));
    expect(screen.getByTestId('app-name').textContent).toBe('Traineur français');
    expect(callsTo('/api/enrollments/2/activate')).toHaveLength(1);
  });

  it('adding a language does not switch to it', async () => {
    // Tapping "add" while browsing must not drop somebody into a level-1 course
    // in the middle of their streak, and the server's response still describes
    // the old active enrollment, so the client must not "optimistically" adopt
    // the new one.
    routes = (path) => {
      if (path === '/api/enrollments') {
        return { status: 201, created: true, enrollment: enrollment({ id: 2, lang: fr }), account: payload({ active: 'ko' }) };
      }
      return undefined;
    };
    renderPanel(payload({ active: 'ko', native: 'ko' }));

    fireEvent.change(screen.getByLabelText(/Add a language/), { target: { value: 'fr' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(screen.getByText(/added/i)).toBeTruthy());
    expect(screen.getByTestId('active').textContent).toBe('ko');
    expect(callsTo('/api/enrollments')[0]?.body).toMatchObject({ target_lang: 'fr', native_lang: 'ko' });
  });

  it('lets the learner change courses from Home and reloads that course lesson', async () => {
    let current = payload({ active: 'ko', added: 'fr' });
    let homeCalls = 0;
    routes = (path) => {
      if (path === '/api/home') {
        homeCalls++;
        return { settings: current.settings, todaySession: null, tz: 'Asia/Seoul', tomorrowPackReady: false };
      }
      if (path === '/api/enrollments/2/activate') {
        current = payload({ active: 'fr', added: 'fr' });
        return { ok: true, account: current };
      }
      return undefined;
    };

    render(
      <MemoryRouter>
        <AccountProvider initial={current} onUnauthorized={() => {}}>
          <Home />
        </AccountProvider>
      </MemoryRouter>,
    );

    const picker = await screen.findByLabelText(/Learning/i) as HTMLSelectElement;
    expect(picker.value).toBe('1');
    fireEvent.change(picker, { target: { value: '2' } });

    await waitFor(() => expect(picker.value).toBe('2'));
    await waitFor(() => expect(homeCalls).toBe(2));
    expect(callsTo('/api/enrollments/2/activate')).toHaveLength(1);
  });

  it('says the language was already there when the server declines to add it again', async () => {
    // The server is idempotent, so a double tap is not a failure and must not
    // be reported as one.
    routes = (path) => {
      if (path === '/api/enrollments') {
        return { status: 200, created: false, enrollment: enrollment({ id: 2, lang: fr }), account: payload({ active: 'ko' }) };
      }
      return undefined;
    };
    renderPanel(payload({ active: 'ko' }));

    fireEvent.change(screen.getByLabelText(/Add a language/), { target: { value: 'fr' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(screen.getByText(/already added/i)).toBeTruthy());
    expect(screen.getByTestId('active').textContent).toBe('ko');
  });

  it('reports a failed add as an error rather than as an addition', async () => {
    routes = (path) => {
      if (path === '/api/enrollments') {
        return { status: 400, code: 'language_not_supported', error: 'raw server text' };
      }
      return undefined;
    };
    renderPanel(payload({ active: 'ko' }));

    fireEvent.change(screen.getByLabelText(/Add a language/), { target: { value: 'fr' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    // The translated message, and never the server's English sentence.
    await waitFor(() =>
      expect(screen.getByText((en as unknown as { error: Record<string, string> }).error.languageNotSupported))
        .toBeTruthy(),
    );
    expect(screen.queryByText('raw server text')).toBeNull();
    expect(screen.getByTestId('active').textContent).toBe('ko');
  });

  it('signing out clears the cookie and tells the app', async () => {
    const signedOut = vi.fn();
    routes = (path) => (path === '/api/logout' ? { ok: true } : undefined);
    render(
      <MemoryRouter>
        <AccountProvider initial={payload()} onUnauthorized={() => {}}>
          <AccountPanel onSignedOut={signedOut} />
        </AccountProvider>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /sign out/i }));

    await waitFor(() => expect(signedOut).toHaveBeenCalled());
    expect(callsTo('/api/logout')).toHaveLength(1);
  });

  it('offers no language to add when the account has every language offered', async () => {
    renderPanel(payload({ active: 'ko', added: 'fr' }));
    expect(screen.queryByLabelText(/Add a language/)).toBeNull();
    expect(screen.getByText(/every language this app offers/i)).toBeTruthy();
  });
});

describe('the account provider', () => {
  it('loads the account itself when login did not supply one', async () => {
    routes = (path) => (path === '/api/account' ? payload({ active: 'fr', added: 'fr' }) : undefined);
    render(
      <MemoryRouter>
        <AccountProvider onUnauthorized={() => {}}>
          <ActiveProbe />
        </AccountProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('active').textContent).toBe('fr'));
    expect(callsTo('/api/account')).toHaveLength(1);
  });

  it('does not re-fetch an account it was handed at login', async () => {
    // The login response already carries the payload and the learner is waiting
    // on a spinner; a second round trip would only make the wait longer.
    render(
      <MemoryRouter>
        <AccountProvider initial={payload()} onUnauthorized={() => {}}>
          <ActiveProbe />
        </AccountProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('active').textContent).toBe('ko'));
    expect(callsTo('/api/account')).toHaveLength(0);
  });

  it('signs the learner out when the session turns out to be gone', async () => {
    const onUnauthorized = vi.fn();
    routes = (path) =>
      path === '/api/account' ? { status: 401, code: 'no_session', error: 'no session' } : undefined;
    render(
      <MemoryRouter>
        <AccountProvider onUnauthorized={onUnauthorized}>
          <ActiveProbe />
        </AccountProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled());
  });
});

describe('signing in', () => {
  const renderApp = (at = '/login') =>
    render(
      <MemoryRouter initialEntries={[at]}>
        <App />
      </MemoryRouter>,
    );

  it('asks for a username as well as a password', async () => {
    routes = (path) => (path === '/api/me' ? { status: 401, error: 'no session' } : undefined);
    renderApp();
    // A single shared password cannot tell two accounts apart, so the form has
    // to ask who is signing in.
    expect(await screen.findByLabelText(/username/i)).toBeTruthy();
    expect(screen.getByLabelText(/password/i)).toBeTruthy();
  });

  it('signs in with the username and password that were typed', async () => {
    routes = (path) => {
      if (path === '/api/me') return { status: 401, error: 'no session' };
      if (path === '/api/login') return { ok: true, account: payload({ active: 'ko' }) };
      return undefined;
    };
    renderApp();

    fireEvent.change(await screen.findByLabelText(/username/i), { target: { value: 'owner' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'hunter2' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(callsTo('/api/login')).toHaveLength(1));
    expect(callsTo('/api/login')[0]?.body).toEqual({ username: 'owner', password: 'hunter2' });
    await waitFor(() => expect(screen.queryByLabelText(/username/i)).toBeNull());
  });

  it('trims the username before sending it', async () => {
    routes = (path) => {
      if (path === '/api/me') return { status: 401, error: 'no session' };
      if (path === '/api/login') return { ok: true, account: payload() };
      return undefined;
    };
    renderApp();
    fireEvent.change(await screen.findByLabelText(/username/i), { target: { value: '  owner  ' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'hunter2' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => expect(callsTo('/api/login')).toHaveLength(1));
    expect((callsTo('/api/login')[0]?.body as { username: string }).username).toBe('owner');
  });

  it('gives a wrong password the same message whatever the username was', async () => {
    // One sentence for both cases, so the form cannot be used to find out who
    // has an account here.
    routes = (path) => {
      if (path === '/api/me') return { status: 401, error: 'no session' };
      if (path === '/api/login') return { status: 401, code: 'invalid_credentials', error: 'raw server text' };
      return undefined;
    };
    renderApp();
    fireEvent.change(await screen.findByLabelText(/username/i), { target: { value: 'nobody' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    const banner = await screen.findByText(
      (en as unknown as { error: Record<string, string> }).error.invalidCredentials,
    );
    expect(banner.textContent).not.toMatch(/raw server text/);
    // Still on the form, still signed out.
    expect(screen.getByLabelText(/username/i)).toBeTruthy();
  });

  it('will not submit an empty form', async () => {
    routes = (path) => (path === '/api/me' ? { status: 401, error: 'no session' } : undefined);
    renderApp();
    const button = await screen.findByRole('button', { name: /Sign in/i });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('settings after a switch', () => {
  /**
   * The regression this guards: switching language from the account card sits
   * directly above the settings form on the same screen. Without refetching, the
   * form kept showing the previous language's level names and voices, and
   * pressing "save" then wrote those values into the enrollment the cookie now
   * pointed at — silently overwriting the other course's settings.
   */
  it('reloads the form for the newly active enrollment', async () => {
    let current = payload({ active: 'ko', added: 'fr' });
    routes = (path) => {
      if (path === '/api/account') return current;
      if (path === '/api/settings') {
        return { ...current.settings, level: current.lang.code === 'ko' ? 2 : 5 };
      }
      if (path === '/api/enrollments/2/activate') {
        current = payload({ active: 'fr', added: 'fr' });
        return { ok: true, account: current };
      }
      return undefined;
    };

    render(
      <MemoryRouter>
        <AccountProvider initial={payload({ active: 'ko', added: 'fr' })} onUnauthorized={() => {}}>
          {/* The account card is part of the settings screen, which is the point:
              the switch and the form it invalidates are on the same page. */}
          <SettingsScreen onSignedOut={() => {}} />
        </AccountProvider>
      </MemoryRouter>,
    );

    // Korean: the level select offers Korean level names, at the Korean level.
    await waitFor(() => expect((screen.getByLabelText(/Level/) as HTMLSelectElement).value).toBe('2'));
    expect(within(screen.getByLabelText(/Level/)).getByText('TOPIK 2')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /français/ }));

    // French: different level names, and the value from the *French* settings
    // row rather than the Korean one that was on screen a moment ago.
    await waitFor(() => expect((screen.getByLabelText(/Level/) as HTMLSelectElement).value).toBe('5'));
    expect(within(screen.getByLabelText(/Level/)).getByText('A2')).toBeTruthy();
    expect(screen.queryByText('TOPIK 2')).toBeNull();
  });
});
