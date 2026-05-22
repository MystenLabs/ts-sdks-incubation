interface GeneratedPackage {
	readonly name: string;
	readonly packageId: string;
}

interface GeneratedSuiNetwork {
	readonly rpcUrl: string;
	readonly faucetUrl: string;
	readonly chainId: string;
}

interface GeneratedDappKitConfig {
	readonly chain: string;
	readonly walletUrl: string;
	readonly pairUrl: string;
}

interface DAppKitSetup {
	readonly network: string;
	readonly rpcUrl: string;
	readonly walletOrigin: string;
	readonly pairUrl: string;
}

export const packages = {
	connect_four: {
		name: 'connect_four',
		packageId: '0xabc',
	} satisfies GeneratedPackage,
};

export const suiNetwork = {
	rpcUrl: 'http://127.0.0.1:9000',
	faucetUrl: 'http://127.0.0.1:9123',
	chainId: 'localnet',
} satisfies GeneratedSuiNetwork;

export const dappKitConfig = {
	chain: 'localnet',
	walletUrl: 'http://wallet.localhost:9100',
	pairUrl: 'http://wallet.localhost:9100/#token=dev',
} satisfies GeneratedDappKitConfig;

const useGeneratedAppFiles = (): DAppKitSetup => ({
	network: dappKitConfig.chain,
	rpcUrl: suiNetwork.rpcUrl,
	walletOrigin: dappKitConfig.walletUrl,
	pairUrl: dappKitConfig.pairUrl,
});

const buildCreateLobbyTarget = (): string =>
	`${packages.connect_four.packageId}::game::create_lobby`;

export const publicAppUsage = {
	dappKit: useGeneratedAppFiles(),
	createLobbyTarget: buildCreateLobbyTarget(),
};
