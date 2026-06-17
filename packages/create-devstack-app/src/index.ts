// Programmatic API for the scaffolder. The bin (`src/bin.ts`) is a thin
// prompt + argv shell around `scaffold(...)`. Importing this package
// directly is useful for monorepo automation (e.g. a turbo task that
// creates apps from a config file).

export { scaffold, type ScaffoldOptions, type ScaffoldResult } from './scaffold.js';
export { renderDevstackConfig, TEMPLATE_IDS, type TemplateId } from './render-config.js';
export {
	parseServiceList,
	SERVICE_IDS,
	SERVICES,
	type ServiceId,
	type ServiceSpec,
} from './services.js';
