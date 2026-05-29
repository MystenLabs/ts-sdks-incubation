// Shared contract for routed panels. Each panel is `(props: PanelProps) => JSX`.
// The app shell gates connection/empty/error states, so a mounted panel always
// receives a non-null projection. Navigation (`goto`) and toasts are imported
// from `lib/` directly where needed; data comes through these props.

import type { ActivityItem, Connection } from '../lib/useProjection.ts';
import type { Projection } from '../lib/types.ts';
import type { ChainSource } from '../lib/useChain.ts';

export interface PanelProps {
	/** Live projection snapshot — non-null (the shell renders fallbacks otherwise). */
	readonly projection: Projection;
	/** Client-derived activity feed (newest first), from the projection diff. */
	readonly activity: ReadonlyArray<ActivityItem>;
	/** GraphQL endpoint, for control-plane mutations + queries. */
	readonly endpoint: string;
	readonly connection: Connection;
	/**
	 * Browser-direct chain-read source: the node's gRPC `rpc` URL (or null when
	 * unavailable) plus the network cache namespace. Pass straight into the
	 * `useChain` hooks (`useChainHead(props.chain)`, …).
	 */
	readonly chain: ChainSource;
	/** Force an immediate projection refresh (e.g. right after a mutation). */
	readonly refresh: () => Promise<void>;
}

export type { ActivityItem, Connection, ChainSource };
