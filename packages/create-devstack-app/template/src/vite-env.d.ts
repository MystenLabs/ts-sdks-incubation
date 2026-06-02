/// <reference types="vite/client" />

interface ImportMetaEnv {
	/** Active network key override (default `"local"` from the generated
	 *  config). Set to flip `config.network` to a declared prod network. */
	readonly VITE_DEVSTACK_NETWORK?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
