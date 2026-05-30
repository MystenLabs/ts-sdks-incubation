import { useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Icon } from './icons.tsx';
import { EmptyState } from './EmptyState.tsx';

/** Column definition for a {@link DataTable} over rows of type `Row`. */
export interface Column<Row> {
	/** Stable identifier (also the sort key). */
	readonly key: string;
	/** Header cell content. */
	readonly header: ReactNode;
	/** Cell renderer for a given row. */
	readonly render: (row: Row) => ReactNode;
	/** Horizontal alignment for the header and cells. Defaults to `left`. */
	readonly align?: 'left' | 'right' | 'center';
	/** Fixed column width (CSS length or px number). */
	readonly width?: string | number;
	/** When present, the column is sortable; returns the value to sort by. */
	readonly sortVal?: (row: Row) => string | number;
}

export interface DataTableProps<Row> {
	/** Ordered column definitions. */
	readonly columns: ReadonlyArray<Column<Row>>;
	/** Rows to render. */
	readonly rows: ReadonlyArray<Row>;
	/** Stable React key for a row. */
	readonly rowKey: (row: Row) => string;
	/** Optional row-click handler; presence makes rows interactive. */
	readonly onRowClick?: (row: Row) => void;
	/** Row key to highlight as selected (matched against `rowKey`). */
	readonly activeKey?: string;
	/** Content shown in place of the body when there are no rows. */
	readonly empty?: ReactNode;
	/** Extra classes appended after the base `tbl` class. */
	readonly className?: string;
}

interface SortState {
	readonly key: string;
	readonly dir: 'asc' | 'desc';
}

/**
 * Config-driven table. Pass `columns` + `rows` and a `rowKey`; columns with a
 * `sortVal` get clickable headers that cycle ascending → descending. Renders
 * the `.tbl` markup with a sticky header, optional clickable/hover rows, and an
 * `empty` slot. Fully generic over the row type.
 */
export const DataTable = <Row,>({
	columns,
	rows,
	rowKey,
	onRowClick,
	activeKey,
	empty,
	className = '',
}: DataTableProps<Row>) => {
	const [sort, setSort] = useState<SortState | null>(null);

	const sorted = useMemo(() => {
		if (!sort) return rows;
		const col = columns.find((c) => c.key === sort.key);
		if (!col?.sortVal) return rows;
		const sortVal = col.sortVal;
		return [...rows].sort((a, b) => {
			const x = sortVal(a);
			const y = sortVal(b);
			const cmp =
				typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
			return sort.dir === 'asc' ? cmp : -cmp;
		});
	}, [rows, sort, columns]);

	const toggle = (col: Column<Row>) => {
		if (!col.sortVal) return;
		setSort((prev) =>
			prev?.key !== col.key
				? { key: col.key, dir: 'asc' }
				: prev.dir === 'asc'
					? { key: col.key, dir: 'desc' }
					: null,
		);
	};

	return (
		<table className={`tbl ${className}`.trimEnd()}>
			<thead>
				<tr>
					{columns.map((col) => {
						const active = sort?.key === col.key;
						const sortable = Boolean(col.sortVal);
						const style: CSSProperties = {
							width: col.width,
							textAlign: col.align ?? 'left',
							cursor: sortable ? 'pointer' : 'default',
						};
						return (
							<th key={col.key} style={style} onClick={() => toggle(col)}>
								<span
									className="row"
									style={{
										gap: 5,
										justifyContent: col.align === 'right' ? 'flex-end' : 'flex-start',
									}}
								>
									{col.header}
									{sortable && (
										<Icon
											name="chevD"
											size={11}
											style={{
												opacity: active ? 0.9 : 0.3,
												transform: active && sort?.dir === 'asc' ? 'rotate(180deg)' : 'none',
											}}
										/>
									)}
								</span>
							</th>
						);
					})}
				</tr>
			</thead>
			<tbody>
				{sorted.length === 0 ? (
					<tr>
						<td colSpan={columns.length} style={{ padding: 0 }}>
							{empty ?? <EmptyState title="No rows" />}
						</td>
					</tr>
				) : (
					sorted.map((row) => {
						const key = rowKey(row);
						const rowClass = `${onRowClick ? 'clickable' : ''} ${
							key === activeKey ? 'bg-accent-soft' : ''
						}`.trim();
						return (
							<tr
								key={key}
								className={rowClass}
								onClick={onRowClick ? () => onRowClick(row) : undefined}
							>
								{columns.map((col) => (
									<td key={col.key} style={{ textAlign: col.align ?? 'left' }}>
										{col.render(row)}
									</td>
								))}
							</tr>
						);
					})
				)}
			</tbody>
		</table>
	);
};
