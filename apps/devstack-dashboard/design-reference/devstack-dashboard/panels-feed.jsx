/* ============================================================
   panels-feed.jsx — Logs console + Activity (events & traces)
   ============================================================ */
const { Icon: FIcon, Dot: FDot, LevelPill, CopyChip: FCopy, SectionHead: FSectionHead, EmptyState: FEmpty, ago: fAgo } = window;
const { useState: fUseState, useEffect: fUseEffect, useRef: fUseRef, useMemo: fUseMemo } = React;

/* ---------- shared filter dropdown ---------- */
function FilterMenu(props) {
  // delegate to the shared library MultiSelect (the component the implementor builds)
  return <window.MultiSelect {...props} />;
}
function FilterMenuLegacy({ label, icon, options, selected, onToggle, allLabel = "All" }) {
  const [open, setOpen] = fUseState(false);
  const ref = fUseRef();
  fUseEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h);
  }, []);
  const count = selected.length;
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button className="btn btn-sm" onClick={() => setOpen((o) => !o)} style={count ? { borderColor: "var(--accent-line)", color: "var(--tx-hi)" } : null}>
        {icon && <FIcon name={icon} size={13} />}{label}{count > 0 && <span className="badge" style={{ height: 16, fontSize: 10, padding: "0 6px", color: "var(--accent)" }}>{count}</span>}
        <FIcon name="chevD" size={12} />
      </button>
      {open && (
        <div className="panel" style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, minWidth: 180, padding: 6, zIndex: 30, boxShadow: "var(--sh-pop)", maxHeight: 320, overflowY: "auto" }}>
          {options.map((o) => {
            const on = selected.includes(o.value);
            return (
              <button key={o.value} className="row between" onClick={() => onToggle(o.value)}
                style={{ width: "100%", padding: "6px 8px", borderRadius: 6, background: "transparent", border: "none", color: "var(--tx-mid)", fontSize: 12.5, cursor: "pointer", gap: 8 }}
                onMouseEnter={(e) => e.currentTarget.style.background = "var(--bg-hover)"} onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}>
                <span className="row" style={{ gap: 7 }}>{o.token && <FDot token={o.token} />}<span style={{ color: on ? "var(--tx-hi)" : "var(--tx-mid)" }}>{o.label}</span></span>
                {on && <FIcon name="check" size={13} style={{ color: "var(--accent)" }} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ============================================================ LOGS */
function LogsPanel({ api, initial, embedded }) {
  const ds = window.DS;
  const allTags = Object.keys(ds.logs);
  const [plugins, setPlugins] = fUseState(initial?.plugin ? [initial.plugin] : []);
  const [levels, setLevels] = fUseState([]);
  const [q, setQ] = fUseState("");
  const [follow, setFollow] = fUseState(true);
  const [lines, setLines] = fUseState(() => collect(ds));
  const [unseen, setUnseen] = fUseState(0);
  const scroller = fUseRef();

  function collect(ds) {
    const all = [];
    Object.values(ds.logs).forEach((arr) => arr.forEach((l) => all.push(l)));
    return all.sort((a, b) => a.at - b.at).slice(-600);
  }

  fUseEffect(() => window.DSBus.subscribe((t, p) => {
    if (t === "log") setLines((prev) => [...prev, p].slice(-600));
  }), []);

  const filtered = fUseMemo(() => lines.filter((l) =>
    (plugins.length === 0 || plugins.includes(l.plugin)) &&
    (levels.length === 0 || levels.includes(l.level)) &&
    (!q || l.message.toLowerCase().includes(q.toLowerCase()) || l.tag.includes(q.toLowerCase()))
  ), [lines, plugins, levels, q]);

  fUseEffect(() => {
    if (follow && scroller.current) { scroller.current.scrollTop = scroller.current.scrollHeight; setUnseen(0); }
    else setUnseen((u) => u + 1);
  }, [filtered.length]);

  return (
    <div className="col" style={{ gap: 0, height: "100%" }}>
      {!embedded && (
        <div className="row between wrap" style={{ gap: 10, marginBottom: 14 }}>
          <div>
            <h2 style={{ fontSize: 19 }}>Logs</h2>
            <p style={{ color: "var(--tx-mid)", fontSize: 13, margin: "3px 0 0" }}>Unified live console across every plugin ring-buffer.</p>
          </div>
        </div>
      )}

      <div className="row wrap" style={{ gap: 9, marginBottom: 12 }}>
        <div className="row" style={{ gap: 8, background: "var(--bg-panel)", border: "1px solid var(--line)", borderRadius: "var(--r-sm)", padding: "0 10px", height: 32, flex: "1 1 240px", maxWidth: 380 }}>
          <FIcon name="search" size={15} style={{ color: "var(--tx-lo)" }} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search messages…"
            style={{ background: "transparent", border: "none", outline: "none", color: "var(--tx-hi)", fontSize: 13, flex: 1, fontFamily: "var(--font-mono)" }} />
          {q && <button className="iconbtn" style={{ width: 22, height: 22 }} onClick={() => setQ("")}><FIcon name="x" size={13} /></button>}
        </div>
        <FilterMenu label="Plugin" icon="layers" selected={plugins} onToggle={(v) => setPlugins((s) => s.includes(v) ? s.filter((x) => x !== v) : [...s, v])}
          options={allTags.map((t) => ({ value: t, label: t }))} />
        <FilterMenu label="Level" icon="filter" selected={levels} onToggle={(v) => setLevels((s) => s.includes(v) ? s.filter((x) => x !== v) : [...s, v])}
          options={[{ value: "error", label: "error", token: "red" }, { value: "warn", label: "warn", token: "yellow" }, { value: "info", label: "info", token: "cyan" }, { value: "debug", label: "debug", token: "white" }]} />
        <div className="grow" />
        <button className={"btn btn-sm " + (follow ? "" : "")} onClick={() => { setFollow((f) => !f); setUnseen(0); }} style={follow ? { borderColor: "var(--accent-line)", color: "var(--accent)" } : null}>
          <FIcon name={follow ? "pause" : "play"} size={13} /> {follow ? "Following" : "Paused"}{!follow && unseen > 0 ? ` · ${unseen} new` : ""}
        </button>
        <button className="btn btn-sm btn-ghost" onClick={() => api.toast("Logs exported (mock)", "cyan")}><FIcon name="download" size={14} /></button>
      </div>

      <div ref={scroller} className="panel logbox-full mono scroll-y grow" onScroll={(e) => {
        const el = e.target; const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        if (!atBottom && follow) setFollow(false);
      }}>
        {filtered.length === 0 ? <FEmpty icon="terminal" title="No matching log lines" hint="Adjust filters or search to see output." /> :
          filtered.map((l) => (
            <div key={l.id} className="logline">
              <span style={{ color: "var(--tx-dim)", fontSize: 11 }}>{new Date(l.at).toLocaleTimeString("en", { hour12: false })}</span>
              <LevelPill level={l.level} />
              <span style={{ color: "var(--tx-lo)", fontSize: 11.5, minWidth: 78 }}>{l.tag}</span>
              <span style={{ color: l.level === "error" ? "var(--c-red)" : l.level === "warn" ? "var(--c-yellow)" : "var(--tx-hi)", fontSize: 12.5, flex: 1 }}>{l.message}</span>
              {l.fields && <span style={{ color: "var(--tx-dim)", fontSize: 11 }}>{Object.entries(l.fields).map(([k, v]) => `${k}=${v}`).join(" ")}</span>}
            </div>
          ))}
      </div>
    </div>
  );
}

/* ============================================================ CONSOLE (Logs + Events + Traces) */
function ActivityPanel({ api, initial }) {
  const [tab, setTab] = fUseState(initial?.tab || "logs");
  fUseEffect(() => { if (initial?.tab) setTab(initial.tab); }, [initial]);
  const TABS = [["logs", "Logs"], ["events", "Events"], ["traces", "Traces"]];
  return (
    <div className="col" style={{ gap: 16, height: "100%" }}>
      <div className="row between wrap" style={{ gap: 12 }}>
        <div>
          <h2 style={{ fontSize: 19 }}>Console</h2>
          <p style={{ color: "var(--tx-mid)", fontSize: 13, margin: "3px 0 0" }}>Live logs, the engine event stream, and span traces — one place.</p>
        </div>
        <div className="segmented">
          {TABS.map(([id, l]) => <button key={id} className={"seg " + (tab === id ? "seg-on" : "")} onClick={() => setTab(id)}>{l}</button>)}
        </div>
      </div>
      <div className="grow" style={{ minHeight: 0 }}>
        {tab === "logs" ? <LogsPanel api={api} initial={initial} embedded /> : tab === "events" ? <EventsFeed api={api} /> : <TracesView api={api} />}
      </div>
    </div>
  );
}

const SCOPE_OPTS = [
  { value: "core", label: "core", token: "green" }, { value: "service", label: "service", token: "cyan" },
  { value: "infra", label: "infra", token: "blue" }, { value: "account", label: "account", token: "magenta" },
  { value: "package", label: "package", token: "blue" },
];

function EventsFeed({ api }) {
  const ds = window.DS;
  const [raw, setRaw] = fUseState(false);
  const [scopes, setScopes] = fUseState([]);
  const [items, setItems] = fUseState(() => ds.events.slice(-120).reverse());
  fUseEffect(() => window.DSBus.subscribe((t, p) => { if (t === "event") setItems((prev) => [p, ...prev].slice(0, 200)); }), []);
  const filtered = items.filter((e) => scopes.length === 0 || scopes.includes(e.scope));

  return (
    <div className="col" style={{ gap: 12, height: "100%" }}>
      <div className="row wrap" style={{ gap: 9 }}>
        <FilterMenu label="Scope" icon="filter" selected={scopes} options={SCOPE_OPTS}
          onToggle={(v) => setScopes((s) => s.includes(v) ? s.filter((x) => x !== v) : [...s, v])} />
        <div className="grow" />
        <button className="btn btn-sm" onClick={() => setRaw((r) => !r)} style={raw ? { borderColor: "var(--accent-line)", color: "var(--accent)" } : null}>
          {raw ? "Raw tags" : "Curated"}
        </button>
      </div>
      <div className="panel scroll-y grow" style={{ padding: "6px 4px" }}>
        {filtered.map((ev) => (
          <div key={ev.id} className="row fade-up activity-row" onClick={() => api.goto("services", { plugin: ev.plugin })}>
            <span className="mono" style={{ fontSize: 11, color: "var(--tx-dim)", minWidth: 44 }}>{fAgo(ev.at)}</span>
            <span style={{ width: 3, alignSelf: "stretch", borderRadius: 3, background: `var(--c-${ev.color})`, margin: "2px 0" }} />
            <FDot token={ev.color} />
            <span className="mono" style={{ fontSize: 11.5, color: `var(--c-${ev.color})`, minWidth: 150 }}>{ev.tag}</span>
            {raw
              ? <span className="mono trunc grow" style={{ fontSize: 11.5, color: "var(--tx-mid)" }}>{`{ plugin: "${ev.plugin}", scope: "${ev.scope}" }`}</span>
              : <span className="trunc grow" style={{ fontSize: 12.5, color: "var(--tx-mid)" }}>{ev.message}</span>}
            <span className="badge" style={{ height: 18, fontSize: 10 }}>{ev.plugin}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TracesView({ api }) {
  const ds = window.DS;
  const spans = ds.spans;
  const maxDur = Math.max(...spans.map((s) => s.durMs));
  return (
    <div className="col" style={{ gap: 12, height: "100%" }}>
      <div className="panel panel-pad" style={{ background: "color-mix(in oklab, var(--c-blue) 6%, var(--bg-panel))", borderColor: "color-mix(in oklab, var(--c-blue) 28%, var(--line))" }}>
        <div className="row" style={{ gap: 9 }}>
          <FIcon name="activity" size={16} style={{ color: "var(--c-blue)" }} />
          <span style={{ fontSize: 12.5, color: "var(--tx-mid)" }}>Spans collected by the in-memory <span className="mono" style={{ color: "var(--c-blue)" }}>SpanStore</span> tracer — indexed by <span className="mono">devstack.plugin / endpoint / op</span>.</span>
        </div>
      </div>
      <div className="panel scroll-y grow" style={{ padding: "8px 0" }}>
        <table className="tbl">
          <thead><tr><th style={{ width: 56 }}>Status</th><th>Operation</th><th>Plugin</th><th style={{ width: "42%" }}>Duration</th><th style={{ width: 70 }}>When</th></tr></thead>
          <tbody>
            {spans.map((s) => (
              <tr key={s.id}>
                <td><FDot token={s.status === "ok" ? "green" : "red"} /></td>
                <td className="mono" style={{ fontSize: 12.5 }}>{s.op}</td>
                <td><span className="badge" style={{ height: 19, fontSize: 11 }}>{s.plugin}</span></td>
                <td>
                  <div className="row" style={{ gap: 9 }}>
                    <div className="meter grow" style={{ maxWidth: 240 }}><span style={{ width: (s.durMs / maxDur * 100) + "%", background: s.status === "ok" ? "var(--c-blue)" : "var(--c-red)" }} /></div>
                    <span className="mono tnum" style={{ fontSize: 12, color: "var(--tx-lo)", minWidth: 56 }}>{s.durMs.toFixed(1)}ms</span>
                  </div>
                </td>
                <td className="mono" style={{ fontSize: 11.5, color: "var(--tx-dim)" }}>{fAgo(s.at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

Object.assign(window, { LogsPanel, ActivityPanel, FilterMenu });
