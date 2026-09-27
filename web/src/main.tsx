import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { CopyProvider } from './copy';
import './theme.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <CopyProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </CopyProvider>
  </StrictMode>,
);