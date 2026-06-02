/// <reference types="vite/client" />

interface ImportMetaEnv {
	/** Active network key override (default `"local"` from the generated
	 *  config). Set to flip `config.network` to a declared prod network. */
	readonly VITE_DEVSTACK_NETWORK?: string;
	/** When `'1'`, the dev wallet auto-approves signing requests so
	 *  Playwright `connectAs` flows run without a manual click. */
	readonly VITE_TEMPLATE_AUTO_APPROVE?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
