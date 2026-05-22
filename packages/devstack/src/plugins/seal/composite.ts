import { pluginKey, type PluginKey } from '../../substrate/brand.ts';

export const sealPluginKey = (name: string): PluginKey => pluginKey(`seal:${name}`);
