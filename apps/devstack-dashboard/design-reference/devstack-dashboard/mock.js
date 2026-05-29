/* ============================================================
   mock.js — fake devstack projection + simulated SSE stream
   Plain JS. Publishes window.DS (data) and window.DSBus (live tick).
   Mirrors the real shapes: SubscribableState, Row, Endpoint,
   AccountProjection, PackageProjection, EngineEvent, LogLine, Span.
   ============================================================ */
(function () {
  const now = () => Date.now();
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const hex = (n) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
  const addr = () => "0x" + hex(62) + pick(["a1", "5c", "9f", "d3", "07", "e2"]);
  const digest = () => {
    const cs = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz123456789";
    return Array.from({ length: 44 }, () => cs[Math.floor(Math.random() * cs.length)]).join("");
  };

  /* ---------- identity + cycle ---------- */
  const identity = {
    name: "sui-localnet",
    network: "local",
    mode: "local",            // local | fork | live
    chainId: "0x" + hex(8),
    workdir: "~/dev/sui-incubation/.devstack",
    startedAt: now() - 1000 * 60 * 42,
    version: "0.9.4",
  };

  const cycle = { id: 7, phase: "running", since: now() - 1000 * 60 * 12, generation: 7 };

  /* ---------- endpoints ---------- */
  const endpoints = [
    { key: "sui.rpc",        plugin: "sui",       label: "JSON-RPC",      url: "http://127.0.0.1:9124",  wire: "http",  scope: "service" },
    { key: "sui.graphql",    plugin: "sui",       label: "GraphQL",       url: "http://127.0.0.1:9125/graphql", wire: "http", scope: "service" },
    { key: "sui.faucet",     plugin: "faucet",    label: "Faucet",        url: "http://127.0.0.1:9123/gas", wire: "http", scope: "service" },
    { key: "sui.indexer",    plugin: "postgres",  label: "Indexer",       url: "http://127.0.0.1:9126",  wire: "grpc",  scope: "service" },
    { key: "wallet.ui",      plugin: "wallet",    label: "Dev Wallet",    url: "http://wallet.localhost", wire: "http", scope: "service" },
    { key: "dashboard.ui",   plugin: "dashboard", label: "Dashboard",     url: "http://dash.localhost",  wire: "http",  scope: "service" },
    { key: "walrus.agg",     plugin: "walrus",    label: "Aggregator",    url: "http://127.0.0.1:9131",  wire: "http",  scope: "service" },
    { key: "walrus.pub",     plugin: "walrus",    label: "Publisher",     url: "http://127.0.0.1:9132",  wire: "http",  scope: "service" },
    { key: "deepbook.rpc",   plugin: "deepbook",  label: "DeepBook API",  url: "http://127.0.0.1:9140",  wire: "http",  scope: "service" },
    { key: "pg.dsn",         plugin: "postgres",  label: "Postgres",      url: "postgres://localhost:5432/devstack", wire: "tcp", scope: "service" },
  ];

  /* ---------- rows (services / plugins) ---------- */
  // status: ready | active | failed | acquiring | idle | blocked
  // section: core | service | plugin | infra
  const rows = [
    { key: "sui",       title: "Sui Node",        section: "core",  role: "node",     status: "ready",     phase: "Serving RPC + GraphQL",        owner: "system", endpoints: ["sui.rpc", "sui.graphql"], logTail: "checkpoint 18,442 committed", err: null, uptime: 42 },
    { key: "postgres",  title: "Indexer (PG)",    section: "infra", role: "datastore","status": "ready",   phase: "Indexing checkpoints",         owner: "system", endpoints: ["sui.indexer", "pg.dsn"], logTail: "ingested 18,442 / 18,442", err: null, uptime: 42 },
    { key: "router",    title: "Router",          section: "infra", role: "proxy",    status: "ready",     phase: "12 routes applied",            owner: "system", endpoints: [], logTail: "reloaded config (rev 12)", err: null, uptime: 42 },
    { key: "faucet",    title: "Faucet",          section: "service",role: "service", status: "ready",     phase: "Funding enabled",              owner: "system", endpoints: ["sui.faucet"], logTail: "dispensed 100 SUI → 0x9f…a1", err: null, uptime: 41 },
    { key: "wallet",    title: "Dev Wallet",      section: "service",role: "service", status: "ready",     phase: "Adapter paired",               owner: "system", endpoints: ["wallet.ui"], logTail: "session token rotated", err: null, uptime: 41 },
    { key: "dashboard", title: "Dashboard",       section: "service",role: "service", status: "active",    phase: "12 clients streaming",          owner: "system", endpoints: ["dashboard.ui"], logTail: "SSE client connected", err: null, uptime: 12 },
    { key: "deepbook",  title: "DeepBook",        section: "plugin", role: "plugin",  status: "ready",     phase: "4 pools seeded",               owner: "0x5c…e2", endpoints: ["deepbook.rpc"], logTail: "seeded SUI/USDC liquidity", err: null, uptime: 38 },
    { key: "walrus",    title: "Walrus",          section: "plugin", role: "plugin",  status: "active",    phase: "Reconfiguring cluster",        owner: "0xd3…07", endpoints: ["walrus.agg", "walrus.pub"], logTail: "node 3/5 rejoining committee", err: null, uptime: 38 },
    { key: "seal",      title: "Seal",            section: "plugin", role: "plugin",  status: "acquiring", phase: "Starting key-server",          owner: "0x07…9f", endpoints: [], logTail: "awaiting key-server health", err: null, uptime: 0 },
    { key: "coin",      title: "Coin Registry",   section: "plugin", role: "registry",status: "ready",     phase: "5 coins registered",           owner: "system", endpoints: [], logTail: "registered DEEP treasury cap", err: null, uptime: 40 },
    { key: "package",   title: "Package Publisher",section: "plugin",role: "registry",status: "failed",    phase: "Publish reverted",             owner: "0xe2…d3", endpoints: [], logTail: "Move verifier rejected module", err: { code: "PublishFailed", summary: "Move verifier rejected `escrow::settle` — invalid signer arg.", hint: "Check entry function visibility." }, uptime: 0 },
  ];

  /* ---------- accounts ---------- */
  const accounts = [
    { name: "deployer",   address: addr(), scheme: "ed25519",   source: "config",      walletVisible: true,  funding: { status: "funded",  balanceMist: 100e9, requestedMist: 100e9 } },
    { name: "alice",      address: addr(), scheme: "ed25519",   source: "config",      walletVisible: true,  funding: { status: "funded",  balanceMist: 50e9,  requestedMist: 50e9 } },
    { name: "bob",        address: addr(), scheme: "secp256k1", source: "config",      walletVisible: true,  funding: { status: "funded",  balanceMist: 50e9,  requestedMist: 50e9 } },
    { name: "treasury",   address: addr(), scheme: "ed25519",   source: "derived",     walletVisible: false, funding: { status: "cached",  balanceMist: 1000e9,requestedMist: 1000e9 } },
    { name: "mm-bot",     address: addr(), scheme: "ed25519",   source: "plugin",      walletVisible: false, funding: { status: "pending", balanceMist: 0,     requestedMist: 25e9 } },
    { name: "whale.sui",  address: addr(), scheme: "ed25519",   source: "impersonate", walletVisible: true,  funding: { status: "skipped", balanceMist: 8.4e12,requestedMist: 0 } },
  ];

  /* ---------- packages ---------- */
  const packages = [
    { name: "escrow",      id: addr(), plugin: "package",  kind: "ours",     modules: ["escrow", "settle", "events"], upgradeCap: addr(), publisher: "deployer", version: 3, objects: 4, sourcePath: "move/escrow" },
    { name: "deepbook",    id: addr(), plugin: "deepbook", kind: "ours",     modules: ["pool", "order", "vault", "math"], upgradeCap: addr(), publisher: "deployer", version: 1, objects: 11, sourcePath: "vendor/deepbook" },
    { name: "token_vault", id: addr(), plugin: "package",  kind: "ours",     modules: ["vault", "shares"], upgradeCap: addr(), publisher: "alice", version: 2, objects: 3, sourcePath: "move/vault" },
    { name: "sui_system",  id: "0x3", plugin: null,        kind: "system",   modules: ["sui_system", "validator", "staking_pool"], upgradeCap: null, publisher: "—", version: 1, objects: 0, sourcePath: null },
    { name: "std",         id: "0x1", plugin: null,        kind: "system",   modules: ["option", "vector", "string"], upgradeCap: null, publisher: "—", version: 1, objects: 0, sourcePath: null },
  ];

  /* ---------- coins ---------- */
  const coins = [
    { symbol: "SUI",  decimals: 9, type: "0x2::sui::SUI",        supply: "10,000,000,000", treasuryCap: null,    faucet: true,  icon: "◎" },
    { symbol: "USDC", decimals: 6, type: "0x…::usdc::USDC",      supply: "5,000,000",      treasuryCap: addr(),  faucet: false, icon: "$" },
    { symbol: "DEEP", decimals: 6, type: "0x…::deep::DEEP",      supply: "10,000,000",     treasuryCap: addr(),  faucet: true,  icon: "◆" },
    { symbol: "WAL",  decimals: 9, type: "0x…::wal::WAL",        supply: "1,000,000",      treasuryCap: addr(),  faucet: true,  icon: "▲" },
    { symbol: "NS",   decimals: 6, type: "0x…::ns::NS",          supply: "500,000",        treasuryCap: addr(),  faucet: false, icon: "✦" },
  ];

  /* ---------- snapshots ---------- */
  const snapshots = [
    { id: "snap_" + hex(6), label: "after-seed",        createdAt: now() - 1000 * 60 * 30, participants: 11, containers: 3, hostTree: true,  sizeMb: 184 },
    { id: "snap_" + hex(6), label: "clean-genesis",     createdAt: now() - 1000 * 60 * 80, participants: 11, containers: 3, hostTree: true,  sizeMb: 96 },
    { id: "snap_" + hex(6), label: "deepbook-pools",    createdAt: now() - 1000 * 60 * 120,participants: 11, containers: 3, hostTree: false, sizeMb: 142 },
  ];

  /* ---------- logs (per tag ring buffers) ---------- */
  const LEVELS = ["info", "info", "info", "debug", "warn", "error"];
  const LOG_SEEDS = {
    sui:       ["checkpoint {n} committed", "executed tx {d}", "epoch 0 — gas price 1000", "reconfiguration skipped", "consensus round {n}"],
    postgres:  ["ingested checkpoint {n}", "objects upserted: {n}", "lag 0 checkpoints", "analyze tx_calls", "pruned epoch table"],
    faucet:    ["dispensed 100 SUI → {a}", "rate-limit window reset", "balance 8.4M SUI remaining", "request queued"],
    walrus:    ["node 3/5 rejoining committee", "blob {d} certified", "shard transfer 12%", "aggregator cache warm"],
    deepbook:  ["seeded SUI/USDC liquidity", "order {d} placed", "pool SUI/DEEP rebalanced", "pyth feed fresh (120ms)"],
    seal:      ["awaiting key-server health", "key-server probe failed", "retrying in 2s", "policy set loaded"],
    package:   ["Move verifier rejected module", "publish reverted", "compiling escrow.move", "bytecode verified"],
    router:    ["reloaded config (rev {n})", "route dashboard.localhost → :{p}", "TLS skipped (loopback)"],
    dashboard: ["SSE client connected", "SSE client disconnected", "state frame pushed", "command restart acked"],
  };
  const logs = {};
  Object.keys(LOG_SEEDS).forEach((tag) => {
    logs[tag] = [];
    for (let i = 0; i < 18; i++) {
      logs[tag].push(makeLog(tag, now() - (18 - i) * rnd(2000, 9000)));
    }
  });
  function makeLog(tag, at) {
    const lvl = tag === "seal" ? pick(["warn", "error", "info"]) : (tag === "package" ? pick(["error", "warn"]) : pick(LEVELS));
    let msg = pick(LOG_SEEDS[tag] || ["heartbeat ok"]);
    msg = msg.replace("{n}", (18000 + Math.floor(rnd(0, 600))).toLocaleString())
             .replace("{d}", digest().slice(0, 10) + "…")
             .replace("{a}", "0x" + hex(2) + "…" + hex(2))
             .replace("{p}", String(Math.floor(rnd(9120, 9150))));
    const plugin = tag;
    return { id: "log_" + hex(8), tag, plugin, level: lvl, message: msg, at, fields: lvl === "error" ? { code: "E_" + hex(4), retry: true } : null };
  }

  /* ---------- events (EngineEvent feed) ---------- */
  const EVENT_KINDS = [
    { tag: "log.appended",          scope: "service", color: "white"   },
    { tag: "endpoint.registered",   scope: "service", color: "cyan"    },
    { tag: "lifecycle.transition",  scope: "core",    color: "yellow"  },
    { tag: "account.funded",        scope: "account", color: "magenta" },
    { tag: "package.published",     scope: "package", color: "blue"    },
    { tag: "snapshot.progress",     scope: "infra",   color: "blue"    },
    { tag: "command.acked",         scope: "core",    color: "green"   },
    { tag: "error.reported",        scope: "core",    color: "red"     },
  ];
  const EVENT_MSGS = {
    "log.appended":         () => `${pick(rows).key}: ${pick(["checkpoint committed", "tx executed", "config reloaded"])}`,
    "endpoint.registered":  () => `${pick(endpoints).key} → ${pick(endpoints).url}`,
    "lifecycle.transition": () => `${pick(rows).key}: ${pick(["acquiring → ready", "ready → active", "active → ready"])}`,
    "account.funded":       () => `${pick(accounts).name} ← 100 SUI (faucet)`,
    "package.published":    () => `${pick(["escrow", "token_vault"])} v${Math.floor(rnd(1, 4))} @ 0x${hex(2)}…${hex(2)}`,
    "snapshot.progress":    () => `capture: ${pick(["quiescing", "dumping pg", "archiving host-tree", "complete"])}`,
    "command.acked":        () => `${pick(["restart", "apply", "codegen", "snapshot.capture"])} acknowledged`,
    "error.reported":       () => `package: Move verifier rejected module`,
  };
  const events = [];
  for (let i = 0; i < 26; i++) events.push(makeEvent(now() - (26 - i) * rnd(1500, 7000)));
  function makeEvent(at) {
    const k = pick(EVENT_KINDS);
    return { id: "ev_" + hex(8), tag: k.tag, scope: k.scope, color: k.color, message: EVENT_MSGS[k.tag](), plugin: pick(rows).key, at };
  }

  /* ---------- spans (traces) ---------- */
  const OPS = ["plugin.acquire", "endpoint.register", "publish.move", "snapshot.capture", "rpc.call", "graphql.query", "index.checkpoint"];
  const spans = [];
  for (let i = 0; i < 14; i++) {
    const plugin = pick(rows).key;
    const dur = rnd(4, 880);
    spans.push({ id: "sp_" + hex(8), op: pick(OPS), plugin, endpoint: pick(endpoints).key, durMs: dur, at: now() - rnd(1000, 40000), status: Math.random() > 0.85 ? "error" : "ok", cycle: cycle.id });
  }
  spans.sort((a, b) => b.at - a.at);

  /* network stats (explorer) */
  const netStats = {
    epoch: 0, epochProgress: 0.62, tps: 0, totalTx: 18877, gasPrice: 1000,
    totalStaked: "0", checkpoint: 18442, accounts: 6, packages: 5,
  };

  /* recent chain txs (explorer) */
  const txs = Array.from({ length: 12 }, (_, i) => ({
    digest: digest(), sender: pick(accounts).name, kind: pick(["ProgrammableTransaction", "Publish", "Call"]),
    status: Math.random() > 0.92 ? "failure" : "success", gas: Math.floor(rnd(980, 4200)),
    at: now() - i * rnd(2000, 12000), checkpoint: 18442 - i,
  }));

  /* ---------- per-plugin domain data ---------- */
  const pluginData = {
    deepbook: {
      registryId: addr(), adminCap: addr(), packageId: addr(), deepFunded: 25000,
      mmRunning: true, spreadBps: 12,
      pools: [
        { id: addr(), pair: "SUI / USDC", price: 1.842, chg: +2.31, tick: 0.001, lot: 0.1, min: 1, depth: "412K", trades: 1284 },
        { id: addr(), pair: "DEEP / SUI", price: 0.0218, chg: -1.04, tick: 0.0001, lot: 1, min: 10, depth: "88K", trades: 642 },
        { id: addr(), pair: "WAL / USDC", price: 0.413, chg: +0.62, tick: 0.001, lot: 1, min: 5, depth: "121K", trades: 318 },
        { id: addr(), pair: "SUI / DEEP", price: 45.78, chg: +3.9, tick: 0.01, lot: 0.1, min: 1, depth: "67K", trades: 205 },
      ],
      feeds: [
        { sym: "SUI/USD", price: 1.841, age: 118, ok: true },
        { sym: "USDC/USD", price: 0.9998, age: 96, ok: true },
        { sym: "DEEP/USD", price: 0.0402, age: 340, ok: true },
        { sym: "WAL/USD", price: 0.412, age: 1820, ok: false },
      ],
    },
    walrus: {
      epoch: 14, aggregator: "http://127.0.0.1:9131", publisher: "http://127.0.0.1:9132", proxy: "http://127.0.0.1:9133",
      walExchange: true, shardsTotal: 1000,
      nodes: [
        { id: "node-0", shards: 200, status: "ready", stake: "2.0M" },
        { id: "node-1", shards: 200, status: "ready", stake: "2.0M" },
        { id: "node-2", shards: 200, status: "active", stake: "2.0M" },
        { id: "node-3", shards: 200, status: "ready", stake: "2.0M" },
        { id: "node-4", shards: 200, status: "ready", stake: "2.0M" },
      ],
      blobs: [
        { id: "0x" + hex(40), size: "2.4 MB", epochs: 5, certified: true, deletable: false, uploader: "alice", at: now() - 60000 },
        { id: "0x" + hex(40), size: "812 KB", epochs: 10, certified: true, deletable: true, uploader: "deployer", at: now() - 240000 },
        { id: "0x" + hex(40), size: "14.1 MB", epochs: 3, certified: true, deletable: false, uploader: "bob", at: now() - 520000 },
        { id: "0x" + hex(40), size: "338 KB", epochs: 5, certified: false, deletable: true, uploader: "alice", at: now() - 30000 },
      ],
    },
    seal: {
      keyServerOk: false, mode: "permissioned", objectId: addr(), threshold: "2 of 3", keyServers: 3,
      policies: [
        { id: "pol_" + hex(6), name: "allowlist::members", type: "allowlist", threshold: "1 of 1", pkg: "0x" + hex(4) + "…" },
        { id: "pol_" + hex(6), name: "tle::after-epoch", type: "time-lock", threshold: "2 of 3", pkg: "0x" + hex(4) + "…" },
        { id: "pol_" + hex(6), name: "nft::gated", type: "token-gate", threshold: "1 of 1", pkg: "0x" + hex(4) + "…" },
      ],
    },
    postgres: {
      dsn: "postgres://devstack:devstack@127.0.0.1:5432/devstack", health: "ok", lag: 0, sizeGb: 1.2, conns: 7,
      tables: [
        { name: "objects", rows: "184,402", size: "612 MB" },
        { name: "transactions", rows: "18,442", size: "284 MB" },
        { name: "events", rows: "92,118", size: "201 MB" },
        { name: "checkpoints", rows: "18,442", size: "44 MB" },
        { name: "tx_calls", rows: "61,204", size: "88 MB" },
      ],
    },
  };

  /* ---------- time-series (charts) ---------- */
  const wave = (n, base, amp, drift = 0) => Array.from({ length: n }, (_, i) =>
    Math.max(0, +(base + drift * i + Math.sin(i / 2.2) * amp * 0.5 + (Math.random() - 0.5) * amp).toFixed(2)));
  const history = {
    tps: wave(40, 7, 6),
    cp: Array.from({ length: 40 }, (_, i) => 18402 + i),
    txPerDay: Array.from({ length: 14 }, (_, i) => ({ label: `d${i + 1}`, value: Math.round(rnd(800, 2400)) })),
    activeAccounts: wave(14, 6, 2, 0.1).map((v) => Math.round(v)),
  };

  // deepbook chart data: per-pool price sparkline + SUI/USDC order book
  pluginData.deepbook.pools.forEach((p) => { p.spark = wave(24, p.price, p.price * 0.06); });
  pluginData.deepbook.priceSeries = wave(48, 1.84, 0.12).map((v, i) => ({ i, v }));
  (function () {
    const mid = 1.842; const bids = [], asks = [];
    for (let i = 0; i < 14; i++) { bids.push({ price: +(mid - (i + 1) * 0.004).toFixed(3), size: Math.round(rnd(2, 40)) }); asks.push({ price: +(mid + (i + 1) * 0.004).toFixed(3), size: Math.round(rnd(2, 40)) }); }
    pluginData.deepbook.orderBook = { bids, asks };
  })();

  window.DS = { identity, cycle, endpoints, rows, accounts, packages, coins, snapshots, logs, events, spans, netStats, txs, history, plugins: pluginData };
  window.DSUtil = { now, rnd, pick, hex, addr, digest, makeLog, makeEvent };

  /* ---------- chain detail builders (explorer drill-down) ---------- */
  const COIN_TYPES = ["0x2::sui::SUI", "0x…::usdc::USDC", "0x…::deep::DEEP"];
  function txDetail(digest) {
    const sender = pick(accounts);
    return {
      digest,
      status: Math.random() > 0.9 ? "failure" : "success",
      sender: sender.name, senderAddr: sender.address,
      timestamp: now() - rnd(2000, 200000),
      checkpoint: netStats.checkpoint - Math.floor(rnd(0, 30)),
      kind: pick(["ProgrammableTransaction", "Publish"]),
      gas: { computation: Math.floor(rnd(800, 1600)), storage: Math.floor(rnd(1200, 2800)), rebate: Math.floor(rnd(400, 1100)), budget: 50000000, price: 1000 },
      balanceChanges: [
        { owner: sender.address, name: sender.name, coin: "SUI", amount: -Math.floor(rnd(1000, 5000)) },
        { owner: pick(accounts).address, name: null, coin: pick(["SUI", "USDC", "DEEP"]), amount: Math.floor(rnd(1000, 900000)) },
      ],
      objectChanges: [
        { kind: "mutated", id: addr(), type: "0x2::coin::Coin<0x2::sui::SUI>" },
        { kind: pick(["created", "mutated"]), id: addr(), type: pick(["escrow::Escrow", "pool::Pool<SUI, USDC>", "vault::Vault"]) },
        { kind: "mutated", id: "0x6", type: "0x2::clock::Clock" },
      ],
      events: [
        { type: "escrow::Settled", fields: { id: addr(), amount: Math.floor(rnd(1000, 99999)), recipient: pick(accounts).address } },
      ],
      inputs: { commands: ["SplitCoins(Gas, [1000])", "MoveCall(escrow::settle)", "TransferObjects([obj], recipient)"], inputs: [{ type: "pure", value: 1000 }, { type: "object", id: addr() }] },
    };
  }
  function objectDetail(id) {
    return {
      id, version: Math.floor(rnd(2, 40)), digest: digest(),
      type: pick(["0x2::coin::Coin<0x2::sui::SUI>", "escrow::Escrow", "pool::Pool<0x2::sui::SUI, USDC>"]),
      owner: pick([{ kind: "AddressOwner", address: pick(accounts).address }, { kind: "Shared", initial: 1 }, { kind: "Immutable" }]),
      previousTx: digest(),
      fields: { id: { id }, balance: Math.floor(rnd(1000, 9e9)), locked: Math.random() > 0.5, metadata: { name: "Escrow #" + Math.floor(rnd(1, 99)), created_epoch: 0, tags: ["test", "seeded"] } },
      dynamicFields: Array.from({ length: 3 }, () => ({ name: pick(["holder", "config", "balance_" + hex(2)]), type: "dynamic_field::Field", id: addr() })),
    };
  }

  window.DSChain = { txDetail, objectDetail };

  /* ============================================================
     DSBus — pub/sub tick simulating the SSE stream
     ============================================================ */
  const listeners = new Set();
  window.DSBus = {
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    emit(type, payload) { listeners.forEach((fn) => { try { fn(type, payload); } catch (e) {} }); },
  };

  let tno = 0;
  setInterval(() => {
    tno++;
    // TPS jitter
    DS.netStats.tps = Math.max(0, Math.round(rnd(0, 14)));
    history.tps.push(DS.netStats.tps); if (history.tps.length > 40) history.tps.shift();
    if (tno % 3 === 0) { DS.netStats.checkpoint++; DS.netStats.totalTx += Math.floor(rnd(0, 6)); history.cp.push(DS.netStats.checkpoint); if (history.cp.length > 40) history.cp.shift(); }
    DS.netStats.epochProgress = (DS.netStats.epochProgress + 0.004) % 1;

    // new log line
    const tag = pick(["sui", "postgres", "walrus", "deepbook", "dashboard", "faucet"]);
    const line = makeLog(tag, now());
    (logs[tag] = logs[tag] || []).push(line);
    if (logs[tag].length > 220) logs[tag].shift();
    DSBus.emit("log", line);

    // occasional event
    if (tno % 2 === 0) {
      const ev = makeEvent(now());
      events.push(ev); if (events.length > 200) events.shift();
      DSBus.emit("event", ev);
    }

    // seal occasionally recovers / fails
    if (tno % 9 === 0) {
      const seal = rows.find((r) => r.key === "seal");
      seal.status = seal.status === "acquiring" ? "ready" : "acquiring";
      seal.phase = seal.status === "ready" ? "Key-server healthy" : "Restarting key-server";
      seal.uptime = seal.status === "ready" ? 1 : 0;
      DSBus.emit("row", seal.key);
    }
    // walrus toggles active/ready
    if (tno % 5 === 0) {
      const w = rows.find((r) => r.key === "walrus");
      w.status = w.status === "active" ? "ready" : "active";
      w.phase = w.status === "active" ? "Reconfiguring cluster" : "Cluster healthy (5/5)";
      DSBus.emit("row", w.key);
    }
    DSBus.emit("tick", tno);
  }, 2200);
})();
