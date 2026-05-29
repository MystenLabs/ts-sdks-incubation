/* ============================================================
   panels-plugins.jsx — per-plugin domain panels with sub-nav
   ============================================================ */
const { Icon: PIcon, Dot: PDot, StatusBadge: PBadge, statusInfo: pStatus, CopyChip: PCopy,
  CoinAmount: PCoin, Kpi: PKpi, SectionHead: PHead, short: pShort, ago: pAgo, EmptyState: PEmpty } = window;
const { useState: pUseState, useEffect: pUseEffect } = React;

const PLUGIN_META = {
  deepbook: { title: "DeepBook", icon: "box", token: "blue", tag: "CLOB · liquidity" },
  walrus:   { title: "Walrus", icon: "database", token: "cyan", tag: "decentralized storage" },
  seal:     { title: "Seal", icon: "plug", token: "magenta", tag: "threshold encryption" },
  coin:     { title: "Coins", icon: "coins", token: "yellow", tag: "registry · mint" },
  postgres: { title: "Postgres", icon: "database", token: "blue", tag: "indexer datastore" },
};
const PLUGIN_ORDER = ["deepbook", "walrus", "seal", "coin", "postgres"];

/* shared mini widgets ------------------------------------------------ */
function PField({ label, children }) {
  return (
    <div className="row between" style={{ padding: "9px 0", borderBottom: "1px solid var(--line-faint)", gap: 12 }}>
      <span style={{ fontSize: 12.5, color: "var(--tx-lo)" }}>{label}</span>
      <span style={{ textAlign: "right", minWidth: 0 }}>{children}</span>
    </div>
  );
}
function Toggle({ on, onClick }) {
  return (
    <button onClick={onClick} style={{ width: 40, height: 23, borderRadius: 999, border: "1px solid var(--line-strong)", background: on ? "var(--accent)" : "var(--bg-elev-2)", position: "relative", transition: ".16s", cursor: "pointer", padding: 0 }}>
      <span style={{ position: "absolute", top: 2, left: on ? 19 : 2, width: 17, height: 17, borderRadius: "50%", background: on ? "var(--accent-ink)" : "var(--tx-mid)", transition: ".16s" }} />
    </button>
  );
}

/* DEEPBOOK ----------------------------------------------------------- */
function DeepBookView({ api }) {
  const d = window.DS.plugins.deepbook;
  const [mm, setMm] = pUseState(d.mmRunning);
  const [spread, setSpread] = pUseState(d.spreadBps);
  return (
    <div className="col" style={{ gap: 18 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 14 }}>
        <PKpi label="Pools" value={d.pools.length} sub="active" token="blue" icon="box" />
        <PKpi label="24h volume" value="$1.14M" token="green" icon="activity" />
        <PKpi label="DEEP funded" value={d.deepFunded.toLocaleString()} sub="DEEP" token="cyan" icon="coins" />
        <PKpi label="Market maker" value={mm ? "Running" : "Stopped"} token={mm ? "green" : "white"} icon="zap" />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 18, alignItems: "start" }}>
        <div className="panel panel-pad">
          <PHead title="SUI / USDC price" right={<span className="mono tnum" style={{ fontSize: 13, color: "var(--c-green)" }}>1.842 <span style={{ color: "var(--tx-lo)", fontSize: 11 }}>+2.31%</span></span>} />
          <window.AreaChart data={d.priceSeries} color="var(--viz-1)" height={140} axis tooltip />
        </div>
        <div className="panel panel-pad">
          <PHead title="Order book depth" right={<span className="row" style={{ gap: 10, fontSize: 11 }}><span className="row" style={{ gap: 5 }}><PDot token="green" /><span style={{ color: "var(--tx-lo)" }}>bids</span></span><span className="row" style={{ gap: 5 }}><PDot token="red" /><span style={{ color: "var(--tx-lo)" }}>asks</span></span></span>} />
          <window.DepthChart bids={d.orderBook.bids} asks={d.orderBook.asks} height={140} />
        </div>
      </div>

      <div className="panel" style={{ overflow: "hidden" }}>
        <div className="panel-pad" style={{ padding: "14px 18px" }}><PHead title="Pools" count={d.pools.length} right={<button className="btn btn-sm" onClick={() => api.toast("Seeding liquidity to all pools…", "blue")}><PIcon name="drop" size={13} /> Seed liquidity</button>} /></div>
        <table className="tbl">
          <thead><tr><th>Pair</th><th>Price</th><th>24h</th><th>Trend</th><th>Tick</th><th>Lot</th><th>Min</th><th>Depth</th><th>Trades</th><th>Pool ID</th></tr></thead>
          <tbody>
            {d.pools.map((p) => (
              <tr key={p.id} className="clickable">
                <td><span style={{ fontWeight: 550 }}>{p.pair}</span></td>
                <td className="mono tnum">{p.price}</td>
                <td className="mono tnum" style={{ color: p.chg >= 0 ? "var(--c-green)" : "var(--c-red)" }}>{p.chg >= 0 ? "+" : ""}{p.chg}%</td>
                <td><window.Sparkline data={p.spark} width={70} height={24} color={p.chg >= 0 ? "var(--c-green)" : "var(--c-red)"} /></td>
                <td className="mono tnum" style={{ color: "var(--tx-lo)", fontSize: 12 }}>{p.tick}</td>
                <td className="mono tnum" style={{ color: "var(--tx-lo)", fontSize: 12 }}>{p.lot}</td>
                <td className="mono tnum" style={{ color: "var(--tx-lo)", fontSize: 12 }}>{p.min}</td>
                <td className="mono tnum">{p.depth}</td>
                <td className="mono tnum" style={{ color: "var(--tx-lo)" }}>{p.trades.toLocaleString()}</td>
                <td><PCopy text={p.id} display={pShort(p.id, 5, 3)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr", gap: 18, alignItems: "start" }}>
        <div className="panel" style={{ overflow: "hidden" }}>
          <div className="panel-pad" style={{ padding: "14px 18px" }}><PHead title="Pyth price feeds" right={<button className="btn btn-sm btn-ghost" onClick={() => api.toast("Refreshing Pyth feeds…", "blue")}><PIcon name="refresh" size={13} /></button>} /></div>
          <table className="tbl">
            <thead><tr><th>Feed</th><th>Price</th><th>Age</th><th>Status</th></tr></thead>
            <tbody>
              {d.feeds.map((f) => (
                <tr key={f.sym}>
                  <td className="mono" style={{ fontSize: 12.5 }}>{f.sym}</td>
                  <td className="mono tnum">${f.price}</td>
                  <td className="mono tnum" style={{ color: f.age > 1000 ? "var(--c-yellow)" : "var(--tx-lo)", fontSize: 12 }}>{f.age}ms</td>
                  <td><span className="row" style={{ gap: 6 }}><PDot token={f.ok ? "green" : "yellow"} /><span style={{ fontSize: 12, color: `var(--c-${f.ok ? "green" : "yellow"})` }}>{f.ok ? "fresh" : "stale"}</span></span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="col" style={{ gap: 18 }}>
          <div className="panel panel-pad">
            <PHead title="Market maker" />
            <PField label="Status"><span className="row" style={{ gap: 9, justifyContent: "flex-end" }}><span style={{ fontSize: 12.5, color: mm ? "var(--c-green)" : "var(--tx-lo)" }}>{mm ? "running" : "stopped"}</span><Toggle on={mm} onClick={() => { setMm((v) => !v); api.toast(mm ? "Market maker stopped" : "Market maker started", mm ? "yellow" : "green"); }} /></span></PField>
            <PField label="Spread">
              <span className="row" style={{ gap: 10, justifyContent: "flex-end" }}>
                <input type="range" min="2" max="50" value={spread} onChange={(e) => setSpread(+e.target.value)} style={{ width: 120, accentColor: "var(--accent)" }} />
                <span className="mono tnum" style={{ fontSize: 12.5, minWidth: 44 }}>{spread} bps</span>
              </span>
            </PField>
          </div>
          <div className="panel panel-pad">
            <PHead title="Addresses" />
            <PField label="Package"><PCopy text={d.packageId} display={pShort(d.packageId)} /></PField>
            <PField label="Registry"><PCopy text={d.registryId} display={pShort(d.registryId)} /></PField>
            <PField label="Admin cap"><PCopy text={d.adminCap} display={pShort(d.adminCap)} /></PField>
          </div>
        </div>
      </div>
    </div>
  );
}

/* WALRUS ------------------------------------------------------------- */
function WalrusView({ api }) {
  const d = window.DS.plugins.walrus;
  const healthy = d.nodes.filter((n) => n.status === "ready").length;
  return (
    <div className="col" style={{ gap: 18 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 14 }}>
        <PKpi label="Cluster" value={`${healthy}/${d.nodes.length}`} sub="nodes ready" token="green" icon="database" />
        <PKpi label="Storage epoch" value={d.epoch} icon="clock" />
        <PKpi label="Blobs stored" value={d.blobs.length} token="cyan" icon="box" />
        <PKpi label="Shards" value={d.shardsTotal} token="blue" icon="hash" />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: 18, alignItems: "start" }}>
        <div className="col" style={{ gap: 18 }}>
          <div className="panel panel-pad">
            <PHead title="Endpoints" />
            <PField label="Aggregator"><PCopy text={d.aggregator} display={d.aggregator.replace(/^https?:\/\//, "")} /></PField>
            <PField label="Publisher"><PCopy text={d.publisher} display={d.publisher.replace(/^https?:\/\//, "")} /></PField>
            <PField label="Proxy"><PCopy text={d.proxy} display={d.proxy.replace(/^https?:\/\//, "")} /></PField>
            <PField label="WAL exchange"><span className="row" style={{ gap: 6, justifyContent: "flex-end" }}><PDot token="green" /><span style={{ fontSize: 12.5, color: "var(--c-green)" }}>enabled</span></span></PField>
          </div>
          <div className="panel" style={{ overflow: "hidden" }}>
            <div className="panel-pad" style={{ padding: "14px 18px" }}><PHead title="Cluster nodes" /></div>
            <table className="tbl">
              <thead><tr><th>Node</th><th>Shards</th><th>Stake</th><th>Status</th></tr></thead>
              <tbody>
                {d.nodes.map((n) => (
                  <tr key={n.id}>
                    <td className="mono" style={{ fontSize: 12.5 }}>{n.id}</td>
                    <td className="mono tnum">{n.shards}</td>
                    <td className="mono tnum" style={{ color: "var(--tx-lo)" }}>{n.stake}</td>
                    <td><PBadge status={n.status} sm /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel" style={{ overflow: "hidden" }}>
          <div className="panel-pad" style={{ padding: "14px 18px" }}>
            <PHead title="Recent blobs" count={d.blobs.length} right={<button className="btn btn-sm btn-primary" onClick={() => api.toast("Upload a blob to the publisher…", "cyan")}><PIcon name="download" size={13} style={{ transform: "rotate(180deg)" }} /> Upload</button>} />
          </div>
          <table className="tbl">
            <thead><tr><th>Blob ID</th><th>Size</th><th>Epochs</th><th>Uploader</th><th>Certified</th><th>Deletable</th><th>When</th></tr></thead>
            <tbody>
              {d.blobs.map((b) => (
                <tr key={b.id} className="clickable">
                  <td><PCopy text={b.id} display={pShort(b.id, 7, 4)} /></td>
                  <td className="mono tnum">{b.size}</td>
                  <td className="mono tnum" style={{ color: "var(--tx-lo)" }}>{b.epochs}</td>
                  <td><span style={{ color: "var(--c-magenta)", fontSize: 12.5 }}>{b.uploader}</span></td>
                  <td>{b.certified ? <PDot token="green" /> : <PDot token="yellow" />}</td>
                  <td style={{ color: "var(--tx-lo)", fontSize: 12 }}>{b.deletable ? "yes" : "—"}</td>
                  <td className="mono" style={{ fontSize: 11.5, color: "var(--tx-dim)" }}>{pAgo(b.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* SEAL --------------------------------------------------------------- */
function SealView({ api }) {
  const d = window.DS.plugins.seal;
  return (
    <div className="col" style={{ gap: 18 }}>
      {!d.keyServerOk && (
        <div className="panel panel-pad" style={{ borderColor: "color-mix(in oklab, var(--c-yellow) 36%, var(--line))", background: "color-mix(in oklab, var(--c-yellow) 7%, var(--bg-panel))" }}>
          <div className="row between">
            <span className="row" style={{ gap: 10 }}><PIcon name="alert" size={17} style={{ color: "var(--c-yellow)" }} /><span style={{ fontSize: 13, color: "var(--tx-hi)" }}>Key-server is still coming up — encryption requests will fail until it reports healthy.</span></span>
            <button className="btn btn-sm" onClick={() => api.toast("Probing key-server health…", "magenta")}><PIcon name="refresh" size={13} /> Probe</button>
          </div>
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.5fr", gap: 18, alignItems: "start" }}>
        <div className="panel panel-pad">
          <PHead title="Key server" />
          <PField label="Health"><span className="row" style={{ gap: 6, justifyContent: "flex-end" }}><PDot token={d.keyServerOk ? "green" : "yellow"} pulse={!d.keyServerOk} /><span style={{ fontSize: 12.5, color: `var(--c-${d.keyServerOk ? "green" : "yellow"})` }}>{d.keyServerOk ? "healthy" : "starting"}</span></span></PField>
          <PField label="Mode"><span className="badge" style={{ height: 19, fontSize: 11 }}>{d.mode}</span></PField>
          <PField label="Threshold"><span className="mono" style={{ fontSize: 12.5 }}>{d.threshold}</span></PField>
          <PField label="Key servers"><span className="mono tnum">{d.keyServers}</span></PField>
          <PField label="Object ID"><PCopy text={d.objectId} display={pShort(d.objectId)} /></PField>
        </div>
        <div className="panel" style={{ overflow: "hidden" }}>
          <div className="panel-pad" style={{ padding: "14px 18px" }}><PHead title="Policies" count={d.policies.length} /></div>
          <table className="tbl">
            <thead><tr><th>Policy</th><th>Type</th><th>Threshold</th><th>Package</th></tr></thead>
            <tbody>
              {d.policies.map((p) => (
                <tr key={p.id} className="clickable">
                  <td><span style={{ fontWeight: 530 }}>{p.name}</span></td>
                  <td><span className="badge" style={{ height: 19, fontSize: 10.5, color: "var(--c-magenta)" }}>{p.type}</span></td>
                  <td className="mono" style={{ fontSize: 12.5 }}>{p.threshold}</td>
                  <td className="mono" style={{ fontSize: 12, color: "var(--tx-lo)" }}>{p.pkg}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* COIN / MINT -------------------------------------------------------- */
function CoinView({ api }) {
  const ds = window.DS;
  const [mintFor, setMintFor] = pUseState(null);
  const [amount, setAmount] = pUseState(1000);
  return (
    <div className="col" style={{ gap: 18 }}>
      <div className="panel" style={{ overflow: "hidden" }}>
        <div className="panel-pad" style={{ padding: "14px 18px" }}><PHead title="Coin registry" count={ds.coins.length} /></div>
        <table className="tbl">
          <thead><tr><th>Coin</th><th>Type</th><th>Decimals</th><th>Supply</th><th>Treasury cap</th><th style={{ width: 110 }}></th></tr></thead>
          <tbody>
            {ds.coins.map((c) => (
              <tr key={c.symbol}>
                <td><span className="row" style={{ gap: 8 }}><window.CoinIcon symbol={c.symbol} size={20} /><span style={{ fontWeight: 550 }}>{c.symbol}</span></span></td>
                <td><PCopy text={c.type} display={c.type} /></td>
                <td className="mono tnum" style={{ color: "var(--tx-lo)" }}>{c.decimals}</td>
                <td className="mono tnum">{c.supply}</td>
                <td>{c.treasuryCap ? <PCopy text={c.treasuryCap} display={pShort(c.treasuryCap, 5, 3)} /> : <span style={{ color: "var(--tx-dim)" }}>—</span>}</td>
                <td>{c.treasuryCap ? <button className="btn btn-sm" onClick={() => setMintFor(mintFor === c.symbol ? null : c.symbol)}><PIcon name="coins" size={13} /> Mint</button> : <span style={{ color: "var(--tx-dim)", fontSize: 11.5 }}>no cap</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {mintFor && (
        <div className="panel panel-pad fade-up" style={{ maxWidth: 460 }}>
          <PHead title={`Mint ${mintFor}`} />
          <div className="col" style={{ gap: 12 }}>
            <div className="col" style={{ gap: 6 }}><span className="eyebrow">Recipient</span>
              <select className="field" defaultValue={ds.accounts[0].name}>{ds.accounts.map((a) => <option key={a.name}>{a.name}</option>)}</select></div>
            <div className="col" style={{ gap: 6 }}><span className="eyebrow">Amount</span>
              <input type="number" className="field mono" value={amount} onChange={(e) => setAmount(+e.target.value)} /></div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn btn-primary grow" onClick={() => { api.toast(`Minted ${amount.toLocaleString()} ${mintFor}`, "green"); setMintFor(null); }}>Mint {amount.toLocaleString()} {mintFor}</button>
              <button className="btn" onClick={() => setMintFor(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* POSTGRES ----------------------------------------------------------- */
function PostgresView({ api }) {
  const d = window.DS.plugins.postgres;
  return (
    <div className="col" style={{ gap: 18 }}>
      <div className="panel panel-pad row between wrap" style={{ gap: 12 }}>
        <div className="row" style={{ gap: 12, minWidth: 0 }}>
          <PIcon name="database" size={18} style={{ color: "var(--c-blue)", flex: "none" }} />
          <PCopy text={d.dsn} display={d.dsn} />
        </div>
        <button className="btn btn-sm" onClick={() => api.toast("Copied psql connection string", "cyan")}><PIcon name="terminal" size={13} /> Open psql</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 14 }}>
        <PKpi label="Health" value="OK" token="green" icon="activity" />
        <PKpi label="Index lag" value={d.lag} sub="checkpoints" token="green" icon="clock" />
        <PKpi label="DB size" value={d.sizeGb + " GB"} icon="database" />
        <PKpi label="Connections" value={d.conns} token="cyan" icon="plug" />
      </div>
      <div className="panel" style={{ overflow: "hidden" }}>
        <div className="panel-pad" style={{ padding: "14px 18px" }}><PHead title="Tables" count={d.tables.length} /></div>
        <table className="tbl">
          <thead><tr><th>Table</th><th>Rows</th><th>Size</th><th style={{ width: "40%" }}></th></tr></thead>
          <tbody>
            {d.tables.map((tb, i) => {
              const maxRows = 184402;
              const pct = Math.min(100, parseInt(tb.rows.replace(/,/g, "")) / maxRows * 100);
              return (
                <tr key={tb.name}>
                  <td className="mono" style={{ fontSize: 12.5 }}>{tb.name}</td>
                  <td className="mono tnum">{tb.rows}</td>
                  <td className="mono tnum" style={{ color: "var(--tx-lo)" }}>{tb.size}</td>
                  <td><div className="meter"><span style={{ width: pct + "%", background: "var(--c-blue)" }} /></div></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const PLUGIN_VIEWS = { deepbook: DeepBookView, walrus: WalrusView, seal: SealView, coin: CoinView, postgres: PostgresView };

/* SINGLE-PLUGIN PAGE (one per nav item) ------------------------------ */
function PluginPage({ api, pluginKey }) {
  const ds = window.DS;
  const sel = PLUGIN_VIEWS[pluginKey] ? pluginKey : "deepbook";
  const [, force] = pUseState(0);
  pUseEffect(() => window.DSBus.subscribe((t) => { if (t === "row") force((x) => x + 1); }), []);
  const row = ds.rows.find((r) => r.key === sel);
  const meta = PLUGIN_META[sel];
  const View = PLUGIN_VIEWS[sel];

  return (
    <div className="col" style={{ gap: 18 }}>
      {/* plugin header bar */}
      <div className="row between wrap" style={{ gap: 12 }}>
        <div className="row" style={{ gap: 13 }}>
          <div style={{ width: 42, height: 42, borderRadius: 11, display: "grid", placeItems: "center", background: `color-mix(in oklab, var(--c-${meta.token}) 16%, transparent)`, color: `var(--c-${meta.token})`, flex: "none", boxShadow: `0 0 0 1px color-mix(in oklab, var(--c-${meta.token}) 28%, transparent)` }}><PIcon name={meta.icon} size={21} /></div>
          <div>
            <div className="row" style={{ gap: 10 }}><h2 style={{ fontSize: 19 }}>{meta.title}</h2>{row && <PBadge status={row.status} sm />}</div>
            <span style={{ fontSize: 12.5, color: "var(--tx-mid)" }}>{meta.tag} · <span className="mono" style={{ color: "var(--tx-lo)" }}>{row ? row.phase : sel}</span></span>
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn btn-sm" onClick={() => api.command("restart/" + sel, `Restart ${meta.title}`)}><PIcon name="refresh" size={13} /> Restart</button>
          {row && <button className="btn btn-sm btn-ghost" onClick={() => api.openService(sel)}>Logs &amp; events</button>}
        </div>
      </div>

      <div key={sel} className="fade-up">{View ? <View api={api} /> : <PEmpty title="No panel" />}</div>
    </div>
  );
}

Object.assign(window, { PluginPage, PLUGIN_META, PLUGIN_ORDER });
