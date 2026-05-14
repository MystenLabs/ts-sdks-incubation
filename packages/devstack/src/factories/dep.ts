import type { DepRecipe, ExclusiveDepRecipe } from '../engine/types.js';

// `dep()` is a recipe builder used inside a producer's `provides:` catalog.
// The recipe is a (state, data) → consumer-view projection. Users annotate
// the function parameters; TS infers all three type variables from there:
//
//   provides: {
//     endpoint: dep((s: SuiState) => ({ url: s.rpcUrl })),                 // TData = void
//     account:  dep(
//       (s: SuiState, d: { name: string }) => ({ address: s.accounts[d.name] }),
//     ),
//   }
//
// (We avoid `dep<SuiState>(...)` syntax: explicit type args defeat
// inference for trailing parameters that have defaults, so the consumer
// view comes back as `unknown` instead of the function return type.)
export function dep<TState, TConsumerView>(
	get: (state: TState) => TConsumerView,
): DepRecipe<TState, void, TConsumerView>;
export function dep<TState, TData, TConsumerView>(
	get: (state: TState, data: TData) => TConsumerView,
): DepRecipe<TState, TData, TConsumerView>;
export function dep(get: (...args: any[]) => unknown): DepRecipe<any, any, any> {
	return { get };
}

// `exclusiveDep({ get, lockKey })` is a recipe builder that marks the
// projection as serialization-bound: two consumers whose Deps resolve
// to recipes with the same `lockKey` will not run in the same parallel
// batch within a topo rank. Use for resources that fight on concurrent
// access (e.g. a Sui signer's gas-coin version).
//
// Plugin-author seat:
//
//   provides: {
//     signer:    dep((s: AccountsState, d: { name: string }) => s.signers[d.name]),
//     exclusive: exclusiveDep({
//       get:     (s: AccountsState, d: { name: string }) => s.signers[d.name],
//       lockKey: (_s, d) => `signer:${d.name}`,
//     }),
//   } satisfies Provides<AccountsState>;
//
// Consumer seat (unchanged Dep<View>):
//
//   const tx = runTransaction({
//     signer: accounts.pool.get('exclusive', { name: 'publisher' }),
//   });
export function exclusiveDep<TState, TConsumerView>(recipe: {
	get: (state: TState) => TConsumerView;
	lockKey: (state: TState) => string;
}): ExclusiveDepRecipe<TState, void, TConsumerView>;
export function exclusiveDep<TState, TData, TConsumerView>(recipe: {
	get: (state: TState, data: TData) => TConsumerView;
	lockKey: (state: TState, data: TData) => string;
}): ExclusiveDepRecipe<TState, TData, TConsumerView>;
export function exclusiveDep(recipe: {
	get: (...args: any[]) => unknown;
	lockKey: (...args: any[]) => string;
}): ExclusiveDepRecipe<any, any, any> {
	return { __exclusive: true, get: recipe.get, lockKey: recipe.lockKey };
}
