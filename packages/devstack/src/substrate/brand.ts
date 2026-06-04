// Branded primitives.
//
// One file owns the brand symbol so every primitive in this package
// brands through the same shape. `Brand<T, B>` adds a unique-symbol
// phantom so two strings with different brand tags are not
// interchangeable.

declare const _brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [_brand]: B };

/** Opaque per-plugin-instance identity key. Substrate-blind. */
export type PluginKey = Brand<string, 'PluginKey'>;

/** Opaque endpoint key — `(pluginKey, dispatchId)` digest, branded. */
export type EndpointKey = Brand<string, 'EndpointKey'>;

/** Content-hash brand. Substrate folds the chain string into the final cache key. */
export type ContentHash = Brand<string, 'ContentHash'>;

/** Stack identity triple components. Validated once at boot. */
export type AppName = Brand<string, 'AppName'>;
export type StackName = Brand<string, 'StackName'>;

/** Constructor helpers. These are the boundary where unbranded strings
 *  become branded; outside this file, callers should only see branded
 *  values. */
export const pluginKey = (s: string): PluginKey => s as PluginKey;
export const endpointKey = (s: string): EndpointKey => s as EndpointKey;
export const contentHash = (s: string): ContentHash => s as ContentHash;
export const appName = (s: string): AppName => s as AppName;
export const stackName = (s: string): StackName => s as StackName;
