// Coins plugin view — scaffold only. Round-3 agent fills the real content
// (treasury caps, symbols, decimals, coin types) via `fetchCoinCaps`.

import { EmptyState } from '../../ui/index.ts';
import { PluginScaffold, type PluginViewProps } from '../PluginPage.tsx';

export const CoinsView = ({ row }: PluginViewProps) => (
	<PluginScaffold label="Coins" icon="coins" row={row} subtitle="Minted coins + treasury caps.">
		{/* TODO(panel): real coins content */}
		<div className="panel">
			<EmptyState
				icon="coins"
				title="Coins panel coming soon"
				hint="Treasury caps, symbols, decimals, and coin types land here."
			/>
		</div>
	</PluginScaffold>
);
