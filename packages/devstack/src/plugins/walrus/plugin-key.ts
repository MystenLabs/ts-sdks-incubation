import { pluginKey, type PluginKey } from '../../substrate/brand.ts';

export const walrusPluginKey = (name: string): PluginKey => pluginKey(`walrus:${name}`);
