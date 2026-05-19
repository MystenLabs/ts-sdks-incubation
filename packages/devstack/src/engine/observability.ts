// Observability helpers — span / annotation conventions for devstack.
//
// Span-name convention (AGENTS.md "Errors / observability"): PascalCase
// service-domain names. Examples that conform: `SuiBoot`,
// `WalrusPublishPackage`, `SealKeyServer`, `PackagePublish`,
// `ManifestWrite`, `DockerImage(name)`. New code uses this form; all
// `Effect.withSpan(...)` callsites were swept to PascalCase in one
// batch (Wave 4 §6.2). `Effect.fn(...)` span labels remain on the
// "migrate as files are touched" cadence.
//
// Annotation-key convention: service-name prefix, dot-separated path.
// `sui.chainId`, `walrus.epoch`, `package.name`, `account.address`.
// Three keys are stamped universally by `annotateDevstackContext`:
// `service.name`, `devstack.stack`, `devstack.app`.

import { Effect } from 'effect';
import { Identity } from './identity.js';

/** Stamp the standard devstack span-context annotations: `service.name`
 *  (the calling primitive's service label, passed in), plus
 *  `devstack.stack` and `devstack.app` (read from `Identity`). Use
 *  inside any `Effect.withSpan(...)` block that runs under the
 *  supervisor's layer graph; the annotations help correlate spans
 *  across services within one cycle. */
export const annotateDevstackContext = (service: string): Effect.Effect<void, never, Identity> =>
	Effect.gen(function* () {
		const identity = yield* Identity;
		yield* Effect.annotateCurrentSpan({
			'service.name': service,
			'devstack.stack': identity.stack,
			'devstack.app': identity.app,
		});
	});
