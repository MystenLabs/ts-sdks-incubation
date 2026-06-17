// Service registry for the scaffolder. Each optional service maps a CLI key
// to its prompt copy and the npm dependencies it keeps in the scaffolded
// app's package.json (unselected services' deps are deleted). What each
// service contributes to the rendered `devstack.config.ts` lives in
// `render-config.ts`.

export type ServiceId = 'walrus' | 'seal' | 'deepbook' | 'pyth';

/** All optional services, in canonical prompt + render order. The sui
 *  localnet is not listed — it is always part of the stack. DeepBook pulls its
 *  Move package straight from the upstream repo (`localPackage({ git })`, no
 *  vendored tree) and defaults to a seeded-less `DEEP/SUI` pool, so it scaffolds
 *  as a small self-contained block. `pyth` is a DeepBook add-on: it publishes a
 *  local mock-Pyth package and wires DEEP/SUI price feeds into the pool, so
 *  selecting it implies `deepbook` (see `normalizeServices`). See
 *  `examples/deepbook-trader` for the full multi-pool + multi-feed setup. */
export const SERVICE_IDS: ReadonlyArray<ServiceId> = ['walrus', 'seal', 'deepbook', 'pyth'];

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
	deepbook: {
		label: 'deepbook',
		hint: 'on-chain order book — publishes DeepBook from git + a default DEEP/SUI pool',
		// No extra npm dep: the config uses `deepbook` from the devstack barrel.
		// Add `@mysten/deepbook-v3` yourself when you build a trading UI.
		deps: [],
	},
	pyth: {
		label: 'pyth',
		hint: 'price feeds for DeepBook — local mock Pyth + DEEP/SUI feeds (implies deepbook)',
		// No extra npm dep: feeds are wired via `deepbook`'s `pyth` option.
		deps: [],
	},
};

/** Apply service implications: `pyth` is a DeepBook add-on, so selecting it
 *  pulls in `deepbook`. Returns a new canonical-order set. Call this wherever a
 *  user-chosen service set is finalized (render + package.json pruning) so the
 *  two stay consistent. */
export function normalizeServices(
	selected: ReadonlySet<ServiceId>,
): ReadonlySet<ServiceId> {
	if (!selected.has('pyth') || selected.has('deepbook')) return selected;
	return new Set<ServiceId>([...selected, 'deepbook']);
}

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
