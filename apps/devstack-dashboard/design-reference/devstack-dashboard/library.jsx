/* ============================================================
   library.jsx — design-system component gallery
   ============================================================ */
const { useState: lUseState } = React;
const L = window;

function Swatch({ name, varName, token, hex }) {
  const [copied, setCopied] = lUseState(false);
  const val = hex || `var(--${varName})`;
  return (
    <button className="panel" onClick={() => { navigator.clipboard.writeText(hex || varName); setCopied(true); setTimeout(() => setCopied(false), 1000); }}
      style={{ padding: 0, overflow: "hidden", textAlign: "left", cursor: "pointer", border: "1px solid var(--line)" }}>
      <div style={{ height: 56, background: token ? `var(--c-${token})` : val }} />
      <div style={{ padding: "8px 10px" }}>
        <div style={{ fontSize: 12.5, fontWeight: 540 }}>{name}</div>
        <div className="mono" style={{ fontSize: 10.5, color: "var(--tx-lo)" }}>{copied ? "copied!" : (hex || `--${varName}`)}</div>
      </div>
    </button>
  );
}

function Cell({ label, children, w }) {
  return (
    <div className="col" style={{ gap: 9, minWidth: w }}>
      {children}
      <span className="mono" style={{ fontSize: 10.5, color: "var(--tx-lo)" }}>{label}</span>
    </div>
  );
}

function Section({ id, title, desc, children }) {
  return (
    <section id={id} style={{ marginBottom: 40, scrollMarginTop: 24 }}>
      <div style={{ marginBottom: 16, paddingBottom: 12, borderBottom: "1px solid var(--line)" }}>
        <h2 style={{ fontSize: 17 }}>{title}</h2>
        {desc && <p style={{ color: "var(--tx-mid)", fontSize: 13, margin: "4px 0 0" }}>{desc}</p>}
      </div>
      {children}
    </section>
  );
}

const NAV_SECTIONS = [
  ["tokens", "Color tokens"], ["type", "Typography"], ["status", "Status"],
  ["buttons", "Buttons"], ["chips", "Badges & Chips"], ["domain", "Domain"],
  ["surfaces", "Surfaces & Layout"], ["tables", "Tables"], ["forms", "Form controls"],
  ["data", "Data display"], ["json", "JSON & Tx"], ["charts", "Charts"], ["banners", "Banners & filters"], ["coinid", "Coins & identity"], ["states", "States"], ["feedback", "Feedback"],
];

function Library() {
  const ds = window.DS;
  const [confirm, setConfirm] = lUseState(false);
  const [toasts, setToasts] = lUseState([]);
  const [seg, setSeg] = lUseState("Logs");
  const [selVal, setSelVal] = lUseState(ds.accounts[0].name);
  const [txtVal, setTxtVal] = lUseState("after-seed");
  const [numVal, setNumVal] = lUseState(100);
  const [sliderVal, setSliderVal] = lUseState(12);
  const [sw, setSw] = lUseState(true);
  const [msSel, setMsSel] = lUseState(["error", "warn"]);
  const [page, setPage] = lUseState(2);
  const fireToast = (token) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, token }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2600);
  };
  const ep = ds.endpoints[0];

  const STATUSES = ["ready", "active", "acquiring", "failed", "idle", "blocked"];
  const TOKENS = [["green", "ready"], ["yellow", "active / warn"], ["red", "failed"], ["cyan", "service"], ["magenta", "account / action"], ["blue", "package / snapshot"], ["white", "neutral"]];
  const SURFACES = ["bg-base", "bg-canvas", "bg-panel", "bg-elev", "bg-elev-2"];

  return (
    <div style={{ position: "relative", zIndex: 1, display: "flex", height: "100%" }}>
      <div className="atmos" />
      {/* side index */}
      <aside className="scroll-y" style={{ width: 212, flex: "none", borderRight: "1px solid var(--line)", padding: "22px 14px", height: "100%", background: "color-mix(in oklab, var(--bg-panel) 50%, var(--bg-base))" }}>
        <div className="row" style={{ gap: 10, marginBottom: 22, padding: "0 6px" }}>
          <div style={{ width: 30, height: 30, borderRadius: 8, background: "linear-gradient(145deg, var(--accent), color-mix(in oklab, var(--accent) 60%, #000))", color: "var(--accent-ink)", display: "grid", placeItems: "center", fontWeight: 700, fontFamily: "var(--font-mono)", fontSize: 16 }}>◆</div>
          <div className="col" style={{ gap: 1 }}><span style={{ fontWeight: 620, fontSize: 14 }}>Components</span><span className="mono" style={{ fontSize: 10, color: "var(--tx-lo)" }}>devstack DS</span></div>
        </div>
        <nav className="col" style={{ gap: 1 }}>
          {NAV_SECTIONS.map(([id, label]) => (
            <a key={id} href={"#" + id} className="nav-item" style={{ height: 33 }}
              onClick={(e) => { e.preventDefault(); const sec = document.getElementById(id); const main = document.querySelector("main.scroll-y"); if (sec && main) main.scrollTop = sec.offsetTop - 24; }}>{label}</a>
          ))}
        </nav>
        <div style={{ marginTop: 22, padding: "0 8px" }}>
          <a href="devstack dashboard.html" className="btn btn-sm" style={{ width: "100%" }}><L.Icon name="arrowR" size={13} /> Open dashboard</a>
        </div>
      </aside>

      {/* content */}
      <main className="scroll-y grow" style={{ padding: "32px 40px", minWidth: 0, minHeight: 0, height: "100%" }}>
        <div style={{ maxWidth: 1040 }}>
        <div style={{ marginBottom: 34 }}>
          <span className="eyebrow">Design system</span>
          <h1 style={{ fontSize: 30, letterSpacing: "-.025em", margin: "6px 0 8px" }}>devstack component library</h1>
          <p style={{ color: "var(--tx-mid)", fontSize: 14, maxWidth: 620, lineHeight: 1.6 }}>The atoms and domain components powering the dashboard. Everything is token-driven — restyle the whole system by editing the CSS variables in <span className="mono" style={{ color: "var(--accent)" }}>styles.css</span>. Click any swatch to copy its token.</p>
        </div>

        <Section id="tokens" title="Color tokens" desc="Semantic ColorTokens mirror the TUI display-derivation vocabulary. Surfaces are layered cool near-blacks.">
          <div className="eyebrow" style={{ marginBottom: 10 }}>Semantic</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(132px,1fr))", gap: 12, marginBottom: 22 }}>
            {TOKENS.map(([tok, use]) => <Swatch key={tok} name={use} token={tok} hex={`--c-${tok}`} />)}
            <Swatch name="accent" varName="accent" hex="--accent" />
          </div>
          <div className="eyebrow" style={{ marginBottom: 10 }}>Surfaces</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(132px,1fr))", gap: 12 }}>
            {SURFACES.map((s) => <Swatch key={s} name={s.replace("bg-", "")} varName={s} hex={`--${s}`} />)}
          </div>
        </Section>

        <Section id="type" title="Typography" desc="Geist for UI, Geist Mono for every machine value — ids, addresses, ports, digests, log lines.">
          <div className="panel panel-pad col" style={{ gap: 14 }}>
            <div><div style={{ fontSize: 30, fontWeight: 600, letterSpacing: "-.025em" }}>Display · 30 / 600</div><span className="mono" style={{ fontSize: 11, color: "var(--tx-lo)" }}>Geist</span></div>
            <div><div style={{ fontSize: 19, fontWeight: 560 }}>Heading · 19 / 560</div></div>
            <div><div style={{ fontSize: 14 }}>Body copy at 14px — the default reading size for descriptions and labels across the dashboard.</div></div>
            <div className="eyebrow">Eyebrow · 10.5 / 600 / .14em</div>
            <div className="mono" style={{ fontSize: 13 }}>0x9f3a…a1c2 · :9124 · GraphQL · 18,442 — Geist Mono</div>
          </div>
        </Section>

        <Section id="status" title="Status" desc="LifecycleStatus → StatusBadge via statusGlyph / statusColor / statusLabel. Active & acquiring states pulse.">
          <div className="panel panel-pad col" style={{ gap: 18 }}>
            <div className="row wrap" style={{ gap: 10 }}>{STATUSES.map((s) => <L.StatusBadge key={s} status={s} />)}</div>
            <div className="row wrap" style={{ gap: 18 }}>
              {[["green", false], ["yellow", true], ["red", false], ["cyan", true], ["magenta", false], ["blue", false]].map(([t, p], i) => (
                <Cell key={i} label={t}><L.Dot token={t} pulse={p} /></Cell>
              ))}
            </div>
          </div>
        </Section>

        <Section id="buttons" title="Buttons" desc="One button system, variants by intent. 32px default, 27px small.">
          <div className="panel panel-pad row wrap" style={{ gap: 12, alignItems: "center" }}>
            <button className="btn btn-primary"><L.Icon name="zap" size={14} /> Primary</button>
            <button className="btn">Default</button>
            <button className="btn btn-danger"><L.Icon name="trash" size={14} /> Danger</button>
            <button className="btn btn-ghost">Ghost</button>
            <button className="btn btn-sm">Small</button>
            <button className="iconbtn"><L.Icon name="refresh" /></button>
            <button className="iconbtn"><L.Icon name="search" /></button>
            <button className="btn" disabled>Disabled</button>
          </div>
        </Section>

        <Section id="chips" title="Badges & Chips" desc="Compact metadata. CopyChip copies on click; AddressChip truncates + labels.">
          <div className="panel panel-pad row wrap" style={{ gap: 14, alignItems: "center" }}>
            <span className="badge"><L.Dot token="green" /> badge</span>
            <span className="badge" style={{ color: "var(--c-cyan)" }}>service</span>
            <L.CopyChip text="0x9f3a2b1c4d5e6f7a8b9c0d1e2f3a4b5c" display="0x9f3a…4b5c" />
            <L.AddressChip address={ds.accounts[0].address} name="deployer" />
            <L.EndpointLink ep={ep} />
            <L.CoinAmount mist={100e9} symbol="SUI" />
            <L.LevelPill level="error" />
            <L.LevelPill level="warn" />
            <L.LevelPill level="info" />
          </div>
        </Section>

        <Section id="domain" title="Domain components" desc="Higher-order pieces mapped to real projection shapes.">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px,1fr))", gap: 12 }}>
            <L.Kpi label="Services" value="7/11" sub="ready" token="green" icon="layers" />
            <L.Kpi label="Throughput" value="12" sub="tx / s" token="cyan" icon="activity" live />
            <L.Kpi label="Packages" value="3" sub="published" token="blue" icon="box" />
          </div>
        </Section>

        <Section id="surfaces" title="Surfaces & Layout" desc="Panel is the base surface; DefList renders key/value rows; Meter shows proportions; Segmented switches views; Collapsible hides secondary detail.">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18, alignItems: "start" }}>
            <L.Panel pad header={<L.PanelHeader title="Panel with header" count={3} right={<button className="btn btn-sm btn-ghost">Action</button>} />}>
              <L.DefList items={[["network", "local"], ["chainId", "0x9f3a2b1c"], ["version", "0.9.4"]]} />
            </L.Panel>
            <div className="col" style={{ gap: 18 }}>
              <div className="panel panel-pad col" style={{ gap: 12 }}>
                <L.Segmented value={seg} onChange={setSeg} options={["Logs", "Events", "Traces"]} />
                <div className="col" style={{ gap: 8 }}>
                  <span className="row between" style={{ gap: 10 }}><span style={{ fontSize: 12.5, color: "var(--tx-lo)" }}>objects</span><L.Meter value={84} max={100} token="blue" width={160} /></span>
                  <span className="row between" style={{ gap: 10 }}><span style={{ fontSize: 12.5, color: "var(--tx-lo)" }}>events</span><L.Meter value={42} max={100} token="cyan" width={160} /></span>
                  <span className="row between" style={{ gap: 10 }}><span style={{ fontSize: 12.5, color: "var(--tx-lo)" }}>checkpoints</span><L.Meter value={100} token="green" width={160} /></span>
                </div>
              </div>
              <L.Collapsible title="Advanced options" right={<span className="badge" style={{ height: 18, fontSize: 10 }}>3</span>}>
                <L.DefList items={[["pruneOnExit", "false"], ["hostTree", "true"], ["forkHeight", "—"]]} />
              </L.Collapsible>
            </div>
          </div>
        </Section>

        <Section id="tables" title="DataTable" desc="Config-driven table: pass columns + rows. Sortable headers, custom cell renderers, row-click, alignment. The canonical table pattern — the dashboard's ~12 tables can all be expressed this way; adopt it as the single table primitive in the rebuild.">
          <div className="panel" style={{ overflow: "hidden" }}>
            <L.DataTable
              sortable
              rows={ds.rows.slice(0, 6)}
              rowKey={(r) => r.key}
              columns={[
                { key: "title", label: "Service", render: (r) => <span style={{ fontWeight: 540 }}>{r.title}</span> },
                { key: "status", label: "Status", render: (r) => <L.StatusBadge status={r.status} /> },
                { key: "role", label: "Role", render: (r) => <span className="badge" style={{ height: 19, fontSize: 11 }}>{r.role}</span> },
                { key: "uptime", label: "Uptime", align: "right", sortVal: (r) => r.uptime, render: (r) => <span className="mono tnum" style={{ color: "var(--tx-lo)" }}>{r.uptime ? r.uptime + "m" : "—"}</span> },
              ]} />
          </div>
          <p style={{ fontSize: 12.5, color: "var(--tx-lo)", margin: "10px 2px 0" }}>↑ Click a column header to sort.</p>
        </Section>

        <Section id="forms" title="Form controls" desc="Field wraps a labeled control; Select / TextInput / NumberInput / Slider / Switch are the input primitives, all token-styled.">
          <div className="panel panel-pad" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px,1fr))", gap: 18, alignItems: "start" }}>
            <L.Field label="Account"><L.Select value={selVal} onChange={setSelVal} options={ds.accounts.map((a) => a.name)} /></L.Field>
            <L.Field label="Snapshot name" hint="lowercase, no spaces"><L.TextInput value={txtVal} onChange={setTxtVal} mono placeholder="snapshot-name" /></L.Field>
            <L.Field label="Amount"><L.NumberInput value={numVal} onChange={setNumVal} /></L.Field>
            <L.Field label="Spread"><L.Slider value={sliderVal} min={2} max={50} suffix="bps" onChange={setSliderVal} /></L.Field>
            <L.Field label="Market maker"><span className="row" style={{ gap: 9 }}><L.Switch checked={sw} onChange={setSw} /><span style={{ fontSize: 12.5, color: sw ? "var(--c-green)" : "var(--tx-lo)" }}>{sw ? "running" : "stopped"}</span></span></L.Field>
          </div>
        </Section>

        <Section id="data" title="Data display" desc="Dense tables with sticky headers, tabular-nums, and inline meters.">
          <div className="panel" style={{ overflow: "hidden" }}>
            <table className="tbl">
              <thead><tr><th>Resource</th><th>Status</th><th>Endpoint</th><th>Load</th></tr></thead>
              <tbody>
                {ds.rows.slice(0, 4).map((r) => (
                  <tr key={r.key}>
                    <td style={{ fontWeight: 540 }}>{r.title}</td>
                    <td><L.StatusBadge status={r.status} /></td>
                    <td>{r.endpoints[0] ? <L.EndpointLink ep={ds.endpoints.find((e) => e.key === r.endpoints[0])} /> : <span style={{ color: "var(--tx-dim)" }}>—</span>}</td>
                    <td style={{ width: 180 }}><div className="meter"><span style={{ width: (30 + r.title.length * 4) + "%" }} /></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section id="json" title="JSON & Transactions" desc="JsonTree renders any object recursively (collapsible, address-aware). TxEffectsView decodes a transaction's on-chain effects.">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18, alignItems: "start" }}>
            <div className="panel panel-pad">
              <div className="eyebrow" style={{ marginBottom: 10 }}>JsonTree</div>
              <div className="logbox"><L.JsonTree data={{ id: ds.accounts[0].address, balance: 100000000000, locked: false, metadata: { name: "Escrow #7", epoch: 0, tags: ["test", "seeded"] } }} /></div>
            </div>
            <div className="panel panel-pad">
              <div className="eyebrow" style={{ marginBottom: 10 }}>Breadcrumbs · Tooltip</div>
              <div className="col" style={{ gap: 16 }}>
                <L.Breadcrumbs items={[{ label: "Explorer", onClick: () => {} }, { label: "Transaction", onClick: () => {} }, { label: "sEGP…ZxxV" }]} />
                <div className="row" style={{ gap: 12 }}>
                  <L.Tooltip label="Copied to clipboard"><button className="btn btn-sm">Hover me</button></L.Tooltip>
                  <L.Tooltip label="Restart this resource" side="bottom"><button className="iconbtn"><L.Icon name="refresh" /></button></L.Tooltip>
                </div>
                <L.ErrorPanel code="PublishFailed" summary="Move verifier rejected `escrow::settle`." hint="Check entry function visibility." compact />
              </div>
            </div>
          </div>
        </Section>

        <Section id="charts" title="Charts" desc="Real Recharts (the same engine shadcn/ui charts use) themed with --viz-* tokens — Sparkline, AreaChart, BarChart, and a DepthChart for order books. Ports 1:1 to <ChartContainer>.">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18, alignItems: "start" }}>
            <div className="panel panel-pad">
              <div className="eyebrow" style={{ marginBottom: 10 }}>AreaChart</div>
              <L.AreaChart data={ds.history.tps} color="var(--viz-1)" height={130} axis />
            </div>
            <div className="panel panel-pad">
              <div className="eyebrow" style={{ marginBottom: 10 }}>BarChart</div>
              <L.BarChart data={ds.history.txPerDay} color="var(--viz-2)" height={130} axis />
            </div>
            <div className="panel panel-pad">
              <div className="eyebrow" style={{ marginBottom: 10 }}>DepthChart · order book</div>
              <L.DepthChart bids={ds.plugins.deepbook.orderBook.bids} asks={ds.plugins.deepbook.orderBook.asks} height={130} />
            </div>
            <div className="panel panel-pad">
              <div className="eyebrow" style={{ marginBottom: 14 }}>Sparkline · inline</div>
              <div className="col" style={{ gap: 14 }}>
                {[["viz-1", "TPS"], ["c-green", "balance"], ["c-red", "errors"]].map(([c, l]) => (
                  <div key={l} className="row between"><span style={{ fontSize: 12.5, color: "var(--tx-lo)" }}>{l}</span><L.Sparkline data={ds.history.tps.map((v) => v + Math.random() * 3)} color={`var(--${c})`} width={120} height={28} /></div>
                ))}
              </div>
            </div>
          </div>
        </Section>

        <Section id="banners" title="Banners & filters" desc="Banner (info / warn / success / danger / neutral) for system states like reconnecting or indexer-degraded. MultiSelect is the faceted filter used in the Console; Pagination drives long relay-connection lists.">
          <div className="col" style={{ gap: 12 }}>
            <L.Banner tone="info" title="Connected to local · indexer online">Historical lists &amp; analytics available.</L.Banner>
            <L.Banner tone="warn" title="Connection lost — showing last known state">Reconnecting to the SSE stream…</L.Banner>
            <L.Banner tone="danger" title="Indexer unavailable">Historical queries are degraded. Point lookups still work over gRPC.</L.Banner>
            <L.Banner tone="success" title="Snapshot restored" onClose={() => {}}>Stack is back at “after-seed”.</L.Banner>
          </div>
          <div className="panel panel-pad row wrap" style={{ gap: 12, marginTop: 14, alignItems: "center" }}>
            <L.MultiSelect label="Level" icon="filter" selected={msSel} onToggle={(v) => setMsSel((s) => s.includes(v) ? s.filter((x) => x !== v) : [...s, v])}
              options={[{ value: "error", label: "error", token: "red" }, { value: "warn", label: "warn", token: "yellow" }, { value: "info", label: "info", token: "cyan" }, { value: "debug", label: "debug", token: "white" }]} />
            <span style={{ fontSize: 12.5, color: "var(--tx-lo)" }}>{msSel.length} selected</span>
            <div className="grow" />
            <L.Pagination page={page} pageCount={8} onPage={setPage} />
          </div>
        </Section>

        <Section id="coinid" title="Coins & identity" desc="CoinIcon renders a token glyph per symbol; Identicon is a deterministic avatar from an address; CodeBlock highlights Move source / normalized ABI on the package-detail view.">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18, alignItems: "start" }}>
            <div className="col" style={{ gap: 14 }}>
              <div className="panel panel-pad">
                <div className="eyebrow" style={{ marginBottom: 12 }}>CoinIcon</div>
                <div className="row wrap" style={{ gap: 16 }}>
                  {["SUI", "USDC", "DEEP", "WAL", "NS"].map((s) => <span key={s} className="row" style={{ gap: 7 }}><L.CoinIcon symbol={s} size={24} /><span className="mono" style={{ fontSize: 12.5 }}>{s}</span></span>)}
                </div>
              </div>
              <div className="panel panel-pad">
                <div className="eyebrow" style={{ marginBottom: 12 }}>Identicon</div>
                <div className="row wrap" style={{ gap: 12 }}>
                  {ds.accounts.slice(0, 6).map((a) => <L.Identicon key={a.name} address={a.address} size={34} />)}
                </div>
              </div>
            </div>
            <div className="panel panel-pad">
              <div className="eyebrow" style={{ marginBottom: 10 }}>CodeBlock · Move</div>
              <L.CodeBlock lang="move" code={`module escrow::escrow {\n    use sui::coin::Coin;\n\n    public struct Escrow has key {\n        id: UID,\n        amount: u64,\n    }\n\n    // settle the locked balance\n    public entry fun settle(e: Escrow, ctx: &mut TxContext) {\n        let Escrow { id, amount } = e;\n        transfer::public_transfer(coin, tx_context::sender(ctx));\n        object::delete(id);\n    }\n}`} />
            </div>
          </div>
        </Section>

        <Section id="states" title="System states" desc="Loading skeletons, funding status, and the empty state — what each panel shows before data, while funding, or when there's nothing.">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18, alignItems: "start" }}>
            <div className="panel" style={{ overflow: "hidden" }}>
              <div className="panel-pad" style={{ padding: "12px 16px" }}><div className="eyebrow">Skeleton (loading)</div></div>
              <L.SkeletonRows rows={4} cols={3} />
            </div>
            <div className="col" style={{ gap: 18 }}>
              <div className="panel panel-pad">
                <div className="eyebrow" style={{ marginBottom: 10 }}>FundingStatus</div>
                <div className="row wrap" style={{ gap: 16 }}>
                  {["funded", "cached", "pending", "skipped", "failed"].map((s) => <L.FundingStatus key={s} funding={{ status: s }} />)}
                </div>
              </div>
              <div className="panel" style={{ overflow: "hidden" }}><L.EmptyState icon="box" title="No snapshots yet" hint="Capture one from Controls to roll back to this point." /></div>
            </div>
          </div>
        </Section>

        <Section id="feedback" title="Feedback" desc="Toasts for command acks; ConfirmDialog gates destructive and stateful actions.">
            <div className="panel panel-pad row wrap" style={{ gap: 12 }}>
            <button className="btn" onClick={() => fireToast("green")}>Success toast</button>
            <button className="btn" onClick={() => fireToast("red")}>Error toast</button>
            <button className="btn btn-danger" onClick={() => setConfirm(true)}>Open confirm</button>
          </div>
        </Section>
        <div style={{ height: 40 }} />
        </div>
      </main>

      <L.ConfirmDialog open={confirm} danger title="Wipe all state?" body="Destroys all containers, volumes, and the chain itself — a full genesis reset. This cannot be undone." confirmLabel="Wipe everything" onCancel={() => setConfirm(false)} onConfirm={() => { setConfirm(false); fireToast("red"); }} />

      <div className="toast-wrap">
        {toasts.map((tt) => (
          <div key={tt.id} className="toast"><L.Dot token={tt.token} /><span style={{ fontSize: 13 }}>{tt.token === "green" ? "snapshot.capture acknowledged" : "FaucetExhausted — try again"}</span></div>
        ))}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<Library />);
