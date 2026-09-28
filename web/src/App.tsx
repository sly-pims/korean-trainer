import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError, type AccountPayload } from './api';
import { AccountProvider } from './account';
import { TabBar } from './components/TabBar';
import { Home } from './screens/Home';
import { CopyProvider, useCopy } from './copy';

const Session = lazy(() => import('./screens/Session').then((m) => ({ default: m.Session })));
const Practice = lazy(() => import('./screens/Practice').then((m) => ({ default: m.Practice })));
const Words = lazy(() => import('./screens/Words').then((m) => ({ default: m.Words })));
const Progress = lazy(() => import('./screens/Progress').then((m) => ({ default: m.Progress })));
const SettingsScreen = lazy(() => import('./screens/Settings').then((m) => ({ default: m.SettingsScreen })));
const History = lazy(() => import('./screens/History').then((m) => ({ default: m.History })));
const HistoryReplay = lazy(() => import('./screens/History').then((m) => ({ default: m.HistoryReplay })));

type AuthState = 'checking' | 'logged-in' | 'logged-out';

export function App() {
  const [auth, setAuth] = useState<AuthState>('checking');
  /**
   * The payload login handed back, so the first screen after signing in does
   * not have to wait for a second round trip to learn which language it is in.
   */
  const [fresh, setFresh] = useState<AccountPayload | null>(null);
  const nav = useNavigate();
  const loc = useLocation();

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        await api.me();
        if (live) setAuth('logged-in');
      } catch {
        if (live) setAuth('logged-out');
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const logout = useCallback(() => {
    setFresh(null);
    setAuth('logged-out');
    nav('/login', { replace: true });
  }, [nav]);

  useEffect(() => {
    // `api` raises this on any 401, including one caused by an enrollment that
    // has been deleted underneath a still-signed-in session.
    const onUnauthorized = () => logout();
    window.addEventListener('kt:unauthorized', onUnauthorized);
    return () => window.removeEventListener('kt:unauthorized', onUnauthorized);
  }, [logout]);

  const inSession = loc.pathname.startsWith('/session');
  const showTabs = auth === 'logged-in' && !inSession;

  return (
    <div className="app">
      {auth === 'checking' ? (
        <div className="spinner" />
      ) : auth === 'logged-out' ? (
        // Signed out, the interface language is the deployment default, which is
        // all `/api/meta` knows. A French learner gets French here and French
        // after signing in, but the two are separate decisions.
        <CopyProvider>
          <Routes>
            <Route
              path="/login"
              element={<LoginGate onOk={(account) => { setFresh(account); setAuth('logged-in'); }} />}
            />
            <Route path="*" element={<Navigate to="/login" replace />} />
          </Routes>
        </CopyProvider>
      ) : (
        <AccountProvider initial={fresh} onUnauthorized={logout}>
          <main className="content">
            <Suspense fallback={<div className="spinner" />}>
              <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/session/:id" element={<Session />} />
                <Route path="/practice" element={<Practice />} />
                <Route path="/words" element={<Words />} />
                <Route path="/progress" element={<Progress />} />
                <Route path="/history" element={<History />} />
                <Route path="/history/:id" element={<HistoryReplay />} />
                <Route path="/settings" element={<SettingsScreen onSignedOut={logout} />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Suspense>
          </main>
          {showTabs && <TabBar />}
        </AccountProvider>
      )}
    </div>
  );
}

function LoginGate({ onOk }: { onOk: (account: AccountPayload) => void }) {
  const { serverError, t, appName, appTagline } = useCopy();
  const [username, setUsername] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const res = await api.login(username.trim(), pw);
      onOk(res.account);
      nav('/', { replace: true });
    } catch (er) {
      // `invalid_credentials` is one sentence for both a wrong username and a
      // wrong password, and it is the same sentence for both accounts, so the
      // form cannot be used to find out who has an account here.
      setErr(serverError(er instanceof ApiError ? er : new ApiError(0, String(er))));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit}>
        {/* The app name from the server, not a hardcoded 한국어: this screen
            used to greet a French learner with the Korean language's own name. */}
        <h2>{appName}</h2>
        <p className="muted small">{appTagline}</p>
        <input
          type="text"
          placeholder={t('login.usernamePlaceholder')}
          aria-label={t('login.username')}
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <input
          type="password"
          placeholder={t('login.passwordPlaceholder')}
          aria-label={t('login.password')}
          autoComplete="current-password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
        />
        {err && <div className="error-banner">{err}</div>}
        <button className="primary" type="submit" disabled={busy || !username || !pw}>
          {busy ? t('login.signingIn') : t('login.submit')}
        </button>
      </form>
    </div>
  );
}
