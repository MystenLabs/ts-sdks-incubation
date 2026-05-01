import { fileURLToPath } from 'node:url';

import { devstackVitePlugins } from '@mysten-incubation/devstack/vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		react(),
		tailwindcss(),
		// Defaults to the active-stack manifest at
		// .devstack/stacks/<active>/manifest.json.
		...devstackVitePlugins(),
	],
	resolve: {
		alias: {
			'@': fileURLToPath(new URL('./src', import.meta.url)),
		},
	},
	server: {
		port: 5174,
		strictPort: false,
	},
});
