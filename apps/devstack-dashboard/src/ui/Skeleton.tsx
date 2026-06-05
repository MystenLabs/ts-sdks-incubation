import type { CSSProperties } from 'react';

export interface SkeletonProps {
	/** Width (CSS length or px number). Defaults to `100%`. */
	readonly w?: string | number;
	/** Height (CSS length or px number). Defaults to `14`. */
	readonly h?: string | number;
	/** Border radius (CSS length or px number). Defaults to `6`. */
	readonly r?: string | number;
	/** Extra inline styles merged onto the block. */
	readonly style?: CSSProperties;
}

/**
 * Shimmering placeholder block (uses the `.skel` sweep). Size it with `w`/`h`
 * and round it with `r`.
 */
export const Skeleton = ({ w = '100%', h = 14, r = 6, style }: SkeletonProps) => (
	<span
		className="skel"
		style={{ display: 'block', width: w, height: h, borderRadius: r, ...style }}
	/>
);

export interface SkeletonRowsProps {
	/** Number of placeholder rows. Defaults to `5`. */
	readonly rows?: number;
	/** Number of placeholder cells per row. Defaults to `4`. */
	readonly cols?: number;
}

/**
 * A stack of skeleton rows that mimics a loading table: each row holds `cols`
 * skeleton cells, the first one wider as a stand-in for a label column.
 */
export const SkeletonRows = ({ rows = 5, cols = 4 }: SkeletonRowsProps) => (
	<div className="col" style={{ gap: 0 }}>
		{Array.from({ length: rows }).map((_, i) => (
			<div
				key={i}
				className="row"
				style={{ gap: 16, padding: '11px 13px', borderBottom: '1px solid var(--line-faint)' }}
			>
				{Array.from({ length: cols }).map((_, j) => (
					<Skeleton key={j} w={j === 0 ? 150 : `${40 + ((i + j) % 3) * 18}px`} />
				))}
			</div>
		))}
	</div>
);
