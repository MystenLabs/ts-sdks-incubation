// Shared contract for routed panels. Each panel is `(props: PanelProps) => JSX`.
// The app shell gates connection/empty/error states, so a mounted panel always
// receives a non-null projection. Navigation (`goto`) and toasts are imported
// from `lib/` directly where needed; data comes through these props.

import type { ActivityItem, Connection } from '../lib/useProjection.ts';
import type { Projection } from '../lib/types.ts';

export interface PanelProps {
	/** Live projection snapshot — non-null (the shell renders fallbacks otherwise). */
	readonly projection: Projection;
	/** Client-derived activity feed (newest first), from the projection diff. */
	readonly activity: ReadonlyArray<ActivityItem>;
	/** GraphQL endpoint, for mutations + chain reads. */
	readonly endpoint: string;
	readonly connection: Connection;
	/** Force an immediate projection refresh (e.g. right after a mutation). */
	readonly refresh: () => Promise<void>;
}

export type { ActivityItem, Connection };
