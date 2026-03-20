// @ts-nocheck
import { browser } from 'fumadocs-mdx/runtime/browser';
import type * as Config from '../source.config';

const create = browser<
	typeof Config,
	import('fumadocs-mdx/runtime/types').InternalTypeConfig & {
		DocData: {};
	}
>();
const browserCollections = {
	docs: create.doc('docs', {
		'dev-wallet/getting-started.mdx': () =>
			import('../content/dev-wallet/getting-started.mdx?collection=docs'),
		'dev-wallet/index.mdx': () => import('../content/dev-wallet/index.mdx?collection=docs'),
		'dev-wallet/guides/cli-signing.mdx': () =>
			import('../content/dev-wallet/guides/cli-signing.mdx?collection=docs'),
		'dev-wallet/guides/e2e-testing.mdx': () =>
			import('../content/dev-wallet/guides/e2e-testing.mdx?collection=docs'),
		'dev-wallet/reference/architecture.mdx': () =>
			import('../content/dev-wallet/reference/architecture.mdx?collection=docs'),
		'dev-wallet/reference/auto-approval.mdx': () =>
			import('../content/dev-wallet/reference/auto-approval.mdx?collection=docs'),
		'dev-wallet/reference/cli-signer-api.mdx': () =>
			import('../content/dev-wallet/reference/cli-signer-api.mdx?collection=docs'),
		'dev-wallet/reference/react-integration.mdx': () =>
			import('../content/dev-wallet/reference/react-integration.mdx?collection=docs'),
		'dev-wallet/reference/signing-flow.mdx': () =>
			import('../content/dev-wallet/reference/signing-flow.mdx?collection=docs'),
		'dev-wallet/reference/standalone-mode.mdx': () =>
			import('../content/dev-wallet/reference/standalone-mode.mdx?collection=docs'),
		'dev-wallet/reference/ui-components.mdx': () =>
			import('../content/dev-wallet/reference/ui-components.mdx?collection=docs'),
		'dev-wallet/reference/adapters/custom.mdx': () =>
			import('../content/dev-wallet/reference/adapters/custom.mdx?collection=docs'),
		'dev-wallet/reference/adapters/in-memory.mdx': () =>
			import('../content/dev-wallet/reference/adapters/in-memory.mdx?collection=docs'),
		'dev-wallet/reference/adapters/index.mdx': () =>
			import('../content/dev-wallet/reference/adapters/index.mdx?collection=docs'),
		'dev-wallet/reference/adapters/passkey.mdx': () =>
			import('../content/dev-wallet/reference/adapters/passkey.mdx?collection=docs'),
		'dev-wallet/reference/adapters/remote-cli.mdx': () =>
			import('../content/dev-wallet/reference/adapters/remote-cli.mdx?collection=docs'),
		'dev-wallet/reference/adapters/webcrypto.mdx': () =>
			import('../content/dev-wallet/reference/adapters/webcrypto.mdx?collection=docs'),
	}),
};
export default browserCollections;
