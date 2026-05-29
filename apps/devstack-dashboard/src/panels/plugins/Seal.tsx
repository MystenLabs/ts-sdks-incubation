// Seal plugin view — scaffold only. Round-3 agent fills the real content
// (key servers, threshold, key-server URLs) via `fetchSealInfo`.

import { EmptyState } from '../../ui/index.ts';
import { PluginScaffold, type PluginViewProps } from '../PluginPage.tsx';

export const SealView = ({ row }: PluginViewProps) => (
	<PluginScaffold label="Seal" icon="plug" row={row} subtitle="Seal key-server set.">
		{/* TODO(panel): real seal content */}
		<div className="panel">
			<EmptyState
				icon="plug"
				title="Seal panel coming soon"
				hint="Key servers, threshold, and server URLs land here."
			/>
		</div>
	</PluginScaffold>
);
