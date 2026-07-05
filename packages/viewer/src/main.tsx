import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from './ui';
import './index.css';
import { App } from './app';

const el = document.getElementById('root');
if (!el) throw new Error('#root not found');
createRoot(el).render(
  <StrictMode>
    <App />
    <Toaster />
  </StrictMode>,
);
