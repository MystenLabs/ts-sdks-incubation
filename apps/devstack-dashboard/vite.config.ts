import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev/build harness for the devstack web dashboard. Tailwind v4 is wired via
// its Vite plugin; design tokens live in src/index.css.
export default defineConfig({
	plugins: [react(), tailwindcss()],
	server: { port: 5180 },
});
