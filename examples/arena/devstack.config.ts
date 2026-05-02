// Arena app — on-chain Connect Four. Matchmaking via shared `Lobby`
// objects, gameplay via shared `Game` objects (column-major 7x6 board,
// winner: Option<address>). The Move package + openLobby seed live in
// arenaPlugin(); named accounts are declared at the top level so the
// devstack resolver materializes a `Signer` per name and the sui
// plugin's accounts action faucets each on localnet.

import {
	codegen,
	defineDevstackConfig,
	frontend,
	sui,
	walletServer,
} from '@mysten-incubation/devstack';
import { arenaPlugin } from './arenaPlugin.ts';

export default defineDevstackConfig({
	app: 'arena',
	accounts: {
		publisher: {},
		alice: {},
		bob: {},
	},
	plugins: [
		sui({ version: 'devnet-v1.71.0' }),
		arenaPlugin(),
		codegen(),
		walletServer({ port: 9421 }),
		frontend({ port: 5176 }),
	],
});
