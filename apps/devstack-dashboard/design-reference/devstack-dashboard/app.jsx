/* ============================================================
   app.jsx — shell: nav, header, drawer, palette, toasts, tweaks
   ============================================================ */
const { useState: aUseState, useEffect: aUseEffect, useRef: aUseRef, useCallback: aUseCb } = React;
const {
  Icon, Dot, statusInfo, CopyChip, ago, ConfirmDialog,
  OverviewPanel, ServicesPanel, ServiceDrawer, ControlsPanel,
  LogsPanel, ActivityPanel, AccountsPanel, FaucetPanel, ExplorerPanel, PluginPage, ConfigPanel,
  useTweaks, TweaksPanel, TweakSection, TweakRadio, TweakColor, TweakToggle, TweakSelect,
} = window;

const PLUGIN_NAV = (window.PLUGIN_ORDER || []).map((k) => ({ id: "plugin:" + k, label: window.PLUGIN_META[k].title, icon: window.PLUGIN_META[k].icon, pk: k }));

const NAV = [
  { id: "overview", label: "Overview", icon: "grid" },
  { id: "services", label: "Services", icon: "layers" },
  { id: "activity", label: "Console", icon: "terminal" },
  { sep: "Chain" },
  { id: "accounts", label: "Accounts", icon: "wallet" },
  { id: "faucet", label: "Faucet", icon: "drop" },
  { id: "explorer", label: "Explorer", icon: "compass" },
  { sep: "Plugins" },
  ...PLUGIN_NAV,
  { sep: "Manage" },
  { id: "controls", label: "Controls", icon: "sliders" },
  { id: "config", label: "Config", icon: "cog" },
];

const PHASE_TOKEN = { running: "green", active: "yellow", restarting: "yellow", "shutting-down": "red", booting: "cyan" };

const CONFIRM_COPY = {
  restart:  { title: "Restart stack?", body: "All services cycle and re-acquire in dependency order. Chain state is preserved.", confirmLabel: "Restart" },
  shutdown: { title: "Shut down stack?", body: "Gracefully stops every service and releases all ports. You'll need to run devstack up again.", danger: true, confirmLabel: "Shut down" },
  wipe:     { title: "Wipe all state?", body: "Destroys all containers, volumes, and the chain itself — a full genesis reset. This cannot be undone.", danger: true, confirmLabel: "Wipe everything" },
  prune:    { title: "Prune resources?", body: "Removes dangling containers and volumes that aren't owned by the running stack.", confirmLabel: "Prune" },
};

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "dark",
  "accent": "#34d8c4",
  "density": "balanced",
  "monoHeavy": false,
  "navStyle": "rail"
}/*EDITMODE-END*/;

const ACCENTS = ["#34d8c4", "#6fbcf0", "#a78bfa", "#f6a94b", "#4ade80", "#f472b6"];
const DENSITY_D = { compact: 0.84, balanced: 1, comfy: 1.18 };

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [route, setRoute] = aUseState("overview");
  const [param, setParam] = aUseState(null);
  const [svcKey, setSvcKey] = aUseState(null);
  const [palette, setPalette] = aUseState(false);
  const [confirmState, setConfirmState] = aUseState(null);
  const [conn, setConn] = aUseState("live"); // live | reconnecting

  const simulateDrop = aUseCb(() => {
    setConn("reconnecting");
    setTimeout(() => { setConn("live"); toast("Reconnected · full state re-synced", "green"); }, 3600);
  }, []);
  const [toasts, setToasts] = aUseState([]);
  const [, force] = aUseState(0);

  /* apply tweak tokens */
  aUseEffect(() => {
    const r = document.documentElement;
    r.setAttribute("data-theme", t.theme);
    r.style.setProperty("--accent", t.accent);
    r.style.setProperty("--d", String(DENSITY_D[t.density] || 1));
    if (t.monoHeavy) r.style.setProperty("--font-ui", '"Geist Mono", ui-monospace, monospace');
    else r.style.removeProperty("--font-ui");
  }, [t.theme, t.accent, t.density, t.monoHeavy]);

  /* live header heartbeat */
  aUseEffect(() => window.DSBus.subscribe((typ) => { if (typ === "tick" || typ === "row") force((x) => x + 1); }), []);

  const toast = aUseCb((msg, token = "cyan") => {
    const id = Math.random().toString(36).slice(2);
    setToasts((ts) => [...ts, { id, msg, token }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), 3200);
  }, []);

  const goto = aUseCb((r, p = null) => { setRoute(r); setParam(p); setSvcKey(null); }, []);
  const openService = aUseCb((k) => setSvcKey(k), []);
  const dispatch = aUseCb((id, msg) => {
    toast(msg, "green");
    if (id === "restart" || id.startsWith("restart/")) {
      window.DS.cycle.phase = "restarting"; force((x) => x + 1);
      setTimeout(() => { window.DS.cycle.id++; window.DS.cycle.phase = "running"; force((x) => x + 1); toast("Stack running · cycle #" + window.DS.cycle.id, "green"); }, 1800);
    }
  }, []);

  const confirm = aUseCb((opts) => setConfirmState({ ...opts, onConfirm: () => { setConfirmState(null); opts.onConfirm && opts.onConfirm(); } }), []);

  const command = aUseCb((id, msg, opts = {}) => {
    let conf = CONFIRM_COPY[id.split("/")[0]] ? { ...CONFIRM_COPY[id.split("/")[0]] } : null;
    if (id.startsWith("restart/")) {
      const r = window.DS.rows.find((x) => x.key === id.slice(8));
      conf = { title: `Restart ${r ? r.title : id.slice(8)}?`, body: "Re-acquires just this resource. Dependents may briefly reconnect while it cycles.", confirmLabel: "Restart" };
    }
    if (opts.confirm) conf = { title: opts.title, body: opts.body, danger: opts.danger, confirmLabel: opts.confirmLabel };
    if (conf && !opts.skipConfirm) confirm({ ...conf, onConfirm: () => dispatch(id, msg) });
    else dispatch(id, msg);
  }, []);

  const api = { goto, openService, command, toast, confirm };

  /* keyboard */
  aUseEffect(() => {
    const h = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") { e.preventDefault(); setPalette((p) => !p); return; }
      if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA") return;
      if (e.key === "/") { e.preventDefault(); setPalette(true); }
      else if (e.key === "r") command("restart", "Restarting stack…");
      else if (e.key === "s") { goto("controls"); }
      else if (e.key === "l") { goto("activity"); }
      else if (e.key === "?") toast("Shortcuts: r restart · s snapshot · l console · / search", "cyan");
    };
    window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h);
  }, []);

  const ds = window.DS;
  const ready = ds.rows.filter((r) => r.status === "ready").length;
  const summaryLine = `${ready}/${ds.rows.length} ready · ${ds.netStats.tps} tps · cp ${ds.netStats.checkpoint.toLocaleString()}`;
  const phaseTok = PHASE_TOKEN[ds.cycle.phase] || "white";
  const collapsed = t.navStyle === "collapsed";

  const PANELS = { overview: OverviewPanel, services: ServicesPanel, logs: LogsPanel, activity: ActivityPanel,
    accounts: AccountsPanel, faucet: FaucetPanel, explorer: ExplorerPanel, controls: ControlsPanel, config: ConfigPanel };
  const isPlugin = route.startsWith("plugin:");
  const Panel = PANELS[route] || OverviewPanel;

  return (
    <div style={{ position: "relative", height: "100%", display: "grid", gridTemplateColumns: `${collapsed ? "var(--nav-w-collapsed)" : "var(--nav-w)"} 1fr`, gridTemplateRows: "minmax(0, 1fr)", zIndex: 1 }}>
      <div className="atmos" />

      {/* NAV RAIL */}
      <aside className="col" style={{ borderRight: "1px solid var(--line)", background: "linear-gradient(180deg, color-mix(in oklab, var(--bg-panel) 70%, var(--bg-base)), var(--bg-base))", overflow: "hidden", zIndex: 2 }}>
        {/* brand */}
        <div className="row" style={{ gap: 11, padding: collapsed ? "0" : "0 18px", justifyContent: collapsed ? "center" : "flex-start", height: "var(--header-h)", borderBottom: "1px solid var(--line)", flex: "none" }}>
          <div style={{ width: 32, height: 32, borderRadius: 9, background: "linear-gradient(145deg, var(--accent), color-mix(in oklab, var(--accent) 60%, #000))", color: "var(--accent-ink)", display: "grid", placeItems: "center", flex: "none", fontWeight: 700, fontFamily: "var(--font-mono)", fontSize: 17, boxShadow: "0 0 0 1px var(--accent-line), 0 6px 18px -6px var(--accent-glow)" }}>◆</div>
          {!collapsed && <div className="col" style={{ gap: 1 }}><span style={{ fontWeight: 620, letterSpacing: "-.02em", lineHeight: 1, fontSize: 15 }}>devstack</span><span className="mono" style={{ fontSize: 10, color: "var(--tx-lo)", letterSpacing: ".02em" }}>orchestrator · v{ds.identity.version}</span></div>}
        </div>

        {/* nav */}
        <nav className="col scroll-y grow" style={{ gap: 1, padding: collapsed ? "12px 10px" : "14px 12px" }}>
          {NAV.map((n, i) => n.sep ? (
            collapsed ? <div key={i} style={{ height: 1, background: "var(--line)", margin: "9px 8px" }} /> : <div key={i} className="eyebrow" style={{ padding: "14px 11px 6px" }}>{n.sep}</div>
          ) : (
            <button key={n.id} className={"nav-item " + (route === n.id ? "on" : "")} onClick={() => goto(n.id)} title={collapsed ? n.label : null} style={collapsed ? { justifyContent: "center", padding: 0, width: 40, height: 40, margin: "0 auto" } : null}>
              <Icon name={n.icon} size={17} />
              {!collapsed && <span>{n.label}</span>}
              {n.id === "services" && ds.rows.some((r) => r.status === "failed") && <span className="nav-badge dot dot-red dot-pulse" style={collapsed ? { position: "absolute", top: 7, right: 7, marginLeft: 0 } : null} />}
            </button>
          ))}
        </nav>

        {/* footer status capsule */}
        {!collapsed ? (
          <div style={{ padding: 12, flex: "none" }}>
            <div className="panel" style={{ padding: "11px 13px", background: "var(--bg-base)" }}>
              <div className="row between" style={{ marginBottom: 9 }}>
                <span className="row" style={{ gap: 7 }}>
                  <span className={`dot dot-${phaseTok} ${ds.cycle.phase !== "running" ? "dot-pulse" : ""}`} />
                  <span style={{ fontSize: 12, fontWeight: 540, textTransform: "capitalize" }}>{ds.cycle.phase}</span>
                </span>
                <span className="badge" style={{ height: 18, fontSize: 9.5, textTransform: "uppercase", letterSpacing: ".07em", color: "var(--c-cyan)" }}>{ds.identity.mode}</span>
              </div>
              <div className="row between mono" style={{ fontSize: 10.5, color: "var(--tx-lo)" }}>
                <span>cycle #{ds.cycle.id}</span>
                <span>{ready}/{ds.rows.length} ready</span>
              </div>
            </div>
          </div>
        ) : (
          <div className="col" style={{ alignItems: "center", padding: "12px 0", flex: "none" }}>
            <span className={`dot dot-${phaseTok} ${ds.cycle.phase !== "running" ? "dot-pulse" : ""}`} style={{ width: 9, height: 9 }} />
          </div>
        )}
      </aside>

      {/* MAIN COLUMN */}
      <div className="col" style={{ minWidth: 0, minHeight: 0, height: "100%" }}>
        {/* HEADER */}
        <header className="row between" style={{ height: "var(--header-h)", padding: "0 22px", borderBottom: "1px solid var(--line)", background: "color-mix(in oklab, var(--bg-panel) 50%, transparent)", backdropFilter: "blur(8px)", flex: "none", zIndex: 5, gap: 16 }}>
          <div className="row" style={{ gap: 14, minWidth: 0 }}>
            <div className="row" style={{ gap: 9 }}>
              <Dot token="green" />
              <span style={{ fontWeight: 560 }}>{ds.identity.name}</span>
              <span className="badge" style={{ height: 20, fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--c-cyan)" }}>{ds.identity.mode}</span>
            </div>
            <span style={{ width: 1, height: 22, background: "var(--line)" }} />
            <span className="badge" style={{ height: 20, borderColor: `color-mix(in oklab, var(--c-${phaseTok}) 32%, var(--line-strong))` }}>
              <Dot token={phaseTok} pulse={ds.cycle.phase !== "running"} /><span style={{ color: `var(--c-${phaseTok})`, fontSize: 11 }}>cycle #{ds.cycle.id} · {ds.cycle.phase}</span>
            </span>
            <span className="mono trunc" style={{ fontSize: 11.5, color: "var(--tx-lo)" }}>{summaryLine}</span>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-sm btn-ghost" onClick={() => setPalette(true)} style={{ color: "var(--tx-lo)" }}>
              <Icon name="search" size={14} /> Search <kbd>⌘K</kbd>
            </button>
            <span style={{ width: 1, height: 22, background: "var(--line)" }} />
            <button className="iconbtn" onClick={() => command("restart", "Restarting stack…")} title="Restart (r)"><Icon name="refresh" /></button>
            <button className="iconbtn" onClick={() => goto("activity")} title="Console (L)"><Icon name="terminal" /></button>
            <ConnIndicator conn={conn} onSimulate={simulateDrop} />
          </div>
        </header>

        {/* CONTENT */}
        <main className="scroll-y grow" style={{ padding: "24px 26px", paddingBottom: 24, position: "relative", minHeight: 0 }}>
          {conn === "reconnecting" && (
            <div style={{ marginBottom: 18 }}>
              <window.Banner tone="warn" title="Connection to the stack lost — showing last known state."
                action={<span className="live-sweep" style={{ width: 110, height: 4, borderRadius: 4, alignSelf: "center" }} />}>
                Reconnecting to the SSE stream…
              </window.Banner>
            </div>
          )}
          <div key={route} className="fade-up" style={{ opacity: conn === "reconnecting" ? 0.5 : 1, pointerEvents: conn === "reconnecting" ? "none" : "auto", filter: conn === "reconnecting" ? "grayscale(.4)" : "none", transition: "opacity .3s, filter .3s" }}>
            {isPlugin ? <PluginPage pluginKey={route.slice(7)} api={api} /> : <Panel api={api} initial={param} />}
          </div>
        </main>
      </div>

      {/* SERVICE DETAIL DRAWER */}
      {svcKey && <ServiceDrawer rowKey={svcKey} api={api} onClose={() => setSvcKey(null)} />}

      {/* COMMAND PALETTE */}
      {palette && <CommandPalette onClose={() => setPalette(false)} goto={goto} openService={openService} command={command} />}

      {/* GLOBAL CONFIRM */}
      <ConfirmDialog open={!!confirmState} title={confirmState?.title || ""} body={confirmState?.body}
        danger={confirmState?.danger} confirmLabel={confirmState?.confirmLabel || "Confirm"}
        onCancel={() => setConfirmState(null)} onConfirm={() => confirmState?.onConfirm?.()} />

      {/* TOASTS */}
      <div className="toast-wrap">
        {toasts.map((tt) => (
          <div key={tt.id} className="toast">
            <Dot token={tt.token} />
            <span style={{ fontSize: 13, color: "var(--tx-hi)" }}>{tt.msg}</span>
          </div>
        ))}
      </div>

      {/* TWEAKS */}
      <TweaksPanel title="Tweaks">
        <TweakSection label="Theme" />
        <TweakRadio label="Mode" value={t.theme} options={["dark", "light"]} onChange={(v) => setTweak("theme", v)} />
        <TweakColor label="Accent" value={t.accent} options={ACCENTS} onChange={(v) => setTweak("accent", v)} />
        <TweakSection label="Layout" />
        <TweakRadio label="Density" value={t.density} options={["compact", "balanced", "comfy"]} onChange={(v) => setTweak("density", v)} />
        <TweakRadio label="Nav" value={t.navStyle} options={["rail", "collapsed"]} onChange={(v) => setTweak("navStyle", v)} />
        <TweakToggle label="Mono-heavy UI" value={t.monoHeavy} onChange={(v) => setTweak("monoHeavy", v)} />
      </TweaksPanel>
    </div>
  );
}

/* connection indicator */
function ConnIndicator({ conn, onSimulate }) {
  const [, setPulse] = aUseState(0);
  aUseEffect(() => window.DSBus.subscribe((typ) => { if (typ === "tick") setPulse((p) => p + 1); }), []);
  const reconnecting = conn === "reconnecting";
  return (
    <button onClick={onSimulate} disabled={reconnecting} className="badge"
      title={reconnecting ? "Reconnecting to SSE stream…" : "SSE stream connected — click to simulate a drop"}
      style={{ height: 28, cursor: reconnecting ? "default" : "pointer", borderColor: `color-mix(in oklab, var(--c-${reconnecting ? "yellow" : "green"}) 30%, var(--line-strong))` }}>
      <span className={`dot dot-${reconnecting ? "yellow" : "green"} dot-pulse`} />
      <span style={{ fontSize: 11, color: `var(--c-${reconnecting ? "yellow" : "green"})` }}>{reconnecting ? "reconnecting" : "live"}</span>
    </button>
  );
}

/* command palette */
function CommandPalette({ onClose, goto, openService, command }) {
  const ds = window.DS;
  const [q, setQ] = aUseState("");
  const [sel, setSel] = aUseState(0);
  const inputRef = aUseRef();
  aUseEffect(() => { inputRef.current && inputRef.current.focus(); }, []);

  const items = [];
  NAV.filter((n) => !n.sep).forEach((n) => items.push({ kind: "Go to", label: n.label, icon: n.icon, run: () => goto(n.id) }));
  ds.rows.forEach((r) => items.push({ kind: "Service", label: r.title, icon: "layers", hint: r.key, run: () => openService(r.key) }));
  ds.accounts.forEach((a) => items.push({ kind: "Account", label: a.name, icon: "wallet", hint: window.short(a.address), run: () => goto("accounts") }));
  ds.endpoints.forEach((e) => items.push({ kind: "Endpoint", label: e.label, icon: "ext", hint: e.url, run: () => goto("config") }));
  [["Restart stack", "refresh", () => command("restart", "Restarting stack…")], ["Capture snapshot", "camera", () => goto("controls")], ["Shutdown", "power", () => command("shutdown", "Shutting down…")]].forEach(([l, ic, run]) => items.push({ kind: "Command", label: l, icon: ic, run }));

  const filtered = q ? items.filter((i) => (i.label + " " + (i.hint || "") + " " + i.kind).toLowerCase().includes(q.toLowerCase())) : items;
  const shown = filtered.slice(0, 9);
  aUseEffect(() => setSel(0), [q]);

  const onKey = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, shown.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === "Enter" && shown[sel]) { shown[sel].run(); onClose(); }
    else if (e.key === "Escape") onClose();
  };

  return (
    <div className="overlay" onClick={onClose} style={{ alignItems: "flex-start" }}>
      <div className="panel palette" onClick={(e) => e.stopPropagation()} style={{ boxShadow: "var(--sh-pop)", overflow: "hidden" }}>
        <div className="row" style={{ padding: "0 16px", borderBottom: "1px solid var(--line)", gap: 10 }}>
          <Icon name="search" size={17} style={{ color: "var(--tx-lo)" }} />
          <input ref={inputRef} className="palette-input" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder="Jump to a service, account, endpoint, or run a command…" style={{ padding: "0 0" }} />
          <kbd>esc</kbd>
        </div>
        <div className="col scroll-y" style={{ padding: 8, maxHeight: 380 }}>
          {shown.length === 0 ? <div style={{ padding: 24, textAlign: "center", color: "var(--tx-lo)", fontSize: 13 }}>No matches</div> :
            shown.map((it, i) => (
              <div key={i} className={"palette-item " + (i === sel ? "on" : "")} onMouseEnter={() => setSel(i)} onClick={() => { it.run(); onClose(); }}>
                <Icon name={it.icon} size={16} style={{ color: "var(--tx-mid)" }} />
                <span style={{ fontSize: 14 }}>{it.label}</span>
                {it.hint && <span className="mono trunc" style={{ fontSize: 11.5, color: "var(--tx-dim)", maxWidth: 220 }}>{it.hint}</span>}
                <span className="badge nav-badge" style={{ height: 18, fontSize: 10 }}>{it.kind}</span>
                <Icon name="arrowR" size={14} className="pi-arrow" style={{ opacity: 0, color: "var(--accent)" }} />
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
