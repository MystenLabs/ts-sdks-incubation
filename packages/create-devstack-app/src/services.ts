// Service registry for the scaffolder. Each optional service maps a CLI key
// to its prompt copy and the npm dependencies it keeps in the scaffolded
// app's package.json (unselected services' deps are deleted). What each
// service contributes to the rendered `devstack.config.ts` lives in
// `render-config.ts`.

export type ServiceId = 'walrus' | 'seal';

/** All optional services, in canonical prompt + render order. The sui
 *  localnet is not listed — it is always part of the stack. DeepBook is
 *  deliberately absent: devstack no longer auto-synthesizes a local
 *  DeepBook (it needs vendored Move packages and explicit pool config),
 *  so it can't be a one-line service — the README points to
 *  examples/deepbook-trader instead. */
export const SERVICE_IDS: ReadonlyArray<ServiceId> = ['walrus', 'seal'];

export interface ServiceSpec {
	/** Multiselect label. */
	readonly label: string;
	/** Multiselect hint. */
	readonly hint: string;
	/** `dependencies` keys kept in the scaffolded app's package.json only
	 *  when the service is selected (deleted otherwise). */
	readonly deps: ReadonlyArray<string>;
}

export const SERVICES: Readonly<Record<ServiceId, ServiceSpec>> = {
	walrus: {
		label: 'walrus',
		hint: 'blob storage — upload & read blobs',
		deps: ['@mysten/walrus', '@mysten/walrus-wasm'],
	},
	seal: {
		label: 'seal',
		hint: 'encryption — encrypt & decrypt against a local key server',
		deps: ['@mysten/seal'],
	},
};

/** Parse a `--services walrus,seal` value into the canonical-order service
 *  list (deduplicated). Throws on unknown ids; empty segments are ignored,
 *  so `--services ''` means "no optional services". */
export function parseServiceList(value: string): ReadonlyArray<ServiceId> {
	const selected = new Set<string>();
	for (const raw of value.split(',')) {
		const id = raw.trim();
		if (id === '') continue;
		if (!(SERVICE_IDS as ReadonlyArray<string>).includes(id)) {
			throw new Error(`unknown service '${id}'. Valid: ${SERVICE_IDS.join(', ')}.`);
		}
		selected.add(id);
	}
	return SERVICE_IDS.filter((id) => selected.has(id));
}
