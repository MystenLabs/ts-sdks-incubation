import { defineDevstackViteConfig } from '@mysten-incubation/devstack/vite';
import react from '@vitejs/plugin-react';

export default defineDevstackViteConfig({ port: 5176, plugins: [react()] });
