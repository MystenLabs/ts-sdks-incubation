import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Restore the persisted theme before first paint.
document.documentElement.dataset.theme = localStorage.getItem('devstack.theme') ?? 'dark';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root element');
createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
