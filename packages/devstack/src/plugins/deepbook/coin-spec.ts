// Helper for resolving coin types in pool specs. Users can write either:
//   - A fully-qualified Move type ('0x2::sui::SUI', '0x123::mock_usdc::MOCK_USDC')
//   - 'sui' as shorthand for '0x2::sui::SUI'
//   - '@reg/<name>' to look up coinTokens(registry).find(name).type at runtime

import { coinTokens } from '../../coin.js';
import type { Registry } from '../../core/types.js';

export const SUI_COIN_TYPE = '0x2::sui::SUI';

/** Resolve a coin spec to a fully-qualified Move type. */
export function resolveCoinType(registry: Registry, spec: string): string {
	if (spec === 'sui') return SUI_COIN_TYPE;
	if (spec.startsWith('@reg/')) {
		const name = spec.slice('@reg/'.length);
		const token = coinTokens(registry).find(name);
		if (token === undefined) {
			throw new Error(
				`deepbook: registry token '${name}' missing — declare it before deepbook ` +
					`runs (publish your mock coin first, register via onPublished). ` +
					`Spec: '${spec}'`,
			);
		}
		return token.type;
	}
	return spec;
}
