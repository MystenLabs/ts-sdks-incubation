import { Effect } from 'effect';

import type { CodegenableDecl } from '../../contracts/codegenable.ts';
import type { ManifestExtras } from '../../substrate/manifest.ts';

export const makeExtrasCodegenable = (extras: ManifestExtras): CodegenableDecl<'app-extras'> => ({
	kind: 'codegenable',
	emitterName: 'app-extras',
	outputPath: 'extras.ts',
	sensitive: true,
	emit: (ctx) =>
		Effect.sync(() => {
			ctx.exportConst('extras', extras);
			return ctx.done();
		}),
});
