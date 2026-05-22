import type { PluginErrorContribution } from '../substrate/plugin.ts';

export const pluginErrorContributions = <Tags extends ReadonlyArray<string>>(
	errorTags: Tags,
	formatter?: PluginErrorContribution['formatter'],
): readonly [PluginErrorContribution] => [
	{
		_tag: 'PluginErrorContribution',
		errorTags,
		...(formatter === undefined ? {} : { formatter }),
	},
];
