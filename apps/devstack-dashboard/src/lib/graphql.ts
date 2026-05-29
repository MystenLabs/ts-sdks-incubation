// gql.tada setup for the dashboard API. `graphql()` documents are type-checked
// against the schema purely from the generated introspection types below — no
// codegen beyond `gql.tada generate-output` (which regenerates graphql-env.d.ts
// from apps/devstack-dashboard/schema.graphql, itself printed by the devstack
// dashboard plugin's print-schema script).

import { initGraphQLTada } from 'gql.tada';
import type { introspection } from './graphql-env.d.ts';

export const graphql = initGraphQLTada<{
	introspection: introspection;
}>();

export type { FragmentOf, ResultOf, VariablesOf } from 'gql.tada';
export { readFragment } from 'gql.tada';
