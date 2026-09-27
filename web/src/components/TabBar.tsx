import { NavLink } from 'react-router-dom';
import { useCopy } from '../copy';
import type { CopyKey } from '../copy';

const TABS: { to: string; glyph: string; label: CopyKey }[] = [
  { to: '/', glyph: '🏠', label: 'nav.home' },
  { to: '/practice', glyph: '🎙️', label: 'nav.practice' },
  // The tab used to read "Vocabulary" while the page heading read "Words".
  // One concept, one key.
  { to: '/words', glyph: '📚', label: 'nav.words' },
  { to: '/progress', glyph: '📈', label: 'nav.progress' },
  { to: '/settings', glyph: '⚙️', label: 'nav.settings' },
];

export function TabBar() {
  const { t } = useCopy();
  return (
    <nav className="tabs">
      {TABS.map((tab) => (
        <NavLink key={tab.to} to={tab.to} end={tab.to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>
          <span className="glyph">{tab.glyph}</span>
          <span>{t(tab.label)}</span>
        </NavLink>
      ))}
    </nav>
  );
}
