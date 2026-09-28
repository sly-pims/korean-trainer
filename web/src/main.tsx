import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './theme.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    {/*
      No CopyProvider here on purpose. `App` supplies one per auth state — the
      deployment copy for the login screen, the enrollment's own copy once
      signed in — and wrapping the router in a third one would fetch `/api/meta`
      on every load only to be overridden, and would briefly show the wrong
      language's copy.
    */}
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);