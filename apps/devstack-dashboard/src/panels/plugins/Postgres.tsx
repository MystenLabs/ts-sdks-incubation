// Postgres plugin view — scaffold only. Round-3 agent fills the real content
// (database size, connection count, tables) via `fetchPostgresStats`.

import { EmptyState } from '../../ui/index.ts';
import { PluginScaffold, type PluginViewProps } from '../PluginPage.tsx';

export const PostgresView = ({ row }: PluginViewProps) => (
	<PluginScaffold label="Postgres" icon="database" row={row} subtitle="Postgres wire-protocol stats.">
		{/* TODO(panel): real postgres content */}
		<div className="panel">
			<EmptyState
				icon="database"
				title="Postgres panel coming soon"
				hint="Database size, connections, and table stats land here."
			/>
		</div>
	</PluginScaffold>
);
