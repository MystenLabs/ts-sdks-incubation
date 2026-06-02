/// <reference types="vite/client" />

interface ImportMetaEnv {
	/** When `'1'`, the dev wallet auto-approves signing requests so
	 *  Playwright flows and the in-app "Open/Join as" buttons run without a
	 *  manual click. Only consulted by the DEV-gated `dapp-kit.dev.ts`. */
	readonly VITE_CONNECT_FOUR_AUTO_APPROVE?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
