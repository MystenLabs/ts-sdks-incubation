import type { PluginErrorContribution } from '../substrate/plugin.ts';
import type { AnyTag, ResolvedOf } from '../substrate/tag.ts';

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

export const readConsumedTag = <T extends AnyTag>(ctx: unknown, tag: T): ResolvedOf<T> =>
	(ctx as { readonly get: (value: T) => ResolvedOf<T> }).get(tag);
