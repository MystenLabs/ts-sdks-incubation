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
		// .devstack/stacks/<active>/manifest.json. Set DEVSTACK_STACK=<name> or
		// flip .devstack/active to switch stacks; the plugin reloads the
		// virtual module on change.
		...devstackVitePlugins(),
	],
	resolve: {
		alias: {
			'@': fileURLToPath(new URL('./src', import.meta.url)),
		},
	},
	server: {
		port: 5176,
		strictPort: false,
	},
});
