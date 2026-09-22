import { lazy, Suspense, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api } from './api';
import { TabBar } from './components/TabBar';
import { Home } from './screens/Home';

const Session = lazy(() => import('./screens/Session').then((m) => ({ default: m.Session })));
const Practice = lazy(() => import('./screens/Practice').then((m) => ({ default: m.Practice })));
const Words = lazy(() => import('./screens/Words').then((m) => ({ default: m.Words })));
const Progress = lazy(() => import('./screens/Progress').then((m) => ({ default: m.Progress })));
const SettingsScreen = lazy(() => import('./screens/Settings').then((m) => ({ default: m.SettingsScreen })));

type AuthState = 'checking' | 'logged-in' | 'logged-out';

export function App() {
  const [auth, setAuth] = useState<AuthState>('checking');
  const nav = useNavigate();
  const loc = useLocation();

  useEffect(() => {
    void (async () => {
      try {
        await api.me();
        setAuth('logged-in');
      } catch {
        setAuth('logged-out');
      }
    })();
  }, []);

  useEffect(() => {
    const onUnauthorized = () => {
      setAuth('logged-out');
      if (loc.pathname !== '/login') nav('/login', { replace: true });
    };
    window.addEventListener('kt:unauthorized', onUnauthorized);
    return () => window.removeEventListener('kt:unauthorized', onUnauthorized);
  }, [nav, loc.pathname]);

  const inSession = loc.pathname.startsWith('/session');
  const showTabs = auth === 'logged-in' && !inSession;

  return (
    <div className="app">
      {auth === 'checking' ? (
        <div className="spinner" />
      ) : auth === 'logged-out' ? (
        <Routes>
          <Route path="/login" element={<LoginGate onOk={() => setAuth('logged-in')} />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      ) : (
        <>
          <main className="content">
            <Suspense fallback={<div className="spinner" />}>
              <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/session/:id" element={<Session />} />
                <Route path="/practice" element={<Practice />} />
                <Route path="/words" element={<Words />} />
                <Route path="/progress" element={<Progress />} />
                <Route path="/settings" element={<SettingsScreen />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Suspense>
          </main>
          {showTabs && <TabBar />}
        </>
      )}
    </div>
  );
}

function LoginGate({ onOk }: { onOk: () => void }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const nav = useNavigate();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    try {
      await api.login(pw);
      onOk();
      nav('/', { replace: true });
    } catch (er) {
      setErr(er instanceof Error ? er.message : 'login failed');
    }
  };

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit}>
        <h2>한국어</h2>
        <p className="muted small">Korean Daily Trainer</p>
        <input
          type="password"
          placeholder="Trainer password"
          autoFocus
          value={pw}
          onChange={(e) => setPw(e.target.value)}
        />
        {err && <div className="error-banner">{err}</div>}
        <button className="primary" type="submit">
          Unlock
        </button>
      </form>
    </div>
  );
}