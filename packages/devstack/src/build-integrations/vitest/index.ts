// Vitest build-integration — public barrel.
//
// Architecture (distilled/23-build-integrations.md § Per-integration
// requirements → Vitest):
//   - Composable config helpers keep apps on Vitest's normal
//     `defineConfig(...)` surface.
//   - Test-setup hooks + the captured stack-context fixture are
//     opt-in; apps that want them import them explicitly.
//   - The env-var contract names + the typed errors are re-exported
//     so consumers can build their own setup wrappers without
//     reaching into subpaths.
//
// Not exported here:
//   - `config.ts`'s `_internal` slot (test-only).
//   - `setup.ts`'s `clearStackContext` (internal to the
//     beforeAll/afterAll pairing; suites that want it import from the
//     `./setup` subpath if they truly need it).

export {
	devstackVitestServerConfig,
	devstackVitestTestConfig,
	type DevstackVitestTestConfigOptions,
} from './config.ts';

export {
	getStackContext,
	runDevstackBeforeAll,
	runDevstackAfterAll,
	useDevstackTestSetup,
	type TestSetupOptions,
	type VitestLifecycleHooks,
} from './setup.ts';

export {
	loadStackContext,
	type LoadStackContextOptions,
	type StackContext,
} from './stack-context.ts';

export {
	DEFAULT_RUNTIME_ROOT,
	DEFAULT_STACK_NAME,
	RECOMMENDED_TEST_STACK,
	resolveVitestEnv,
	VITEST_ENV_VARS,
	type ResolvedVitestEnv,
	type VitestEnvVarName,
} from './env.ts';

export {
	VitestManifestNotFoundError,
	VitestManifestShapeError,
	VitestSetupPreconditionError,
	type VitestIntegrationError,
} from './errors.ts';
