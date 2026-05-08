import type { DepRecipe } from '../engine/types.js';

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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function dep(get: (...args: any[]) => unknown): DepRecipe<any, any, any> {
	return { get };
}
