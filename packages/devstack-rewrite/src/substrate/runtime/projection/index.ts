// Renderer projection runtime barrel.
//
// The renderer-facing surface: a `SubscriptionRef<SubscribableState>`
// plus a reducer that maps `EngineEvent` → next state. Renderers see
// only this; the engine never appears in the renderer's import graph.

export * from './state-ref.ts';
export * from './update.ts';
