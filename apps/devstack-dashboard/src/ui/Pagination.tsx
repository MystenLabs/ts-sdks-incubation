import { Icon } from './icons.tsx';

export interface PaginationProps {
	/** Current zero-based page index. */
	readonly page: number;
	/** Total number of pages. */
	readonly pageCount: number;
	/** Navigate to a (zero-based) page. */
	readonly onPage: (page: number) => void;
}

/**
 * Windowed page navigator: prev/next arrows around a run of numbered buttons.
 * Always shows the first/last page and a one-page window either side of the
 * current page, collapsing the gaps to ellipses.
 */
export const Pagination = ({ page, pageCount, onPage }: PaginationProps) => {
	const nums: Array<number | '…'> = [];
	const win = 1;
	for (let i = 0; i < pageCount; i++) {
		if (i === 0 || i === pageCount - 1 || Math.abs(i - page) <= win) nums.push(i);
		else if (nums[nums.length - 1] !== '…') nums.push('…');
	}
	return (
		<div className="flex items-center gap-[5px]">
			<button className="iconbtn" disabled={page === 0} onClick={() => onPage(page - 1)}>
				<Icon name="chevL" size={15} />
			</button>
			{nums.map((n, i) =>
				n === '…' ? (
					<span key={i} className="px-[6px] text-dim text-[12px]">
						…
					</span>
				) : (
					<button
						key={i}
						onClick={() => onPage(n)}
						className="h-[30px] min-w-[30px] px-[8px] rounded-[6px] border text-[12.5px] font-mono tabular-nums cursor-pointer transition-all"
						style={
							n === page
								? {
										background: 'var(--accent-soft)',
										borderColor: 'var(--accent-line)',
										color: 'var(--tx-hi)',
									}
								: { background: 'transparent', borderColor: 'transparent', color: 'var(--tx-mid)' }
						}
					>
						{n + 1}
					</button>
				),
			)}
			<button
				className="iconbtn"
				disabled={page === pageCount - 1}
				onClick={() => onPage(page + 1)}
			>
				<Icon name="chevR" size={15} />
			</button>
		</div>
	);
};
