import { useState } from 'react';
import { api } from '../api';
import { useAccount } from '../account';
import { useCopy } from '../copy';

/**
 * The account card: who is signed in, which languages they have, and the switch.
 *
 * Switching re-signs the session cookie on the server, so this is not a local
 * toggle — the whole tree below it changes language, and there is a moment
 * where the old copy is still on screen. That is deliberate: the swap happens
 * when the server has confirmed the new enrollment, so the copy and the content
 * can never be from different languages, even briefly.
 *
 * Adding a language deliberately does not switch. Somebody who taps "add" while
 * browsing is not asking to be moved into a level-1 French course in the middle
 * of their Korean streak, so the button says what it does and offers the switch
 * separately.
 */
export function AccountPanel({ onSignedOut }: { onSignedOut: () => void }) {
  const { account, active, switchTo, addLanguage, busy, error } = useAccount();
  const { t, serverError } = useCopy();
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);

  const available = account.targetLangs.filter((l) => account.availableTargetLangs.includes(l.code));
  const [pending, setPending] = useState<string>('');
  const [native, setNative] = useState<string>('');

  const add = async () => {
    if (!pending) return;
    setMsg(null);
    const lang = account.targetLangs.find((l) => l.code === pending);
    // `native_lang` is optional server-side and defaults to the deployment's
    // interface language; only send it when the picker actually chose one.
    const result = await addLanguage({ target_lang: pending, native_lang: native || undefined });
    setPending('');
    setNative('');
    if (result === 'added' && lang) {
      setMsg({ text: t('account.added', { language: lang.endonym }), error: false });
    } else if (result === 'already') {
      // The server is idempotent, so a double tap lands here. That is not a
      // failure and the language is in the list above.
      setMsg({ text: t('account.alreadyAdded'), error: false });
    }
  };

  const signOut = async () => {
    try {
      await api.logout();
    } catch {
      // The cookie is being cleared regardless; a failed request must not
      // strand somebody in an app they cannot use.
    }
    onSignedOut();
  };

  return (
    <div className="card">
      <h3>{t('account.title')}</h3>
      <p className="small muted">{t('account.signedInAs', { username: account.user.display_name || account.user.username })}</p>
      {error && <div className="error-banner">{serverError(error)}</div>}

      <label>{t('account.languages')}</label>
      <ul className="lang-list">
        {account.enrollments.map((e) => {
          const isActive = e.id === account.activeEnrollmentId;
          return (
            <li key={e.id} className="lang-row">
              <span>
                <strong>{e.lang.endonym}</strong>{' '}
                <span className="small muted">{e.lang.name}</span>
                {isActive && <span className="badge"> {t('account.current')}</span>}
              </span>
              {!isActive && (
                <button disabled={busy} onClick={() => void switchTo(e.id)}>
                  {busy ? t('account.switching') : t('account.switchTo', { language: e.lang.endonym })}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {/* `active` is what the rest of the app is actually using; surfacing it
          keeps the list and the content obviously in step. */}
      <p className="small muted">
        {t('account.learning')}: {active.lang.endonym}
      </p>

      {available.length > 0 && (
        <>
          <label htmlFor="add-lang">{t('account.addLanguage')}</label>
          <p className="small muted">{t('account.addLanguageHint')}</p>
          <div className="row wrap account-language-controls">
            <select id="add-lang" value={pending} onChange={(e) => setPending(e.target.value)}>
              <option value="">{t('common.add')}</option>
              {available.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.endonym} — {l.name}
                </option>
              ))}
            </select>
            <select
              aria-label={t('account.nativeLanguage')}
              value={native}
              onChange={(e) => setNative(e.target.value)}
            >
              <option value="">{t('account.nativeLanguage')}</option>
              {account.targetLangs.map((language) => (
                <option key={language.code} value={language.code}>
                  {language.endonym} — {language.name}
                </option>
              ))}
            </select>
            <button className="primary" disabled={busy || !pending} onClick={() => void add()}>
              {t('common.add')}
            </button>
          </div>
        </>
      )}
      {available.length === 0 && <p className="small muted">{t('account.noMoreLanguages')}</p>}
      {msg && <p className={`small ${msg.error ? 'error-banner' : 'muted'}`}>{msg.text}</p>}

      <div className="row" style={{ marginTop: 16 }}>
        <button onClick={() => void signOut()}>{t('account.signOut')}</button>
      </div>
    </div>
  );
}
