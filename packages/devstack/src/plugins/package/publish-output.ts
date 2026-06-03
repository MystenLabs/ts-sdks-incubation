// Local package publish output.
//
// This is package-domain data: the transaction digest plus object-change
// projection produced by a successful `localPackage(...)` publish. The
// package plugin's `start` folds this output's coins into the per-stack
// CoinRegistry directly (see `discoverPublishedCoins`); there is no
// longer a custom contribution-decl kind for it (Stage B P4 removed the
// `package.local-published` decl + its `publishResultSink`).

export interface PackagePublishObjectChange {
	readonly type: 'created' | 'published' | 'mutated' | 'wrapped' | 'transferred';
	readonly objectId?: string;
	readonly objectType?: string;
	readonly owner?: unknown;
	readonly json?: unknown;
}

export interface PickCreatedByTypeOptions {
	readonly type?: string;
	readonly suffix?: string;
	readonly contains?: string;
}

export interface LocalPackagePublishOutput {
	readonly digest: string;
	readonly packageId: string;
	readonly upgradeCapId?: string;
	readonly publisher: string;
	readonly objectChanges: ReadonlyArray<PackagePublishObjectChange>;
}

export const pickPublishedChange = (
	changes: ReadonlyArray<PackagePublishObjectChange>,
): PackagePublishObjectChange | undefined => changes.find((c) => c.type === 'published');

export const pickUpgradeCapChange = (
	changes: ReadonlyArray<PackagePublishObjectChange>,
): PackagePublishObjectChange | undefined =>
	changes.find(
		(c) => c.type === 'created' && (c.objectType?.endsWith('::package::UpgradeCap') ?? false),
	);

const createdKind = (change: unknown): boolean => {
	if (change === undefined || change === null) return false;
	const tag = (change as { readonly type?: unknown; readonly kind?: unknown }).type;
	const kind = (change as { readonly kind?: unknown }).kind;
	return tag === 'created' || kind === 'created';
};

const objectIdOf = (change: unknown): string | undefined => {
	if (change === undefined || change === null) return undefined;
	const objectId = (change as { readonly objectId?: unknown }).objectId;
	return typeof objectId === 'string' ? objectId : undefined;
};

const objectTypeOf = (change: unknown): string | undefined => {
	if (change === undefined || change === null) return undefined;
	const objectType = (change as { readonly objectType?: unknown }).objectType;
	return typeof objectType === 'string' ? objectType : undefined;
};

const matchesType = (objectType: string, opts: PickCreatedByTypeOptions): boolean => {
	if (opts.type !== undefined && objectType === opts.type) return true;
	if (opts.suffix !== undefined && objectType.endsWith(opts.suffix)) return true;
	if (opts.contains !== undefined && objectType.includes(opts.contains)) return true;
	return opts.type === undefined && opts.suffix === undefined && opts.contains === undefined;
};

export const pickCreatedByType = (
	changes: ReadonlyArray<unknown> | undefined,
	opts: PickCreatedByTypeOptions,
): string | undefined => {
	const found = (changes ?? []).find((change) => {
		if (!createdKind(change)) return false;
		if (objectIdOf(change) === undefined) return false;
		const objectType = objectTypeOf(change);
		return objectType !== undefined && matchesType(objectType, opts);
	});
	return objectIdOf(found);
};
