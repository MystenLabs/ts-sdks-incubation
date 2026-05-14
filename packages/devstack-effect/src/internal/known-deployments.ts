// Static registry of well-known deployments (packageIds, registry IDs, key
// servers, etc.) for major Sui networks. Updated per release as protocols
// evolve. The `*Known*` factories default to these values; consumers can
// override per call.
//
// Sources for these values are tracked in `notes/known-deployments-source.md`.
// When updating, also update the source-tracking doc with the date and
// verification method.

/**
 * Static registry of well-known on-chain deployments for testnet / mainnet.
 *
 * **INTEGRITY**: this file is the single source of truth for testnet/mainnet
 * package IDs across devstack-effect consumers. A malicious update to this
 * file would silently redirect every `*KnownPackage()` / `*KnownDeployment()`
 * factory to an attacker-controlled address. Verify changes here against
 * official Mysten sources (Mysten registry, Walrus testnet docs, Seal key
 * server announcements) before merging. See `notes/known-deployments-source.md`
 * for the per-value provenance log.
 *
 * **Walrus committee `nodes`** are intentionally *not* statically registered.
 * Testnet has 100+ storage nodes and the upstream `@mysten/walrus` SDK
 * fetches the committee dynamically from the staking pool. Consumers that
 * need the committee must either supply `nodes` explicitly to
 * `walrusKnownDeployment(...)` or use `walrusLocalCluster()` for local
 * testing — calling `walrusKnownDeployment({ network: 'testnet' })` without
 * an explicit committee throws at factory time.
 *
 * **Seal `publicKey`** is intentionally *not* statically registered. The
 * upstream `@mysten/seal` SDK retrieves it dynamically from the key
 * server's `/v1/service` HTTP endpoint, so pinning a value here would be
 * misleading. Consumers that need to verify the BLS public key should
 * fetch it from `<keyServerUrl>/v1/service` at runtime.
 */

/** Sui network identifier used as the key into each per-service map. */
export type KnownNetwork = 'testnet' | 'mainnet' | 'devnet';

/** SDK-aligned coin entry. Mirrors `@mysten/deepbook-v3`'s `Coin` shape
 *  (`packages/deepbook-v3/src/types/coin.ts` upstream); the optional
 *  Pyth fields are surfaced verbatim so consumers can pass values from
 *  here directly to deepbook's `DeepBookClient`. */
export interface DeepbookCoinEntry {
	readonly address: string;
	readonly type: string;
	readonly scalar: number;
	readonly feed?: string;
	readonly currencyId?: string;
	readonly priceInfoObjectId?: string;
}

/** SDK-aligned pool entry. Mirrors `@mysten/deepbook-v3`'s `Pool` shape. */
export interface DeepbookPoolEntry {
	readonly address: string;
	readonly baseCoin: string;
	readonly quoteCoin: string;
}

/** SDK-aligned margin-pool entry. Mirrors `@mysten/deepbook-v3`'s
 *  `MarginPool` shape (`{ address, type }`). */
export interface DeepbookMarginPoolEntry {
	readonly address: string;
	readonly type: string;
}

/** SDK-aligned Pyth state ids. Mirrors `testnetPythConfigs` /
 *  `mainnetPythConfigs` upstream. */
export interface DeepbookPythConfig {
	readonly pythStateId: string;
	readonly wormholeStateId: string;
}

/** DeepBook v3 canonical addresses on a given network. Field names use
 *  camelCase in the registry (TypeScript convention); the deepbook
 *  factories project them to SCREAMING_SNAKE_CASE for the SDK-ready
 *  `packageIds` view on `DeepbookCoreShape`.
 *
 *  Static `coins` / `pools` / `marginPools` / `pyth` maps are snapshots
 *  of the corresponding `testnet*` / `mainnet*` constants in
 *  `@mysten/deepbook-v3/utils/constants.ts`. Consumers that need a
 *  coin not listed here can supply additional entries via the factory's
 *  options or import the full lists from `@mysten/deepbook-v3`
 *  directly. */
export interface DeepbookDeployment {
	readonly packageId: string;
	readonly registryId: string;
	readonly deepTreasuryId: string;
	readonly marginPackageId: string | undefined;
	readonly marginRegistryId: string | undefined;
	readonly liquidationPackageId: string | undefined;
	readonly coins?: Record<string, DeepbookCoinEntry>;
	readonly pools?: Record<string, DeepbookPoolEntry>;
	readonly marginPools?: Record<string, DeepbookMarginPoolEntry>;
	readonly pyth?: DeepbookPythConfig;
}

/** Walrus storage-network canonical addresses + public endpoints. */
export interface WalrusDeployment {
	/**
	 * On-chain Walrus System object id (NOT a Move package id). Matches
	 * `WalrusPackageConfig.systemObjectId` in `@mysten/walrus` — the SDK
	 * derives the actual Move package id at runtime from the system
	 * object's type.
	 */
	readonly systemObjectId: string;
	readonly stakingPoolId: string;
	/**
	 * Subsidies is an admin/governance concern; the `@mysten/walrus` SDK
	 * does not surface a hardcoded subsidies package id. Both registered
	 * networks leave this `undefined` — typical blob-read/write consumers
	 * never need it.
	 */
	readonly subsidiesPackageId: string | undefined;
	/** WAL exchange contracts (testnet only). Mainnet doesn't expose these in the SDK. */
	readonly exchangeIds?: ReadonlyArray<string>;
	/**
	 * Storage-node committee. Optional in the registry because testnet
	 * has 100+ nodes that are fetched dynamically from the staking pool
	 * by the `@mysten/walrus` SDK; there's no static list to pin.
	 * `walrusKnownDeployment` requires callers to supply this explicitly
	 * when targeting a registered network.
	 */
	readonly nodes?: ReadonlyArray<{
		readonly nodeId: string;
		readonly url: string;
		readonly publicKey: string;
	}>;
	readonly aggregatorUrl: string;
	readonly publisherUrl: string;
}

/** Seal key-server canonical registration on a given network. */
export interface SealDeployment {
	readonly keyServerObjectId: string;
	readonly keyServerUrl: string;
}

/** Top-level registry: per-service partial map keyed by network. */
export interface KnownDeployments {
	readonly deepbook: Partial<Record<KnownNetwork, DeepbookDeployment>>;
	readonly walrus: Partial<Record<KnownNetwork, WalrusDeployment>>;
	readonly seal: Partial<Record<KnownNetwork, SealDeployment>>;
}

export const knownDeployments: KnownDeployments = {
	deepbook: {
		// Sourced from `packages/devstack/src/plugins/deepbook.ts`, copied
		// originally from `@mysten/deepbook-v3/utils/constants.ts`.
		// TODO: confirm against the latest Mysten registry.
		testnet: {
			packageId: '0x22be4cade64bf2d02412c7e8d0e8beea2f78828b948118d46735315409371a3c',
			registryId: '0x7c256edbda983a2cd6f946655f4bf3f00a41043993781f8674a7046e8c0e11d1',
			deepTreasuryId: '0x69fffdae0075f8f71f4fa793549c11079266910e8905169845af1f5d00e09dcb',
			marginPackageId: '0xd6a42f4df4db73d68cbeb52be66698d2fe6a9464f45ad113ca52b0c6ebd918b6',
			marginRegistryId: '0x48d7640dfae2c6e9ceeada197a7a1643984b5a24c55a0c6c023dac77e0339f75',
			liquidationPackageId: '0x8d69c3ef3ef580e5bf87b933ce28de19a5d0323588d1a44b9c60b4001741aa24',
			// `coins` / `pools` / `marginPools` / `pyth` snapshotted verbatim
			// from `@mysten/deepbook-v3/utils/constants.ts` (`testnetCoins`,
			// `testnetPools`, `testnetMarginPools`, `testnetPythConfigs`) —
			// verified 2026-05-13 against the sibling ts-sdks checkout at
			// `/Users/michaelhayes/code/ts-sdks/packages/deepbook-v3/src/utils/constants.ts`.
			coins: {
				DEEP: {
					address: '0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8',
					type: '0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP',
					scalar: 1_000_000,
					feed: '0x99137a18354efa7fb6840889d059fdb04c46a6ce21be97ab60d9ad93e91ac758',
					currencyId: '0xbf1b77e244f649c736a44898585cc8ac939fbb0bbdf1d8d2a183978cc312e613',
					priceInfoObjectId: '0x3d52fffa2cd9e54b39bb36d282bdda560b15b8b4fdf4766a3c58499ef172bafc',
				},
				SUI: {
					address: '0x0000000000000000000000000000000000000000000000000000000000000002',
					type: '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI',
					scalar: 1_000_000_000,
					feed: '0x50c67b3fd225db8912a424dd4baed60ffdde625ed2feaaf283724f9608fea266',
					currencyId: '0xf256d3fb6a50eaa748d94335b34f2982fbc3b63ceec78cafaa29ebc9ebaf2bbc',
					priceInfoObjectId: '0x1ebb295c789cc42b3b2a1606482cd1c7124076a0f5676718501fda8c7fd075a0',
				},
				DBUSDC: {
					address: '0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7',
					type: '0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC',
					scalar: 1_000_000,
					feed: '0x41f3625971ca2ed2263e78573fe5ce23e13d2558ed3f2e47ab0f84fb9e7ae722',
					currencyId: '0x509db0f9283c9ee4fdc5b99028a439d3639f49e9709e3d7a6de14b3bfdb0c784',
					priceInfoObjectId: '0x9c4dd4008297ffa5e480684b8100ec21cc934405ed9a25d4e4d7b6259aad9c81',
				},
				DBTC: {
					address: '0x6502dae813dbe5e42643c119a6450a518481f03063febc7e20238e43b6ea9e86',
					type: '0x6502dae813dbe5e42643c119a6450a518481f03063febc7e20238e43b6ea9e86::dbtc::DBTC',
					scalar: 100_000_000,
					feed: '0xf9c0172ba10dfa4d19088d94f5bf61d3b54d5bd7483a322a982e1373ee8ea31b',
					currencyId: '0x3ef2afa2126704bf721b9c8495d94288f6bd090fc454fe3e1613eb765a8a348f',
					priceInfoObjectId: '0x72431a238277695d3f31e4425225a4462674ee6cceeea9d66447b210755fffba',
				},
				DBUSDT: {
					address: '0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7',
					type: '0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDT::DBUSDT',
					scalar: 1_000_000,
				},
				WAL: {
					address: '0x9ef7676a9f81937a52ae4b2af8d511a28a0b080477c0c2db40b0ab8882240d76',
					type: '0x9ef7676a9f81937a52ae4b2af8d511a28a0b080477c0c2db40b0ab8882240d76::wal::WAL',
					scalar: 1_000_000_000,
				},
			},
			pools: {
				DEEP_SUI: {
					address: '0x48c95963e9eac37a316b7ae04a0deb761bcdcc2b67912374d6036e7f0e9bae9f',
					baseCoin: 'DEEP',
					quoteCoin: 'SUI',
				},
				SUI_DBUSDC: {
					address: '0x1c19362ca52b8ffd7a33cee805a67d40f31e6ba303753fd3a4cfdfacea7163a5',
					baseCoin: 'SUI',
					quoteCoin: 'DBUSDC',
				},
				DEEP_DBUSDC: {
					address: '0xe86b991f8632217505fd859445f9803967ac84a9d4a1219065bf191fcb74b622',
					baseCoin: 'DEEP',
					quoteCoin: 'DBUSDC',
				},
				DBUSDT_DBUSDC: {
					address: '0x83970bb02e3636efdff8c141ab06af5e3c9a22e2f74d7f02a9c3430d0d10c1ca',
					baseCoin: 'DBUSDT',
					quoteCoin: 'DBUSDC',
				},
				WAL_DBUSDC: {
					address: '0xeb524b6aea0ec4b494878582e0b78924208339d360b62aec4a8ecd4031520dbb',
					baseCoin: 'WAL',
					quoteCoin: 'DBUSDC',
				},
				WAL_SUI: {
					address: '0x8c1c1b186c4fddab1ebd53e0895a36c1d1b3b9a77cd34e607bef49a38af0150a',
					baseCoin: 'WAL',
					quoteCoin: 'SUI',
				},
				DBTC_DBUSDC: {
					address: '0x0dce0aa771074eb83d1f4a29d48be8248d4d2190976a5241f66b43ec18fa34de',
					baseCoin: 'DBTC',
					quoteCoin: 'DBUSDC',
				},
			},
			marginPools: {
				SUI: {
					address: '0xcdbbe6a72e639b647296788e2e4b1cac5cea4246028ba388ba1332ff9a382eea',
					type: '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI',
				},
				DBUSDC: {
					address: '0xf08568da93834e1ee04f09902ac7b1e78d3fdf113ab4d2106c7265e95318b14d',
					type: '0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC',
				},
				DEEP: {
					address: '0x610640613f21d9e688d6f8103d17df22315c32e0c80590ce64951a1991378b55',
					type: '0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP',
				},
				DBTC: {
					address: '0xf3440b4aafcc8b12fc4b242e9590c52873b8238a0d0e52fbf9dae61d2970796a',
					type: '0x6502dae813dbe5e42643c119a6450a518481f03063febc7e20238e43b6ea9e86::dbtc::DBTC',
				},
			},
			pyth: {
				pythStateId: '0x243759059f4c3111179da5878c12f68d612c21a8d54d85edc86164bb18be1c7c',
				wormholeStateId: '0x31358d198147da50db32eda2562951d53973a0c0ad5ed738e9b17d88b213d790',
			},
		},
		mainnet: {
			packageId: '0xf48222c4e057fa468baf136bff8e12504209d43850c5778f76159292a96f621e',
			registryId: '0xaf16199a2dff736e9f07a845f23c5da6df6f756eddb631aed9d24a93efc4549d',
			deepTreasuryId: '0x032abf8948dda67a271bcc18e776dbbcfb0d58c8d288a700ff0d5521e57a1ffe',
			marginPackageId: '0xfbd322126f1452fd4c89aedbaeb9fd0c44df9b5cedbe70d76bf80dc086031377',
			marginRegistryId: '0x0e40998b359a9ccbab22a98ed21bd4346abf19158bc7980c8291908086b3a742',
			liquidationPackageId: '0x55718c06706bee34c9f3c39f662f10be354a4dcc719699ad72091dc343b641b8',
			// Mainnet maps mirror `mainnetCoins` / `mainnetPools` /
			// `mainnetMarginPools` / `mainnetPythConfigs` upstream — verified
			// 2026-05-13 against the sibling ts-sdks checkout.
			coins: {
				DEEP: {
					address: '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270',
					type: '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP',
					scalar: 1_000_000,
					feed: '0x29bdd5248234e33bd93d3b81100b5fa32eaa5997843847e2c2cb16d7c6d9f7ff',
					currencyId: '0x3f2afb7c5f245870a8b8a3808e6dd7042446a0e7504e9d2795372da053858cd9',
					priceInfoObjectId: '0x8c7f3a322b94cc69db2a2ac575cbd94bf5766113324c3a3eceac91e3e88a51ed',
				},
				SUI: {
					address: '0x0000000000000000000000000000000000000000000000000000000000000002',
					type: '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI',
					scalar: 1_000_000_000,
					feed: '0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744',
					currencyId: '0xf256d3fb6a50eaa748d94335b34f2982fbc3b63ceec78cafaa29ebc9ebaf2bbc',
					priceInfoObjectId: '0x801dbc2f0053d34734814b2d6df491ce7807a725fe9a01ad74a07e9c51396c37',
				},
				USDC: {
					address: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7',
					type: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
					scalar: 1_000_000,
					feed: '0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
					currencyId: '0x75cfbbf8c962d542e99a1d15731e6069f60a00db895407785b15d14f606f2b4a',
					priceInfoObjectId: '0x5dec622733a204ca27f5a90d8c2fad453cc6665186fd5dff13a83d0b6c9027ab',
				},
				WAL: {
					address: '0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59',
					type: '0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL',
					scalar: 1_000_000_000,
					feed: '0xeba0732395fae9dec4bae12e52760b35fc1c5671e2da8b449c9af4efe5d54341',
					currencyId: '0xb6a0c0bacb1c87c3be4dff20c22ef1012125b5724b5b0ff424f852a2651b23fa',
					priceInfoObjectId: '0xeb7e669f74d976c0b99b6ef9801e3a77716a95f1a15754e0f1399ce3fb60973d',
				},
				// `mainnetCoins` carries additional entries (SUIUSDE, XBTC,
				// USDSUI, WUSDC, WETH, BETH, WBTC, WUSDT, NS, TYPUS, AUSD,
				// DRF, SEND, IKA, ALKIMI, LZWBTC, USDT). Consumers that need
				// any of them can import `mainnetCoins` from
				// `@mysten/deepbook-v3` directly — this snapshot is the
				// minimal-but-useful subset (DEEP, SUI, USDC, WAL).
			},
			pools: {
				DEEP_SUI: {
					address: '0xb663828d6217467c8a1838a03793da896cbe745b150ebd57d82f814ca579fc22',
					baseCoin: 'DEEP',
					quoteCoin: 'SUI',
				},
				SUI_USDC: {
					address: '0xe05dafb5133bcffb8d59f4e12465dc0e9faeaa05e3e342a08fe135800e3e4407',
					baseCoin: 'SUI',
					quoteCoin: 'USDC',
				},
				DEEP_USDC: {
					address: '0xf948981b806057580f91622417534f491da5f61aeaf33d0ed8e69fd5691c95ce',
					baseCoin: 'DEEP',
					quoteCoin: 'USDC',
				},
				WAL_USDC: {
					address: '0x56a1c985c1f1123181d6b881714793689321ba24301b3585eec427436eb1c76d',
					baseCoin: 'WAL',
					quoteCoin: 'USDC',
				},
				WAL_SUI: {
					address: '0x81f5339934c83ea19dd6bcc75c52e83509629a5f71d3257428c2ce47cc94d08b',
					baseCoin: 'WAL',
					quoteCoin: 'SUI',
				},
			},
			marginPools: {
				SUI: {
					address: '0x53041c6f86c4782aabbfc1d4fe234a6d37160310c7ee740c915f0a01b7127344',
					type: '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI',
				},
				USDC: {
					address: '0xba473d9ae278f10af75c50a8fa341e9c6a1c087dc91a3f23e8048baf67d0754f',
					type: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
				},
				DEEP: {
					address: '0x1d723c5cd113296868b55208f2ab5a905184950dd59c48eb7345607d6b5e6af7',
					type: '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP',
				},
				WAL: {
					address: '0x38decd3dbb62bd4723144349bf57bc403b393aee86a51596846a824a1e0c2c01',
					type: '0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL',
				},
			},
			pyth: {
				pythStateId: '0x1f9310238ee9298fb703c3419030b35b22bb1cc37113e3bb5007c99aec79e5b8',
				wormholeStateId: '0xaeab97f96cf9877fee2883315d459552b2b921edc16d7ceac6eab944dd88919c',
			},
		},
		// devnet: no canonical deepbook-v3 deployment; consumers publish
		// the source themselves via the localnet primitive.
	},
	walrus: {
		// `systemObjectId` / `stakingPoolId` / `exchangeIds` sourced from
		// `@mysten/walrus/src/constants.ts` (`TESTNET_WALRUS_PACKAGE_CONFIG`,
		// `MAINNET_WALRUS_PACKAGE_CONFIG`) — verified 2026-05-13 against
		// the sibling ts-sdks checkout at
		// `/Users/michaelhayes/code/ts-sdks/packages/walrus/src/constants.ts`.
		// The SDK does not carry a Move `packageId` separately — it derives
		// the package from the System object's type via on-chain query.
		// Aggregator/publisher URLs cross-checked against the upstream
		// seal example app's vercel.json rewrites.
		testnet: {
			systemObjectId: '0x6c2547cbbc38025cf3adac45f63cb0a8d12ecf777cdc75a4971612bf97fdf6af',
			stakingPoolId: '0xbe46180321c30aab2f8b3501e24048377287fa708018a5b7c2792b35fe339ee3',
			subsidiesPackageId: undefined,
			exchangeIds: [
				'0xf4d164ea2def5fe07dc573992a029e010dba09b1a8dcbc44c5c2e79567f39073',
				'0x19825121c52080bb1073662231cfea5c0e4d905fd13e95f21e9a018f2ef41862',
				'0x83b454e524c71f30803f4d6c302a86fb6a39e96cdfb873c2d1e93bc1c26a3bc5',
				'0x8d63209cf8589ce7aef8f262437163c67577ed09f3e636a9d8e0813843fb8bf1',
			],
			aggregatorUrl: 'https://aggregator.walrus-testnet.walrus.space',
			publisherUrl: 'https://publisher.walrus-testnet.walrus.space',
		},
		mainnet: {
			systemObjectId: '0x2134d52768ea07e8c43570ef975eb3e4c27a39fa6396bef985b5abc58d03ddd2',
			stakingPoolId: '0x10b9d30c28448939ce6c4d6c6e0ffce4a7f8a4ada8248bdad09ef8b70e4a3904',
			subsidiesPackageId: undefined,
			aggregatorUrl: 'https://aggregator.walrus.space',
			publisherUrl: 'https://publisher.walrus.space',
		},
		// devnet: walrus has no canonical devnet deployment.
	},
	seal: {
		// `keyServerObjectId` + `keyServerUrl` for the `mysten-testnet-1`
		// Open-mode independent server. Sourced from the upstream seal
		// docs vendored under
		// `examples/private-content/.devstack/imports/mystenlabs_seal@seal-v0.6.6/docs/content/Pricing.mdx`.
		// `publicKey` intentionally omitted — the @mysten/seal client
		// retrieves it dynamically from `<keyServerUrl>/v1/service`.
		testnet: {
			keyServerObjectId: '0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75',
			keyServerUrl: 'https://seal-key-server-testnet-1.mystenlabs.com',
		},
		// mainnet: Mysten doesn't ship a public default key server on
		// mainnet — production usage is via Enoki signup
		// (https://enoki.mystenlabs.com/) or a third-party provider
		// (Ruby Nodes, NodeInfra, Overclock, etc — see seal Pricing.mdx).
		// No canonical (keyServerObjectId, keyServerUrl) tuple to pin;
		// consumers must pass explicit overrides.
		// devnet: no public seal deployment.
	},
};
