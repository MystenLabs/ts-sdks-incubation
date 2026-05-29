export interface LoadMoreProps {
	/** Fetch-more handler. */
	readonly onClick: () => void;
	/** When true, shows a pulsing "Loading…" state and disables the button. */
	readonly loading?: boolean;
	/** Optional count of remaining items, surfaced in the label. */
	readonly remaining?: number;
}

/**
 * Full-width "load more" affordance for paginated lists. Swaps to a pulsing
 * loading state while fetching and, when known, annotates how many items remain.
 */
export const LoadMore = ({ onClick, loading, remaining }: LoadMoreProps) => (
	<button className="btn w-full" onClick={onClick} disabled={loading}>
		{loading ? (
			<>
				<span className="dot dot-white dot-pulse" /> Loading…
			</>
		) : (
			<>Load more{remaining != null ? ` · ${remaining.toLocaleString()} remaining` : ''}</>
		)}
	</button>
);
