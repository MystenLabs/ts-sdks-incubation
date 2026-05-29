/* ============================================================
   panels-stub.jsx — Accounts, Faucet, Explorer, Plugins, Config
   ============================================================ */
const { Icon: SIcon, Dot: SDot, StatusBadge: SBadge, CopyChip: SCopy, AddressChip: sAddr, CoinAmount: SCoin,
  fmtMist: sFmt, Kpi: SKpi, SectionHead: SHead, EmptyState: SEmpty, ago: sAgo, short: sShort, Breadcrumbs } = window;
const { useState: sUseState, useEffect: sUseEffect } = React;

const FUND_TOKEN = { funded: "green", cached: "green", pending: "yellow", skipped: "white", failed: "red" };
const FUND_LABEL = { funded: "✓ funded", cached: "✓ cached", pending: "pending", skipped: "skipped", failed: "failed" };

/* ============================================================ ACCOUNTS */
function AccountsPanel({ api }) {
  const ds = window.DS;
  const [sel, setSel] = sUseState(null);
  const acc = sel ? ds.accounts.find((a) => a.name === sel) : null;

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="row between wrap" style={{ gap: 12 }}>
        <div>
          <h2 style={{ fontSize: 19 }}>Accounts &amp; Wallet</h2>
          <p style={{ color: "var(--tx-mid)", fontSize: 13, margin: "3px 0 0" }}>Configured keypairs with live on-chain balances. Connect the dev-wallet to sign.</p>
        </div>
        <button className="btn btn-primary btn-sm"><SIcon name="wallet" size={14} /> Connect dev-wallet</button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: acc ? "1fr 360px" : "1fr", gap: 18, alignItems: "start" }}>
        <div className="panel" style={{ overflow: "hidden" }}>
          <table className="tbl">
            <thead><tr><th>Account</th><th>Address</th><th>Scheme</th><th>Source</th><th>Balance</th><th>Funding</th><th>Wallet</th></tr></thead>
            <tbody>
              {ds.accounts.map((a) => (
                <tr key={a.name} className="clickable" onClick={() => setSel(a.name)} style={sel === a.name ? { background: "var(--accent-soft)" } : null}>
                  <td><span className="row" style={{ gap: 8 }}><window.Identicon address={a.address} size={18} /><span style={{ color: "var(--c-magenta)", fontWeight: 550 }}>{a.name}</span></span></td>
                  <td><SCopy text={a.address} display={sShort(a.address)} /></td>
                  <td className="mono" style={{ fontSize: 11.5, color: "var(--tx-lo)" }}>{a.scheme}</td>
                  <td><span className="badge" style={{ height: 19, fontSize: 10.5, color: a.source === "impersonate" ? "var(--c-yellow)" : "var(--tx-mid)" }}>{a.source}</span></td>
                  <td><SCoin mist={a.funding.balanceMist} /></td>
                  <td><span className="row" style={{ gap: 6 }}><SDot token={FUND_TOKEN[a.funding.status]} pulse={a.funding.status === "pending"} /><span style={{ fontSize: 12, color: `var(--c-${FUND_TOKEN[a.funding.status]})` }}>{FUND_LABEL[a.funding.status]}</span></span></td>
                  <td>{a.walletVisible ? <SDot token="cyan" /> : <span style={{ color: "var(--tx-dim)" }}>—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {acc && (
          <div className="panel panel-pad fade-up col" style={{ gap: 16, position: "sticky", top: 0 }}>
            <div className="row between">
              <div className="row" style={{ gap: 9 }}><window.Identicon address={acc.address} size={36} />
              <div><div style={{ fontWeight: 560, color: "var(--c-magenta)" }}>{acc.name}</div><span className="mono" style={{ fontSize: 11, color: "var(--tx-lo)" }}>{acc.scheme}</span></div></div>
              <button className="iconbtn" onClick={() => setSel(null)}><SIcon name="x" /></button>
            </div>
            <SCopy text={acc.address} display={acc.address} />
            <div className="panel panel-pad" style={{ background: "var(--bg-elev)" }}>
              <div className="eyebrow" style={{ marginBottom: 8 }}>Balances</div>
              <div className="col" style={{ gap: 7 }}>
                <div className="row between"><span className="mono" style={{ fontSize: 12 }}>◎ SUI</span><SCoin mist={acc.funding.balanceMist} /></div>
                <div className="row between"><span className="mono" style={{ fontSize: 12 }}>◆ DEEP</span><SCoin mist={acc.funding.balanceMist / 3} symbol="DEEP" decimals={6} /></div>
              </div>
            </div>
            {acc.source === "impersonate" && <div className="panel panel-pad" style={{ borderColor: "color-mix(in oklab, var(--c-yellow) 34%, var(--line))", background: "color-mix(in oklab, var(--c-yellow) 7%, transparent)", fontSize: 12.5, color: "var(--tx-mid)" }}><SIcon name="alert" size={14} style={{ color: "var(--c-yellow)" }} /> Impersonated account — no signing key. Reads only.</div>}
            <div className="row" style={{ gap: 8 }}>
              <button className="btn btn-primary grow" onClick={() => api.goto("faucet")}><SIcon name="drop" size={14} /> Fund</button>
              <button className="btn" onClick={() => api.goto("explorer")}>View on explorer</button>
            </div>
            <button className="btn btn-danger btn-sm" onClick={() => api.toast("Export guarded — ephemeral keypairs only", "yellow")}>Export keypair</button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================ FAUCET */
function FaucetPanel({ api }) {
  const ds = window.DS;
  const faucetCoins = ds.coins.filter((c) => c.faucet);
  const [target, setTarget] = sUseState(ds.accounts[0].name);
  const [coin, setCoin] = sUseState("SUI");
  const [amount, setAmount] = sUseState(100);
  const [state, setState] = sUseState("idle"); // idle requesting success
  const [history, setHistory] = sUseState([
    { coin: "SUI", amount: 100, target: "alice", at: Date.now() - 60000, ok: true },
    { coin: "DEEP", amount: 5000, target: "mm-bot", at: Date.now() - 220000, ok: true },
  ]);

  const request = () => {
    setState("requesting");
    setTimeout(() => {
      setState("success");
      setHistory((h) => [{ coin, amount, target, at: Date.now(), ok: true }, ...h]);
      api.toast(`Dispensed ${amount} ${coin} → ${target}`, "green");
      setTimeout(() => setState("idle"), 1600);
    }, 1100);
  };

  return (
    <div className="col" style={{ gap: 16 }}>
      <div>
        <h2 style={{ fontSize: 19 }}>Faucet</h2>
        <p style={{ color: "var(--tx-mid)", fontSize: 13, margin: "3px 0 0" }}>Dispense test coins to any account or pasted address.</p>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 18, alignItems: "start" }}>
        <div className="panel panel-pad col" style={{ gap: 16 }}>
          <div className="col" style={{ gap: 7 }}>
            <span className="eyebrow">Target</span>
            <select value={target} onChange={(e) => setTarget(e.target.value)} className="field">
              {ds.accounts.map((a) => <option key={a.name} value={a.name}>{a.name} — {sShort(a.address)}</option>)}
            </select>
          </div>
          <div className="col" style={{ gap: 7 }}>
            <span className="eyebrow">Coin</span>
            <div className="row wrap" style={{ gap: 8 }}>
              {faucetCoins.map((c) => (
                <button key={c.symbol} className="btn btn-sm" onClick={() => setCoin(c.symbol)} style={coin === c.symbol ? { borderColor: "var(--accent)", color: "var(--accent)", background: "var(--accent-soft)" } : null}>
                  <span className="mono">{c.icon}</span> {c.symbol}
                </button>
              ))}
            </div>
          </div>
          <div className="col" style={{ gap: 7 }}>
            <span className="eyebrow">Amount</span>
            <div className="row" style={{ gap: 8 }}>
              <input type="number" value={amount} onChange={(e) => setAmount(+e.target.value)} className="field mono" style={{ width: 140 }} />
              <div className="row" style={{ gap: 6 }}>{[10, 100, 1000].map((v) => <button key={v} className="btn btn-sm btn-ghost" onClick={() => setAmount(v)}>{v}</button>)}</div>
            </div>
          </div>
          <button className="btn btn-primary" onClick={request} disabled={state === "requesting"} style={{ height: 38 }}>
            {state === "requesting" ? <><span className="dot dot-white dot-pulse" /> Requesting…</> : state === "success" ? <><SIcon name="check" size={15} /> Dispensed</> : <><SIcon name="drop" size={15} /> Request {amount} {coin}</>}
          </button>
        </div>

        <div className="panel" style={{ overflow: "hidden" }}>
          <div className="panel-pad" style={{ padding: "14px 18px" }}><SHead title="Recent requests" /></div>
          <table className="tbl">
            <thead><tr><th>Coin</th><th>Amount</th><th>Target</th><th>When</th><th></th></tr></thead>
            <tbody>
              {history.map((h, i) => (
                <tr key={i}>
                  <td className="mono">{h.coin}</td>
                  <td className="mono tnum">{h.amount.toLocaleString()}</td>
                  <td><span style={{ color: "var(--c-magenta)", fontSize: 12.5 }}>{h.target}</span></td>
                  <td style={{ color: "var(--tx-lo)", fontSize: 12 }}>{sAgo(h.at)} ago</td>
                  <td><SDot token={h.ok ? "green" : "red"} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ============================================================ EXPLORER */
/* ============================================================ EXPLORER */
function useChainLoad(buildFn, dep) {
  const [data, setData] = sUseState(null);
  sUseEffect(() => {
    setData(null);
    const t = setTimeout(() => setData(buildFn()), 480); // simulate GraphQL latency
    return () => clearTimeout(t);
  }, [dep]);
  return data;
}

function ExplorerPanel({ api, initial }) {
  const ds = window.DS;
  const [view, setView] = sUseState({ kind: "home" }); // {kind:'home'|'tx'|'object'|'package', id}
  const [, force] = sUseState(0);
  sUseEffect(() => window.DSBus.subscribe((t) => { if (t === "tick" && view.kind === "home") force((x) => x + 1); }), [view.kind]);

  const go = (v) => setView(v);
  const home = () => setView({ kind: "home" });

  const crumbs = [{ label: "Explorer", onClick: view.kind !== "home" ? home : null }];
  if (view.kind === "tx") crumbs.push({ label: "Transaction", onClick: null }, { label: sShort(view.id, 6, 4), onClick: null });
  if (view.kind === "object") crumbs.push({ label: "Object", onClick: null }, { label: sShort(view.id, 6, 4), onClick: null });
  if (view.kind === "package") crumbs.push({ label: "Package", onClick: null }, { label: view.pkg.name, onClick: null });

  return (
    <div className="col" style={{ gap: 18 }}>
      <div className="row between wrap" style={{ gap: 12 }}>
        <div>
          <h2 style={{ fontSize: 19 }}>Sui Explorer</h2>
          {view.kind === "home"
            ? <p style={{ color: "var(--tx-mid)", fontSize: 13, margin: "3px 0 0" }}>Browser-side explorer over the local node — GraphQL-primary, registry-enriched.</p>
            : <div style={{ marginTop: 6 }}><Breadcrumbs items={crumbs} /></div>}
        </div>
        <div className="row" style={{ gap: 8, background: "var(--bg-panel)", border: "1px solid var(--line)", borderRadius: "var(--r-sm)", padding: "0 12px", height: 34, width: 320, maxWidth: "100%" }}>
          <SIcon name="search" size={15} style={{ color: "var(--tx-lo)" }} />
          <input placeholder="Digest · object · address · package…"
            onKeyDown={(e) => { if (e.key === "Enter" && e.target.value.trim()) { const v = e.target.value.trim(); go(v.length > 40 ? { kind: "object", id: v } : { kind: "tx", id: window.DSUtil.digest() }); e.target.value = ""; } }}
            style={{ background: "transparent", border: "none", outline: "none", color: "var(--tx-hi)", fontSize: 12.5, flex: 1, fontFamily: "var(--font-mono)" }} />
        </div>
      </div>

      {view.kind === "tx" ? <TxDetail id={view.id} go={go} /> :
       view.kind === "object" ? <ObjectDetail id={view.id} go={go} /> :
       view.kind === "package" ? <PackageDetail pkg={view.pkg} go={go} /> :
       <ExplorerHome ds={ds} go={go} />}
    </div>
  );
}

function ExplorerHome({ ds, go }) {
  return (
    <React.Fragment>
      <window.Banner tone="info" title={`Connected to ${ds.identity.network} · indexer online`}>Historical lists &amp; analytics available. Degrades to upstream GraphQL in fork/live mode.</window.Banner>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 14 }}>
        <SKpi label="Epoch" value={ds.netStats.epoch} sub={`${Math.round(ds.netStats.epochProgress * 100)}% elapsed`} icon="clock" />
        <SKpi label="Checkpoint" value={ds.netStats.checkpoint.toLocaleString()} token="cyan" icon="box" live spark={ds.history.cp} />
        <SKpi label="Total tx" value={ds.netStats.totalTx.toLocaleString()} icon="hash" />
        <SKpi label="TPS" value={ds.netStats.tps} token="green" icon="activity" live spark={ds.history.tps} />
        <SKpi label="Ref gas" value={ds.netStats.gasPrice} sub="MIST" icon="zap" />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18, alignItems: "start" }}>
        <div className="panel panel-pad">
          <SHead title="Transactions / day" right={<span className="badge" style={{ height: 19, fontSize: 10.5 }}>14d</span>} />
          <window.BarChart data={ds.history.txPerDay} color="var(--viz-2)" height={130} axis />
        </div>
        <div className="panel panel-pad">
          <SHead title="Active accounts" right={<span className="badge" style={{ height: 19, fontSize: 10.5 }}>14d</span>} />
          <window.AreaChart data={ds.history.activeAccounts} color="var(--viz-3)" height={130} axis />
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 18, alignItems: "start" }}>
        <div className="panel" style={{ overflow: "hidden" }}>
          <div className="panel-pad" style={{ padding: "14px 18px" }}><SHead title="Latest transactions" /></div>
          <table className="tbl">
            <thead><tr><th>Digest</th><th>Sender</th><th>Kind</th><th>Gas</th><th>Status</th><th>When</th></tr></thead>
            <tbody>
              {ds.txs.map((tx) => (
                <tr key={tx.digest} className="clickable" onClick={() => go({ kind: "tx", id: tx.digest })}>
                  <td><span style={{ color: "var(--c-cyan)", fontSize: 12.5 }} className="mono">{sShort(tx.digest, 8, 4)}</span></td>
                  <td><span style={{ color: "var(--c-magenta)", fontSize: 12.5 }}>{tx.sender}</span></td>
                  <td style={{ fontSize: 12, color: "var(--tx-mid)" }}>{tx.kind}</td>
                  <td className="mono tnum" style={{ fontSize: 12, color: "var(--tx-lo)" }}>{tx.gas}</td>
                  <td><SDot token={tx.status === "success" ? "green" : "red"} /></td>
                  <td className="mono" style={{ fontSize: 11.5, color: "var(--tx-dim)" }}>{sAgo(tx.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="panel" style={{ overflow: "hidden" }}>
          <div className="panel-pad" style={{ padding: "14px 18px" }}>
            <SHead title="Packages" count={ds.packages.length} />
          </div>
          <div className="col" style={{ padding: "0 0 8px" }}>
            {ds.packages.map((p) => (
              <div key={p.id} className="row between activity-row" style={{ cursor: "pointer" }} onClick={() => go({ kind: "package", pkg: p })}>
                <div className="row" style={{ gap: 9 }}>
                  <SDot token={p.kind === "ours" ? "blue" : "white"} />
                  <div>
                    <div style={{ fontWeight: 530, fontSize: 13 }}>{p.name} {p.kind === "ours" && <span className="badge" style={{ height: 17, fontSize: 9.5, color: "var(--c-blue)", marginLeft: 4 }}>published here</span>}</div>
                    <span className="mono" style={{ fontSize: 11, color: "var(--tx-dim)" }}>{sShort(p.id, 8, 4)} · {p.modules.length} modules · v{p.version}</span>
                  </div>
                </div>
                <SIcon name="chevR" size={15} style={{ color: "var(--tx-dim)" }} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </React.Fragment>
  );
}

function DetailSkeleton() {
  return (
    <div className="col" style={{ gap: 18 }}>
      <div className="panel panel-pad col" style={{ gap: 12 }}>
        <window.Skeleton w={180} h={18} />
        <window.Skeleton w={"60%"} />
        <window.Skeleton w={"40%"} />
      </div>
      <div className="panel" style={{ overflow: "hidden" }}><window.SkeletonRows rows={5} cols={3} /></div>
    </div>
  );
}

function TxDetail({ id, go }) {
  const tx = useChainLoad(() => window.DSChain.txDetail(id), id);
  if (!tx) return <DetailSkeleton />;
  return (
    <div className="col fade-up" style={{ gap: 18 }}>
      <div className="panel panel-pad">
        <div className="row between wrap" style={{ gap: 12, marginBottom: 14 }}>
          <div className="row" style={{ gap: 10 }}>
            <span className="badge" style={{ borderColor: `color-mix(in oklab, var(--c-${tx.status === "success" ? "green" : "red"}) 36%, var(--line-strong))` }}><SDot token={tx.status === "success" ? "green" : "red"} /><span style={{ color: `var(--c-${tx.status === "success" ? "green" : "red"})`, fontSize: 11.5 }}>{tx.status}</span></span>
            <span className="badge" style={{ height: 22, fontSize: 11 }}>{tx.kind}</span>
          </div>
          <SCopy text={tx.digest} display={tx.digest} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px,1fr))", gap: 14 }}>
          <div className="col" style={{ gap: 3 }}><span style={{ fontSize: 11, color: "var(--tx-lo)" }}>Sender</span><button className="row" onClick={() => go({ kind: "object", id: tx.senderAddr })} style={{ background: "none", border: "none", padding: 0, gap: 6 }}><span style={{ color: "var(--c-magenta)", fontSize: 13 }}>{tx.sender}</span><span className="mono" style={{ fontSize: 11, color: "var(--tx-lo)" }}>{sShort(tx.senderAddr)}</span></button></div>
          <div className="col" style={{ gap: 3 }}><span style={{ fontSize: 11, color: "var(--tx-lo)" }}>Timestamp</span><span style={{ fontSize: 13 }}>{sAgo(tx.timestamp)} ago</span></div>
          <div className="col" style={{ gap: 3 }}><span style={{ fontSize: 11, color: "var(--tx-lo)" }}>Checkpoint</span><span className="mono tnum" style={{ fontSize: 13, color: "var(--c-cyan)" }}>{tx.checkpoint.toLocaleString()}</span></div>
        </div>
      </div>

      <window.TxEffectsView tx={tx} />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18, alignItems: "start" }}>
        <div className="panel panel-pad">
          <div className="eyebrow" style={{ marginBottom: 10 }}>Events</div>
          {tx.events.map((e, i) => (
            <div key={i} className="col" style={{ gap: 8 }}>
              <span className="mono" style={{ fontSize: 12.5, color: "var(--c-blue)" }}>{e.type}</span>
              <div className="logbox"><window.JsonTree data={e.fields} /></div>
            </div>
          ))}
        </div>
        <div className="panel panel-pad">
          <div className="eyebrow" style={{ marginBottom: 10 }}>Programmable transaction</div>
          <div className="col" style={{ gap: 4 }}>
            {tx.inputs.commands.map((c, i) => (
              <div key={i} className="row" style={{ gap: 9 }}><span className="mono" style={{ fontSize: 11, color: "var(--tx-dim)", minWidth: 18 }}>{i}</span><span className="mono" style={{ fontSize: 12, color: "var(--tx-hi)" }}>{c}</span></div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function ObjectDetail({ id, go }) {
  const obj = useChainLoad(() => window.DSChain.objectDetail(id), id);
  if (!obj) return <DetailSkeleton />;
  return (
    <div className="col fade-up" style={{ gap: 18 }}>
      <div className="panel panel-pad">
        <div className="row between wrap" style={{ gap: 12, marginBottom: 14 }}>
          <SCopy text={obj.id} display={obj.id} />
          <span className="badge" style={{ height: 22, fontSize: 11 }}>v{obj.version}</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px,1fr))", gap: 14 }}>
          <div className="col" style={{ gap: 3 }}><span style={{ fontSize: 11, color: "var(--tx-lo)" }}>Type</span><span className="mono trunc" style={{ fontSize: 12.5, color: "var(--c-blue)", maxWidth: 320 }}>{obj.type}</span></div>
          <div className="col" style={{ gap: 3 }}><span style={{ fontSize: 11, color: "var(--tx-lo)" }}>Owner</span><span style={{ fontSize: 12.5 }}>{obj.owner.kind === "AddressOwner" ? <button onClick={() => go({ kind: "object", id: obj.owner.address })} style={{ background: "none", border: "none", padding: 0, color: "var(--c-magenta)", fontSize: 12.5, fontFamily: "var(--font-mono)" }}>{sShort(obj.owner.address)}</button> : <span className="badge" style={{ height: 19, fontSize: 10.5 }}>{obj.owner.kind}</span>}</span></div>
          <div className="col" style={{ gap: 3 }}><span style={{ fontSize: 11, color: "var(--tx-lo)" }}>Previous tx</span><button onClick={() => go({ kind: "tx", id: obj.previousTx })} style={{ background: "none", border: "none", padding: 0, color: "var(--c-cyan)", fontSize: 12.5, fontFamily: "var(--font-mono)", textAlign: "left" }}>{sShort(obj.previousTx, 8, 4)}</button></div>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 18, alignItems: "start" }}>
        <div className="panel panel-pad">
          <div className="eyebrow" style={{ marginBottom: 10 }}>Fields</div>
          <div className="logbox" style={{ maxHeight: 320 }}><window.JsonTree data={obj.fields} /></div>
        </div>
        <div className="panel" style={{ overflow: "hidden" }}>
          <div className="panel-pad" style={{ padding: "12px 16px" }}><SHead title="Dynamic fields" count={obj.dynamicFields.length} /></div>
          <table className="tbl">
            <thead><tr><th>Name</th><th>Type</th><th></th></tr></thead>
            <tbody>
              {obj.dynamicFields.map((f) => (
                <tr key={f.id} className="clickable" onClick={() => go({ kind: "object", id: f.id })}>
                  <td className="mono" style={{ fontSize: 12 }}>{f.name}</td>
                  <td className="mono trunc" style={{ fontSize: 11.5, color: "var(--tx-lo)", maxWidth: 130 }}>{f.type}</td>
                  <td><SIcon name="chevR" size={14} style={{ color: "var(--tx-dim)" }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function PackageDetail({ pkg, go }) {
  const [active, setActive] = sUseState(pkg.modules[0]);
  const fns = ["new", "settle", "cancel", "claim"].map((n) => ({ name: n, visibility: window.DSUtil.pick(["public", "public(package)", "entry"]), params: Math.floor(window.DSUtil.rnd(1, 4)) }));
  return (
    <div className="col fade-up" style={{ gap: 18 }}>
      <div className="panel panel-pad">
        <div className="row between wrap" style={{ gap: 12, marginBottom: 14 }}>
          <div className="row" style={{ gap: 10 }}>
            <SDot token={pkg.kind === "ours" ? "blue" : "white"} />
            <h3 style={{ fontSize: 16 }}>{pkg.name}</h3>
            {pkg.kind === "ours" && <span className="badge" style={{ height: 19, fontSize: 10, color: "var(--c-blue)" }}>published by this stack</span>}
          </div>
          <SCopy text={pkg.id} display={pkg.id} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px,1fr))", gap: 14 }}>
          <div className="col" style={{ gap: 3 }}><span style={{ fontSize: 11, color: "var(--tx-lo)" }}>Version</span><span className="mono tnum" style={{ fontSize: 13 }}>v{pkg.version}</span></div>
          <div className="col" style={{ gap: 3 }}><span style={{ fontSize: 11, color: "var(--tx-lo)" }}>Publisher</span><span style={{ fontSize: 13, color: "var(--c-magenta)" }}>{pkg.publisher}</span></div>
          {pkg.upgradeCap && <div className="col" style={{ gap: 3 }}><span style={{ fontSize: 11, color: "var(--tx-lo)" }}>Upgrade cap</span><SCopy text={pkg.upgradeCap} display={sShort(pkg.upgradeCap, 5, 3)} /></div>}
          {pkg.sourcePath && <div className="col" style={{ gap: 3 }}><span style={{ fontSize: 11, color: "var(--tx-lo)" }}>Source</span><span className="mono" style={{ fontSize: 12, color: "var(--tx-mid)" }}>{pkg.sourcePath}</span></div>}
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "200px 1fr", gap: 18, alignItems: "start" }}>
        <div className="panel" style={{ overflow: "hidden" }}>
          <div className="panel-pad" style={{ padding: "12px 14px" }}><span className="eyebrow">Modules</span></div>
          <div className="col" style={{ padding: "0 0 8px" }}>
            {pkg.modules.map((m) => (
              <button key={m} onClick={() => setActive(m)} className="row" style={{ gap: 8, padding: "8px 14px", background: active === m ? "var(--accent-soft)" : "transparent", border: "none", color: active === m ? "var(--tx-hi)" : "var(--tx-mid)", fontFamily: "var(--font-mono)", fontSize: 12.5, cursor: "pointer", textAlign: "left" }}>
                <SIcon name="hash" size={13} style={{ color: active === m ? "var(--accent)" : "var(--tx-dim)" }} /> {m}
              </button>
            ))}
          </div>
        </div>
        <div className="panel" style={{ overflow: "hidden" }}>
          <div className="panel-pad" style={{ padding: "14px 18px" }}><SHead title={`${active} — functions`} /></div>
          <table className="tbl">
            <thead><tr><th>Function</th><th>Visibility</th><th>Params</th></tr></thead>
            <tbody>
              {fns.map((f) => (
                <tr key={f.name}>
                  <td className="mono" style={{ fontSize: 12.5, color: "var(--c-blue)" }}>{f.name}</td>
                  <td><span className="badge" style={{ height: 19, fontSize: 10.5, color: f.visibility === "entry" ? "var(--c-yellow)" : "var(--tx-mid)" }}>{f.visibility}</span></td>
                  <td className="mono tnum" style={{ color: "var(--tx-lo)" }}>{f.params}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ============================================================ CONFIG */
function ConfigPanel({ api }) {
  const ds = window.DS;
  const id = ds.identity;
  const rows = [
    ["name", id.name], ["network", id.network], ["mode", id.mode], ["chainId", id.chainId],
    ["version", id.version], ["workdir", id.workdir], ["cycle", "#" + ds.cycle.id + " · " + ds.cycle.phase],
  ];
  return (
    <div className="col" style={{ gap: 18 }}>
      <div>
        <h2 style={{ fontSize: 19 }}>Config inspector</h2>
        <p style={{ color: "var(--tx-mid)", fontSize: 13, margin: "3px 0 0" }}>Resolved options &amp; endpoint registry. Read-only, live-updating.</p>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.3fr", gap: 18, alignItems: "start" }}>
        <div className="panel panel-pad">
          <SHead title="Identity" />
          <div className="col">
            {rows.map(([k, v]) => (
              <div key={k} className="row between" style={{ padding: "8px 0", borderBottom: "1px solid var(--line-faint)" }}>
                <span style={{ fontSize: 12.5, color: "var(--tx-lo)" }}>{k}</span>
                <span className="mono trunc" style={{ fontSize: 12, color: "var(--tx-hi)", maxWidth: 220, textAlign: "right" }}>{v}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="panel" style={{ overflow: "hidden" }}>
          <div className="panel-pad" style={{ padding: "14px 18px" }}><SHead title="Endpoint registry" count={ds.endpoints.length} /></div>
          <table className="tbl">
            <thead><tr><th>Key</th><th>Plugin</th><th>Protocol</th><th>URL</th></tr></thead>
            <tbody>
              {ds.endpoints.map((e) => (
                <tr key={e.key}>
                  <td className="mono" style={{ fontSize: 12 }}>{e.key}</td>
                  <td><span className="badge" style={{ height: 18, fontSize: 10.5 }}>{e.plugin}</span></td>
                  <td className="mono" style={{ fontSize: 11.5, color: "var(--tx-lo)" }}>{e.wire}</td>
                  <td><SCopy text={e.url} display={e.url.replace(/^https?:\/\//, "")} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { AccountsPanel, FaucetPanel, ExplorerPanel, ConfigPanel });
