import { pluginKey, type PluginKey } from '../../substrate/brand.ts';

export const deepbookPluginKey = (name: string): PluginKey => pluginKey(`deepbook:${name}`);
