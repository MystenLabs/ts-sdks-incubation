import { truncateMiddle } from '../lib/format.ts';
import { CopyChip } from './CopyChip.tsx';

export interface AddressChipProps {
	/** The address to display/copy; `null` renders an em-dash placeholder. */
	readonly address: string | null;
	/** Optional friendly account name shown ahead of the address. */
	readonly name?: string;
	/** When true, appends an "impersonated" badge. */
	readonly impersonate?: boolean;
}

/**
 * Account address presenter: an optional name, a middle-truncated copyable
 * address chip, and an optional impersonation badge.
 */
export const AddressChip = ({ address, name, impersonate }: AddressChipProps) => (
	<span className="row" style={{ gap: 6 }}>
		{name && (
			<span style={{ color: 'var(--c-magenta)', fontWeight: 540, fontSize: 12.5 }}>{name}</span>
		)}
		<CopyChip text={address ?? '—'} display={address ? truncateMiddle(address) : '—'} />
		{impersonate && (
			<span className="badge" style={{ height: 18, fontSize: 10, color: 'var(--c-yellow)' }}>
				impersonated
			</span>
		)}
	</span>
);
