// `<DevstackDebugPanel>` — reflective form-per-builder UI for every
// codegen-bound package in the active devstack manifest. Modeled after
// scaffold-eth-2's /debug page. Mounts only under `import.meta.env.DEV`
// (a runtime guard; bundlers tree-shake the rest in prod builds when
// `process.env.NODE_ENV === 'production'`).

import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { Transaction } from '@mysten/sui/transactions';
import { bindPackage } from './bind-package.js';
import { useDevstackContext } from './provider.js';
import { useDevstackSignAndExecute } from './use-devstack-sign-and-execute.js';
import type { CodegenModule } from './types.js';

export interface DevstackDebugPanelProps {
	/** Visible heading (default: "Devstack Debug"). */
	title?: string;
	/** Inline style overrides applied to the panel root. */
	style?: React.CSSProperties;
	/** When false, render even outside `import.meta.env.DEV`. Use only
	 * for staging/inspection environments where exposing the panel is
	 * intentional; production builds should never see this UI. */
	devOnly?: boolean;
}

export function DevstackDebugPanel(props: DevstackDebugPanelProps): ReactElement | null {
	const { manifest, packages } = useDevstackContext();
	const isDev = isDevelopmentMode();
	const devOnly = props.devOnly ?? true;

	useEffect(() => {
		// Two warning conditions, independent:
		//  1. Mounted in production (devOnly was bypassed) — surface that
		//     loud since the panel submits real txs.
		//  2. Mounted against a non-localnet network — submits hit the live
		//     chain regardless of devOnly.
		if (!devOnly) {
			// eslint-disable-next-line no-console
			console.warn(
				'[DevstackDebugPanel] Mounted with devOnly={false}. ' +
					'The panel submits real transactions — make sure this is intentional.',
			);
		}
		if (manifest !== null && manifest.network !== 'localnet') {
			// eslint-disable-next-line no-console
			console.warn(
				`[DevstackDebugPanel] Mounted against network=${manifest.network}. ` +
					'Submitted forms hit the live chain.',
			);
		}
	}, [devOnly, manifest]);

	if (devOnly && !isDev) return null;

	if (manifest === null) {
		return (
			<div style={panelStyle(props.style)}>
				<h2 style={headingStyle}>{props.title ?? 'Devstack Debug'}</h2>
				<p style={emptyStyle}>
					No manifest yet. Run <code>pnpm localnet:up</code>.
				</p>
			</div>
		);
	}

	const packageNames = Object.keys(packages);
	return (
		<div style={panelStyle(props.style)}>
			<h2 style={headingStyle}>{props.title ?? 'Devstack Debug'}</h2>
			<div style={metaStyle}>
				app: <code>{manifest.app}</code> · network: <code>{manifest.network}</code> · packages:{' '}
				<code>{packageNames.length}</code>
			</div>
			{packageNames.length === 0 ? (
				<p style={emptyStyle}>No packages registered with DevstackProvider.</p>
			) : (
				packageNames.map((name) => {
					const mod = packages[name];
					if (mod === undefined) return null;
					return <PackageSection key={name} name={name} module={mod} manifest={manifest} />;
				})
			)}
		</div>
	);
}

interface PackageSectionProps {
	name: string;
	module: CodegenModule;
	manifest: import('../runtime/manifest-types.js').Manifest | null;
}

function PackageSection({ name, module, manifest }: PackageSectionProps): ReactElement {
	// Bind the codegen module against the live packageId so submitted txs
	// hit the deployed package and not the literal `@local-pkg/<name>`
	// placeholder. Returns the unbound module when the package isn't
	// deployed yet — the form renders an empty / disabled state.
	const bound = useMemo<CodegenModule | null>(() => {
		if (manifest === null) return null;
		const registryPackages =
			(manifest.registry as { packages?: Array<{ name: string; packageId: string }> }).packages ??
			[];
		const entry = registryPackages.find((p) => p.name === name);
		if (entry === undefined) return null;
		return bindPackage(module, entry.packageId);
	}, [module, manifest, name]);

	const builders = useMemo(
		() =>
			bound === null
				? []
				: (Object.entries(bound).filter(([, value]) => {
						if (typeof value !== 'function') return false;
						const len = (value as { length: number }).length;
						return len <= 1;
					}) as Array<[string, (opts?: Record<string, unknown>) => unknown]>),
		[bound],
	);

	if (bound === null) {
		return (
			<details style={packageStyle}>
				<summary style={summaryStyle}>
					<code>{name}</code> — not deployed yet
				</summary>
				<p style={emptyStyle}>
					Run <code>pnpm exec devstack apply</code> first.
				</p>
			</details>
		);
	}

	return (
		<details style={packageStyle} open={true}>
			<summary style={summaryStyle}>
				<code>{name}</code> — {builders.length} builder{builders.length === 1 ? '' : 's'}
			</summary>
			{builders.map(([builderName, builder]) => (
				<BuilderForm
					key={builderName}
					packageName={name}
					builderName={builderName}
					builder={builder}
				/>
			))}
		</details>
	);
}

interface BuilderFormProps {
	packageName: string;
	builderName: string;
	builder: (opts?: Record<string, unknown>) => unknown;
}

function BuilderForm({ packageName, builderName, builder }: BuilderFormProps): ReactElement {
	const [argsText, setArgsText] = useState<string>('[]');
	const [output, setOutput] = useState<string>('');
	const { mutateAsync, isPending } = useDevstackSignAndExecute();

	const submit = async () => {
		setOutput('');
		try {
			const args = JSON.parse(argsText) as unknown;
			if (!Array.isArray(args)) {
				throw new Error('arguments must be a JSON array');
			}
			const tx = new Transaction();
			const buildFn = builder({ arguments: args });
			if (typeof buildFn !== 'function') {
				throw new Error(`builder ${builderName} did not return a (tx) => ... function`);
			}
			(buildFn as (tx: Transaction) => unknown)(tx);
			const result = await mutateAsync(tx);
			setOutput(JSON.stringify(result, jsonReplacer, 2));
		} catch (err) {
			setOutput(`error: ${err instanceof Error ? err.message : String(err)}`);
		}
	};

	return (
		<div style={builderStyle}>
			<div style={builderHeaderStyle}>
				<code>
					{packageName}.{builderName}
				</code>
			</div>
			<textarea
				value={argsText}
				onChange={(e) => setArgsText(e.target.value)}
				rows={3}
				style={textareaStyle}
				placeholder="JSON array of arguments — e.g. [123, '0x...']"
			/>
			<button type="button" onClick={submit} disabled={isPending} style={buttonStyle}>
				{isPending ? 'submitting…' : 'submit tx'}
			</button>
			{output.length > 0 && <pre style={outputStyle}>{output}</pre>}
		</div>
	);
}

function isDevelopmentMode(): boolean {
	// Vite + Webpack both expose `import.meta.env.DEV` (bundle-time
	// constant). In SSR / Node tests, `import.meta.env` may be undefined;
	// fall back to NODE_ENV.
	const env = (import.meta as { env?: { DEV?: boolean } }).env;
	if (env?.DEV !== undefined) return env.DEV;
	const nodeEnv = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env
		?.NODE_ENV;
	return nodeEnv !== 'production';
}

function jsonReplacer(_key: string, value: unknown): unknown {
	if (typeof value === 'bigint') return value.toString();
	return value;
}

const panelStyle = (override?: React.CSSProperties): React.CSSProperties => ({
	fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Consolas, monospace',
	fontSize: 12,
	color: '#222',
	background: '#fafafa',
	border: '1px solid #ddd',
	borderRadius: 6,
	padding: 16,
	maxWidth: 720,
	margin: '16px auto',
	...(override ?? {}),
});
const headingStyle: React.CSSProperties = { margin: '0 0 8px 0', fontSize: 16 };
const metaStyle: React.CSSProperties = { fontSize: 11, color: '#666', marginBottom: 12 };
const emptyStyle: React.CSSProperties = { fontSize: 12, color: '#888' };
const packageStyle: React.CSSProperties = {
	border: '1px solid #e5e5e5',
	borderRadius: 4,
	padding: 8,
	marginBottom: 8,
	background: '#fff',
};
const summaryStyle: React.CSSProperties = { cursor: 'pointer', fontWeight: 600, marginBottom: 4 };
const builderStyle: React.CSSProperties = {
	borderTop: '1px solid #f0f0f0',
	paddingTop: 8,
	marginTop: 8,
};
const builderHeaderStyle: React.CSSProperties = { marginBottom: 4, fontSize: 11, color: '#444' };
const textareaStyle: React.CSSProperties = {
	width: '100%',
	fontFamily: 'inherit',
	fontSize: 11,
	padding: 4,
	border: '1px solid #ddd',
	borderRadius: 3,
	resize: 'vertical',
};
const buttonStyle: React.CSSProperties = {
	marginTop: 4,
	padding: '4px 12px',
	fontSize: 11,
	border: '1px solid #888',
	borderRadius: 3,
	cursor: 'pointer',
	background: '#fff',
};
const outputStyle: React.CSSProperties = {
	marginTop: 6,
	padding: 6,
	background: '#f0f0f0',
	border: '1px solid #ddd',
	borderRadius: 3,
	maxHeight: 200,
	overflow: 'auto',
	fontSize: 10,
};
