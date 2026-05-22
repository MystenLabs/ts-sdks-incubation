import { account, action, defineDevstack, hostService, localPackage, wallet } from '../builtins.ts';

export const publisher = account('publisher');
export const alice = account('alice');
export const bob = account('bob');

export const connectFour = localPackage('connect_four', {
	sourcePath: './move/connect_four',
	publisher,
});

export const openLobby = action('arena.openLobby', {
	dependsOn: { signer: alice, pkg: connectFour },
	body: (ctx, { signer, pkg }) => {
		return ctx.signAndExecute(signer, (tx) => {
			tx.moveCall({ target: `${pkg.packageId}::game::create_lobby` });
		});
	},
});

export const closeLobby = action('arena.closeLobby', {
	dependsOn: [alice, connectFour],
	body: (ctx, [signer, pkg]) =>
		ctx.signAndExecute(signer, (tx) => {
			tx.moveCall({ target: `${pkg.packageId}::game::close_lobby` });
		}),
});

export const fundLobby = action('arena.fundLobby', {
	dependsOn: alice,
	body: (ctx, signer) =>
		ctx.signAndExecute(signer, (tx) => {
			tx.moveCall({ target: '0x2::coin::split' });
		}),
});

export const devWallet = wallet({
	accounts: [alice, bob, publisher],
	allowLocalhostVite: true,
	enableRouter: true,
});

export const app = hostService({
	name: 'arena-app',
	command: 'pnpm dev',
	port: 5176,
	dependsOn: [alice, connectFour, devWallet],
});

export const arenaStack = defineDevstack({
	members: [openLobby, closeLobby, fundLobby, app],
	stackName: 'arena',
	codegen: { outputDir: 'src/generated' },
});
