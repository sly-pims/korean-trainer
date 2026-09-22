import { NavLink } from 'react-router-dom';

const TABS = [
  { to: '/', glyph: '🏠', label: 'Home' },
  { to: '/practice', glyph: '🎙️', label: 'Practice' },
  { to: '/words', glyph: '📚', label: 'Words' },
  { to: '/progress', glyph: '📈', label: 'Progress' },
  { to: '/settings', glyph: '⚙️', label: 'Settings' },
];

export function TabBar() {
  return (
    <nav className="tabs">
      {TABS.map((t) => (
        <NavLink key={t.to} to={t.to} end={t.to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>
          <span className="glyph">{t.glyph}</span>
          <span>{t.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}