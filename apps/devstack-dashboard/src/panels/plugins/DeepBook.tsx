// DeepBook plugin view — scaffold only. Round-3 agent fills the real content
// (pools, market-maker status, registry/admin caps) via `fetchDeepbookInfo`.

import { EmptyState } from '../../ui/index.ts';
import { PluginScaffold, type PluginViewProps } from '../PluginPage.tsx';

export const DeepBookView = ({ row }: PluginViewProps) => (
	<PluginScaffold label="DeepBook" icon="layers" row={row} subtitle="DeepBook market + pools.">
		{/* TODO(panel): real deepbook content */}
		<div className="panel">
			<EmptyState
				icon="layers"
				title="DeepBook panel coming soon"
				hint="Pools, market-maker status, and registry caps land here."
			/>
		</div>
	</PluginScaffold>
);
