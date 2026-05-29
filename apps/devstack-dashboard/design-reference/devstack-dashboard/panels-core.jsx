/* ============================================================
   panels-core.jsx — Overview, Services (+detail), Controls
   ============================================================ */
const { Icon, StatusBadge, Dot, statusInfo, CopyChip, AddressChip, EndpointLink,
  CoinAmount, fmtMist, Kpi, SectionHead, EmptyState, ago, short, ConfirmDialog } = window;
const { useState: cUseState, useEffect: cUseEffect, useRef: cUseRef } = React;

const SECTION_LABEL = { core: "Core", infra: "Infrastructure", service: "Services", plugin: "Plugins" };

function narrationFor(r) {
  if (r.status === "failed") return r.err ? r.err.summary : "Failed";
  return r.phase;
}

/* ============================================================ OVERVIEW */
function OverviewPanel({ api }) {
  const ds = window.DS;
  const [, force] = cUseState(0);
  cUseEffect(() => window.DSBus.subscribe((t) => { if (t === "row" || t === "tick") force((x) => x + 1); }), []);

  const ready = ds.rows.filter((r) => r.status === "ready").length;
  const failed = ds.rows.filter((r) => r.status === "failed");
  const fundedAcc = ds.accounts.filter((a) => ["funded", "cached", "skipped"].includes(a.funding.status)).length;
  const oursPkg = ds.packages.filter((p) => p.kind === "ours").length;
  const upMin = Math.floor((Date.now() - ds.identity.startedAt) / 60000);

  const grouped = ["core", "infra", "service", "plugin"].map((sec) => ({
    sec, rows: ds.rows.filter((r) => r.section === sec),
  }));

  return (
    <div className="col" style={{ gap: 22 }}>
      {/* KPI row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(168px, 1fr))", gap: 14 }}>
        <Kpi label="Services" value={`${ready}/${ds.rows.length}`} sub="ready" token="green" icon="layers" />
        <Kpi label="Checkpoint" value={ds.netStats.checkpoint.toLocaleString()} sub={`epoch ${ds.netStats.epoch}`} icon="box" live spark={ds.history.cp} />
        <Kpi label="Throughput" value={ds.netStats.tps} sub="tx / s" token="cyan" icon="activity" live spark={ds.history.tps} />
        <Kpi label="Accounts" value={`${fundedAcc}/${ds.accounts.length}`} sub="funded" token="magenta" icon="wallet" />
        <Kpi label="Packages" value={oursPkg} sub="published" token="blue" icon="box" />
        <Kpi label="Uptime" value={upMin >= 60 ? (upMin / 60).toFixed(1) + "h" : upMin + "m"} sub={`cycle #${ds.cycle.id}`} icon="clock" />
      </div>

      {failed.length > 0 && (
        <div className="panel panel-pad fade-up" style={{ borderColor: "color-mix(in oklab, var(--c-red) 34%, var(--line))", background: "color-mix(in oklab, var(--c-red) 6%, var(--bg-panel))" }}>
          <div className="row" style={{ gap: 11 }}>
            <Icon name="alert" size={18} style={{ color: "var(--c-red)", flex: "none" }} />
            <div className="grow">
              <div style={{ fontWeight: 560, marginBottom: 2 }}>{failed.length} service{failed.length > 1 ? "s" : ""} need{failed.length > 1 ? "" : "s"} attention</div>
              <div style={{ color: "var(--tx-mid)", fontSize: 12.5 }}>{failed.map((r) => r.title).join(", ")} — {failed[0].err?.summary}</div>
            </div>
            <button className="btn btn-sm" onClick={() => api.openService(failed[0].key)}>Inspect</button>
          </div>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1.55fr 1fr", gap: 22, alignItems: "start" }}>
        {/* status grid */}
        <div className="panel" style={{ overflow: "hidden" }}>
          <div className="panel-pad" style={{ paddingBottom: 0 }}>
            <SectionHead title="Stack status" count={ds.rows.length}
              right={<button className="btn btn-sm btn-ghost" onClick={() => api.goto("services")}>All services <Icon name="arrowR" size={13} /></button>} />
          </div>
          <div className="col" style={{ padding: "4px 0 8px" }}>
            {grouped.map(({ sec, rows }) => rows.length === 0 ? null : (
              <div key={sec}>
                <div className="eyebrow" style={{ padding: "10px 18px 6px" }}>{SECTION_LABEL[sec]}</div>
                {rows.map((r) => {
                  const i = statusInfo(r.status);
                  return (
                    <div key={r.key} className="row" onClick={() => api.openService(r.key)}
                      style={{ padding: "8px 18px", gap: 12, cursor: "pointer", borderRadius: 0 }}
                      onMouseEnter={(e) => e.currentTarget.style.background = "var(--bg-hover)"}
                      onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}>
                      <Dot token={i.token} pulse={r.status === "active" || r.status === "acquiring"} />
                      <span style={{ fontWeight: 530, minWidth: 132 }}>{r.title}</span>
                      <span className="trunc grow" style={{ color: "var(--tx-mid)", fontSize: 12.5 }}>{narrationFor(r)}</span>
                      <span style={{ color: `var(--c-${i.token})`, fontSize: 12, fontWeight: 540 }}>{i.label}</span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        {/* right column: endpoints + activity */}
        <div className="col" style={{ gap: 22 }}>
          <div className="panel panel-pad">
            <SectionHead title="Endpoints" count={ds.endpoints.length} />
            <div className="col" style={{ gap: 7 }}>
              {ds.endpoints.slice(0, 6).map((ep) => (
                <div key={ep.key} className="row between" style={{ gap: 8 }}>
                  <EndpointLink ep={ep} />
                  <CopyChip text={ep.url} display={ep.url.replace(/^https?:\/\//, "")} />
                </div>
              ))}
            </div>
          </div>
          <RecentActivity api={api} />
        </div>
      </div>
    </div>
  );
}

function RecentActivity({ api, max = 7 }) {
  const [items, setItems] = cUseState(() => window.DS.events.slice(-max).reverse());
  cUseEffect(() => window.DSBus.subscribe((t, p) => {
    if (t === "event") setItems((prev) => [p, ...prev].slice(0, max));
  }), []);
  return (
    <div className="panel panel-pad">
      <SectionHead title="Recent activity"
        right={<button className="btn btn-sm btn-ghost" onClick={() => api.goto("activity")}>Open feed <Icon name="arrowR" size={13} /></button>} />
      <div className="col" style={{ gap: 2 }}>
        {items.map((ev) => (
          <div key={ev.id} className="row fade-up" style={{ gap: 9, padding: "5px 0" }}>
            <Dot token={ev.color} />
            <span className="mono" style={{ fontSize: 11, color: "var(--tx-lo)", minWidth: 92 }}>{ev.tag}</span>
            <span className="trunc grow" style={{ fontSize: 12.5, color: "var(--tx-mid)" }}>{ev.message}</span>
            <span className="mono" style={{ fontSize: 11, color: "var(--tx-dim)" }}>{ago(ev.at)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ============================================================ SERVICES */
function ServicesPanel({ api }) {
  const ds = window.DS;
  const [, force] = cUseState(0);
  cUseEffect(() => window.DSBus.subscribe((t) => { if (t === "row") force((x) => x + 1); }), []);
  const grouped = ["core", "infra", "service", "plugin"].map((sec) => ({ sec, rows: ds.rows.filter((r) => r.section === sec) }));

  return (
    <div className="col" style={{ gap: 18 }}>
      <div className="row between wrap" style={{ gap: 12 }}>
        <div>
          <h2 style={{ fontSize: 19 }}>Services &amp; Plugins</h2>
          <p style={{ color: "var(--tx-mid)", fontSize: 13, margin: "3px 0 0" }}>Every resource the supervisor manages, grouped by role. Click a row for lifecycle &amp; controls.</p>
        </div>
        <button className="btn btn-sm" onClick={() => api.command("apply", "Apply requested")}><Icon name="refresh" size={14} /> Apply all</button>
      </div>

      {grouped.map(({ sec, rows }) => rows.length === 0 ? null : (
        <div key={sec} className="panel" style={{ overflow: "hidden" }}>
          <div className="panel-pad" style={{ padding: "12px 18px" }}>
            <span className="eyebrow">{SECTION_LABEL[sec]}</span>
          </div>
          <table className="tbl">
            <thead><tr>
              <th style={{ width: 130 }}>Status</th><th>Service</th><th>Phase</th>
              <th>Role</th><th>Owner</th><th>Endpoints</th><th style={{ width: 70 }}>Uptime</th><th style={{ width: 40 }}></th>
            </tr></thead>
            <tbody>
              {rows.map((r) => {
                const eps = r.endpoints.map((k) => ds.endpoints.find((e) => e.key === k)).filter(Boolean);
                return (
                  <tr key={r.key} className="clickable" onClick={() => api.openService(r.key)}>
                    <td><StatusBadge status={r.status} /></td>
                    <td><span style={{ fontWeight: 540 }}>{r.title}</span></td>
                    <td style={{ color: r.status === "failed" ? "var(--c-red)" : "var(--tx-mid)", fontSize: 12.5, maxWidth: 260 }}><div className="trunc">{narrationFor(r)}</div></td>
                    <td><span className="badge" style={{ height: 19, fontSize: 11 }}>{r.role}</span></td>
                    <td>{r.owner === "system" ? <span style={{ color: "var(--tx-lo)", fontSize: 12 }}>system</span> : <CopyChip text={r.owner} display={short(r.owner, 4, 2)} />}</td>
                    <td><div className="row wrap" style={{ gap: 5 }}>{eps.length ? eps.map((e) => <EndpointLink key={e.key} ep={e} />) : <span style={{ color: "var(--tx-dim)" }}>—</span>}</div></td>
                    <td className="mono tnum" style={{ fontSize: 12, color: "var(--tx-lo)" }}>{r.uptime ? r.uptime + "m" : "—"}</td>
                    <td><Icon name="chevR" size={15} style={{ color: "var(--tx-dim)" }} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

/* service detail drawer (right sheet) */
function ServiceDrawer({ rowKey, api, onClose }) {
  const ds = window.DS;
  const r = ds.rows.find((x) => x.key === rowKey);
  const [tail, setTail] = cUseState(() => (ds.logs[rowKey] || []).slice(-12));
  const [, force] = cUseState(0);
  cUseEffect(() => window.DSBus.subscribe((t, p) => {
    if (t === "log" && p.tag === rowKey) setTail((prev) => [...prev, p].slice(-40));
    if (t === "row" && p === rowKey) force((x) => x + 1);
  }), [rowKey]);
  if (!r) return null;
  const i = statusInfo(r.status);
  const eps = r.endpoints.map((k) => ds.endpoints.find((e) => e.key === k)).filter(Boolean);
  const evs = ds.events.filter((e) => e.plugin === rowKey).slice(-8).reverse();

  return (
    <div className="overlay overlay-right" onClick={onClose}>
      <div className="sheet fade-right" onClick={(e) => e.stopPropagation()}>
        <div className="row between" style={{ padding: "16px 20px", borderBottom: "1px solid var(--line)" }}>
          <div className="row" style={{ gap: 11 }}>
            <Dot token={i.token} pulse={r.status === "active" || r.status === "acquiring"} />
            <div>
              <h3 style={{ fontSize: 16 }}>{r.title}</h3>
              <span className="mono" style={{ fontSize: 11.5, color: "var(--tx-lo)" }}>{r.key} · {r.role}</span>
            </div>
          </div>
          <button className="iconbtn" onClick={onClose}><Icon name="x" /></button>
        </div>

        <div className="scroll-y" style={{ padding: 20, flex: 1, display: "flex", flexDirection: "column", gap: 20 }}>
          <div className="row between"><StatusBadge status={r.status} /><span style={{ color: "var(--tx-mid)", fontSize: 12.5 }}>{narrationFor(r)}</span></div>

          {r.err && (
            <div className="panel panel-pad" style={{ borderColor: "color-mix(in oklab, var(--c-red) 36%, var(--line))", background: "color-mix(in oklab, var(--c-red) 7%, var(--bg-elev))" }}>
              <div className="row" style={{ gap: 8, marginBottom: 6 }}><Icon name="alert" size={15} style={{ color: "var(--c-red)" }} /><span className="mono" style={{ fontSize: 12, color: "var(--c-red)", fontWeight: 600 }}>{r.err.code}</span></div>
              <div style={{ fontSize: 13, color: "var(--tx-hi)", marginBottom: 6 }}>{r.err.summary}</div>
              {r.err.hint && <div style={{ fontSize: 12, color: "var(--tx-mid)" }}>↳ {r.err.hint}</div>}
            </div>
          )}

          {eps.length > 0 && <div>
            <div className="eyebrow" style={{ marginBottom: 8 }}>Endpoints</div>
            <div className="col" style={{ gap: 6 }}>{eps.map((e) => <div key={e.key} className="row between"><EndpointLink ep={e} /><CopyChip text={e.url} display={e.url.replace(/^https?:\/\//, "")} /></div>)}</div>
          </div>}

          <div>
            <div className="eyebrow" style={{ marginBottom: 8 }}>Recent events</div>
            <div className="col" style={{ gap: 4 }}>
              {evs.length ? evs.map((ev) => <div key={ev.id} className="row" style={{ gap: 8 }}><Dot token={ev.color} /><span className="trunc grow" style={{ fontSize: 12.5, color: "var(--tx-mid)" }}>{ev.message}</span><span className="mono" style={{ fontSize: 11, color: "var(--tx-dim)" }}>{ago(ev.at)}</span></div>) : <span style={{ color: "var(--tx-dim)", fontSize: 12.5 }}>No events this cycle.</span>}
            </div>
          </div>

          <div className="grow">
            <div className="eyebrow" style={{ marginBottom: 8 }}>Live log <span className="dot dot-cyan dot-pulse" style={{ marginLeft: 4 }} /></div>
            <div className="logbox mono">
              {tail.map((l) => <div key={l.id} className="row" style={{ gap: 8, padding: "1px 0" }}><span style={{ color: "var(--tx-dim)", fontSize: 11 }}>{new Date(l.at).toLocaleTimeString("en", { hour12: false })}</span><span style={{ color: `var(--c-${window.LEVEL_TOKEN[l.level] || "white"})`, fontSize: 11.5 }}>{l.message}</span></div>)}
            </div>
          </div>
        </div>

        <div className="row" style={{ gap: 9, padding: "14px 20px", borderTop: "1px solid var(--line)" }}>
          <button className="btn grow" onClick={() => api.command("restart/" + r.key, `Restarting ${r.title}`)}><Icon name="refresh" size={14} /> Restart</button>
          <button className="btn" onClick={() => api.command("apply", `Apply ${r.title}`)}><Icon name="zap" size={14} /> Apply</button>
          <button className="iconbtn" onClick={() => api.goto("activity", { tab: "logs", plugin: r.key })} title="Open in console"><Icon name="terminal" /></button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================ CONTROLS */
function ControlsPanel({ api }) {
  const ds = window.DS;
  const isFork = ds.identity.mode === "fork";
  const [snaps, setSnaps] = cUseState(ds.snapshots);
  const [confirm, setConfirm] = cUseState(null);
  const [capturing, setCapturing] = cUseState(null); // {phase, pct}
  const [naming, setNaming] = cUseState(null); // proposed name string | null

  const runCapture = (name) => {
    const phases = ["quiescing engine", "dumping postgres", "archiving host-tree", "writing manifest", "complete"];
    let i = 0;
    setCapturing({ phase: phases[0], pct: 0 });
    const iv = setInterval(() => {
      i++;
      if (i >= phases.length) {
        clearInterval(iv);
        const ns = { id: "snap_" + window.DSUtil.hex(6), label: name || ("snapshot-" + (snaps.length + 1)), createdAt: Date.now(), participants: 11, containers: 3, hostTree: true, sizeMb: Math.round(window.DSUtil.rnd(90, 200)) };
        ds.snapshots = [ns, ...ds.snapshots]; setSnaps(ds.snapshots);
        setCapturing(null); api.toast(`Snapshot “${ns.label}” captured`, "green");
      } else setCapturing({ phase: phases[i], pct: i / (phases.length - 1) });
    }, 700);
  };

  const cmds = [
    { id: "restart", label: "Restart stack", icon: "refresh", desc: "Cycle all services, keep state", token: "yellow" },
    { id: "apply", label: "Apply", icon: "zap", desc: "Reconcile config → running stack", token: "cyan" },
    { id: "codegen", label: "Codegen", icon: "hash", desc: "Regenerate typed bindings", token: "blue" },
    { id: "prune", label: "Prune", icon: "filter", desc: "Drop dangling containers & volumes", token: "yellow", confirm: true },
    { id: "advance-clock", label: "Advance clock", icon: "clock", desc: isFork ? "Fast-forward chain time" : "Fork mode only", token: "blue", disabled: !isFork },
    { id: "wipe", label: "Wipe", icon: "trash", desc: "Destroy all state — genesis reset", token: "red", confirm: true, danger: true },
    { id: "shutdown", label: "Shutdown", icon: "power", desc: "Graceful stop of the whole stack", token: "red", confirm: true, danger: true },
  ];

  const doCmd = (c) => {
    if (c.confirm) setConfirm(c);
    else api.command(c.id, c.label + " requested");
  };

  const openNaming = () => setNaming("snapshot-" + (snaps.length + 1));

  return (
    <div className="col" style={{ gap: 22 }}>
      <div>
        <h2 style={{ fontSize: 19 }}>Controls &amp; Operations</h2>
        <p style={{ color: "var(--tx-mid)", fontSize: 13, margin: "3px 0 0" }}>Engine commands dispatched in-process. The UI waits for the projection to reflect the effect.</p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(232px, 1fr))", gap: 14 }}>
        {cmds.map((c) => (
          <button key={c.id} className="panel panel-pad" disabled={c.disabled} onClick={() => doCmd(c)}
            style={{ textAlign: "left", cursor: c.disabled ? "not-allowed" : "pointer", opacity: c.disabled ? .5 : 1, transition: ".14s", display: "flex", flexDirection: "column", gap: 8 }}
            onMouseEnter={(e) => { if (!c.disabled) { e.currentTarget.style.borderColor = `color-mix(in oklab, var(--c-${c.token}) 50%, var(--line))`; e.currentTarget.style.transform = "translateY(-1px)"; } }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--line)"; e.currentTarget.style.transform = "none"; }}>
            <div className="row between">
              <div style={{ width: 34, height: 34, borderRadius: 9, display: "grid", placeItems: "center", background: `color-mix(in oklab, var(--c-${c.token}) 13%, transparent)`, color: `var(--c-${c.token})` }}><Icon name={c.icon} size={17} /></div>
              {c.danger && <span className="badge" style={{ height: 18, fontSize: 10, color: "var(--c-red)" }}>destructive</span>}
            </div>
            <div style={{ fontWeight: 560, fontSize: 14 }}>{c.label}</div>
            <div style={{ color: "var(--tx-lo)", fontSize: 12.5 }}>{c.desc}</div>
          </button>
        ))}
      </div>

      {/* selective restart */}
      <div className="panel panel-pad">
        <SectionHead title="Selective restart" />
        <div className="row wrap" style={{ gap: 8 }}>
          {ds.rows.map((r) => (
            <button key={r.key} className="btn btn-sm" onClick={() => api.command("restart/" + r.key, `Restarting ${r.title}`)}>
              <Dot token={statusInfo(r.status).token} /> {r.title}
            </button>
          ))}
        </div>
      </div>

      {/* snapshots */}
      <div className="panel" style={{ overflow: "hidden" }}>
        <div className="panel-pad" style={{ paddingBottom: 12 }}>
          <SectionHead title="Snapshots" count={snaps.length}
            right={<button className="btn btn-sm btn-primary" onClick={openNaming} disabled={!!capturing}><Icon name="camera" size={14} /> Capture</button>} />
          {capturing && (
            <div className="panel panel-pad fade-up" style={{ background: "var(--bg-elev)", marginBottom: 4 }}>
              <div className="row between" style={{ marginBottom: 8 }}>
                <span className="row" style={{ gap: 8 }}><span className="dot dot-blue dot-pulse" /><span style={{ fontSize: 13 }}>Capturing — {capturing.phase}</span></span>
                <span className="mono tnum" style={{ fontSize: 12, color: "var(--tx-lo)" }}>{Math.round(capturing.pct * 100)}%</span>
              </div>
              <div className="meter"><span style={{ width: (capturing.pct * 100) + "%", background: "var(--c-blue)", transition: "width .5s" }} /></div>
            </div>
          )}
        </div>
        <table className="tbl">
          <thead><tr><th>Label</th><th>Created</th><th>Participants</th><th>Containers</th><th>Host tree</th><th>Size</th><th style={{ width: 120 }}></th></tr></thead>
          <tbody>
            {snaps.map((s) => (
              <tr key={s.id}>
                <td><div><div style={{ fontWeight: 530 }}>{s.label}</div><span className="mono" style={{ fontSize: 11, color: "var(--tx-dim)" }}>{s.id}</span></div></td>
                <td style={{ color: "var(--tx-mid)", fontSize: 12.5 }}>{ago(s.createdAt)} ago</td>
                <td className="mono tnum">{s.participants}</td>
                <td className="mono tnum">{s.containers}</td>
                <td>{s.hostTree ? <Dot token="green" /> : <span style={{ color: "var(--tx-dim)" }}>—</span>}</td>
                <td className="mono tnum" style={{ color: "var(--tx-lo)" }}>{s.sizeMb} MB</td>
                <td><div className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
                  <button className="btn btn-sm" onClick={() => api.command("snapshots/restore", `Restoring ${s.label}`, { confirm: true, danger: true, title: `Restore "${s.label}"?`, body: "Replaces the current chain and container state with this snapshot. Unsaved progress is lost.", confirmLabel: "Restore" })}>Restore</button>
                  <button className="iconbtn" onClick={() => setConfirm({ id: "snapshots/delete", label: "Delete snapshot", danger: true, body: `Permanently delete "${s.label}"? This cannot be undone.`, _del: s.id })}><Icon name="trash" size={15} /></button>
                </div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ConfirmDialog open={!!confirm} danger={confirm?.danger} title={confirm?.label || ""}
        body={confirm?.body || `Run "${confirm?.label}"? This affects the running stack.`}
        confirmLabel={confirm?.label}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          if (confirm._del) { ds.snapshots = ds.snapshots.filter((x) => x.id !== confirm._del); setSnaps(ds.snapshots); }
          api.command(confirm.id, confirm.label + " requested", { skipConfirm: true }); setConfirm(null);
        }} />

      {/* snapshot naming */}
      {naming !== null && (
        <div className="overlay" onClick={() => setNaming(null)}>
          <div className="panel" onClick={(e) => e.stopPropagation()} style={{ width: 420, padding: 22, animation: "popIn .2s ease both" }}>
            <div className="row" style={{ gap: 11, marginBottom: 14 }}>
              <div style={{ width: 32, height: 32, borderRadius: 8, display: "grid", placeItems: "center", background: "color-mix(in oklab, var(--c-blue) 14%, transparent)", color: "var(--c-blue)", flex: "none" }}><Icon name="camera" size={18} /></div>
              <div><h3 style={{ fontSize: 16 }}>Capture snapshot</h3><span style={{ fontSize: 12.5, color: "var(--tx-lo)" }}>Name this point-in-time checkpoint of the whole stack.</span></div>
            </div>
            <input autoFocus className="field mono" value={naming} onChange={(e) => setNaming(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && naming.trim()) { const n = naming.trim(); setNaming(null); runCapture(n); } if (e.key === "Escape") setNaming(null); }}
              placeholder="snapshot-name" style={{ width: "100%", marginBottom: 18 }} />
            <div className="row" style={{ gap: 9, justifyContent: "flex-end" }}>
              <button className="btn" onClick={() => setNaming(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={!naming.trim()} onClick={() => { const n = naming.trim(); setNaming(null); runCapture(n); }}><Icon name="camera" size={14} /> Capture</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

Object.assign(window, { OverviewPanel, ServicesPanel, ServiceDrawer, ControlsPanel, narrationFor, SECTION_LABEL });
