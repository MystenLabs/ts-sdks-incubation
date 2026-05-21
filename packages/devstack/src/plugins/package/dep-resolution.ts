// Move-dep helpers.
//
// `mvrSlugify` normalises a package name into the slug shape that
// codegen emitters write into Move source as MVR placeholders.
// Distilled doc Invariant 13: the result MUST satisfy `[a-z0-9-]+`
// (downstream validators reject underscores).

/**
 * Slugify a package name into the MVR placeholder shape required by
 * codegen emitters.
 */
export const mvrSlugify = (name: string): string =>
	name
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.replace(/-{2,}/g, '-');
