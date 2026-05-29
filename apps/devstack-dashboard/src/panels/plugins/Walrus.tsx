// Walrus plugin view — scaffold only. Round-3 agent fills the real content
// (storage nodes, blobs, system/staking objects).

import { EmptyState } from '../../ui/index.ts';
import { PluginScaffold, type PluginViewProps } from '../PluginPage.tsx';

export const WalrusView = ({ row }: PluginViewProps) => (
	<PluginScaffold label="Walrus" icon="database" row={row} subtitle="Walrus storage network.">
		{/* TODO(panel): real walrus content */}
		<div className="panel">
			<EmptyState
				icon="database"
				title="Walrus panel coming soon"
				hint="Storage nodes, blobs, and system objects land here."
			/>
		</div>
	</PluginScaffold>
);
