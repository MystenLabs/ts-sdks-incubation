import type { StatusToken } from '../lib/derive.ts';

export interface LevelPillProps {
	/** Log level to render. */
	readonly level: 'info' | 'warn' | 'error' | 'debug';
}

const LEVEL_TOKEN: Record<LevelPillProps['level'], StatusToken> = {
	error: 'red',
	warn: 'yellow',
	info: 'cyan',
	debug: 'white',
};

/**
 * Compact, uppercase log-level label, monospaced and color-tokened per level.
 */
export const LevelPill = ({ level }: LevelPillProps) => {
	const token = LEVEL_TOKEN[level];
	return (
		<span
			className="mono"
			style={{
				fontSize: 10.5,
				fontWeight: 600,
				letterSpacing: '.06em',
				textTransform: 'uppercase',
				color: `var(--c-${token})`,
				minWidth: 38,
				display: 'inline-block',
			}}
		>
			{level}
		</span>
	);
};
