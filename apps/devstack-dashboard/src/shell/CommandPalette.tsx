// ⌘K command palette. A controlled overlay: the parent owns `open` and supplies
// the command list (navigation + actions). Filters by label, arrow-key nav with
// wrap, Enter runs + closes, Escape closes. Renders nothing when closed.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Icon, type IconName } from '../ui/index.ts';

export interface Command {
	readonly id: string;
	readonly label: string;
	readonly hint?: string;
	readonly icon?: IconName;
	readonly run: () => void;
}

export interface CommandPaletteProps {
	readonly open: boolean;
	readonly onClose: () => void;
	readonly commands: ReadonlyArray<Command>;
}

const MAX_SHOWN = 9;

export const CommandPalette = ({ open, onClose, commands }: CommandPaletteProps) => {
	const [query, setQuery] = useState('');
	const [selected, setSelected] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);

	// Reset query + selection each time the palette opens, and focus the input.
	useEffect(() => {
		if (!open) return;
		setQuery('');
		setSelected(0);
		inputRef.current?.focus();
	}, [open]);

	const shown = useMemo(() => {
		const q = query.trim().toLowerCase();
		const matches = q
			? commands.filter((c) => `${c.label} ${c.hint ?? ''}`.toLowerCase().includes(q))
			: commands;
		return matches.slice(0, MAX_SHOWN);
	}, [commands, query]);

	// Keep the highlight in range as the filtered list shrinks.
	useEffect(() => {
		setSelected((s) => (shown.length === 0 ? 0 : Math.min(s, shown.length - 1)));
	}, [shown.length]);

	if (!open) return null;

	const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			setSelected((s) => (shown.length === 0 ? 0 : (s + 1) % shown.length));
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			setSelected((s) => (shown.length === 0 ? 0 : (s - 1 + shown.length) % shown.length));
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const item = shown[selected];
			if (item) {
				item.run();
				onClose();
			}
		} else if (e.key === 'Escape') {
			e.preventDefault();
			onClose();
		}
	};

	return (
		<div className="overlay" onClick={onClose} style={{ alignItems: 'flex-start' }}>
			<div
				className="panel palette"
				onClick={(e) => e.stopPropagation()}
				style={{ boxShadow: 'var(--sh-pop)', overflow: 'hidden' }}
			>
				<div
					className="row"
					style={{ padding: '0 16px', borderBottom: '1px solid var(--line)', gap: 10 }}
				>
					<Icon name="search" size={17} style={{ color: 'var(--tx-lo)' }} />
					<input
						ref={inputRef}
						className="palette-input"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={onKeyDown}
						placeholder="Jump to a page or run a command…"
						style={{ padding: 0 }}
					/>
					<kbd>esc</kbd>
				</div>
				<div className="col scroll-y" style={{ padding: 8, maxHeight: 380 }}>
					{shown.length === 0 ? (
						<div style={{ padding: 24, textAlign: 'center', color: 'var(--tx-lo)', fontSize: 13 }}>
							No matches
						</div>
					) : (
						shown.map((item, i) => (
							<div
								key={item.id}
								className={'palette-item ' + (i === selected ? 'on' : '')}
								onMouseEnter={() => setSelected(i)}
								onClick={() => {
									item.run();
									onClose();
								}}
							>
								<Icon name={item.icon ?? 'arrowR'} size={16} style={{ color: 'var(--tx-mid)' }} />
								<span style={{ fontSize: 14 }}>{item.label}</span>
								{item.hint && (
									<span
										className="mono trunc"
										style={{ fontSize: 11.5, color: 'var(--tx-dim)', maxWidth: 220 }}
									>
										{item.hint}
									</span>
								)}
								<Icon
									name="arrowR"
									size={14}
									className="pi-arrow"
									style={{ marginLeft: 'auto', opacity: 0, color: 'var(--accent)' }}
								/>
							</div>
						))
					)}
				</div>
			</div>
		</div>
	);
};
