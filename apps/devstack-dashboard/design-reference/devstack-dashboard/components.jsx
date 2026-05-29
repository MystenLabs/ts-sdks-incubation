/* ============================================================
   components.jsx — icons + shared domain components
   Exports everything to window for the panel/app scripts.
   ============================================================ */
const { useState, useEffect, useRef, useCallback, useMemo } = React;

/* ---------------- icons (stroke, 24 viewbox) ---------------- */
const ICONS = {
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z",
  layers: "M12 2 2 7l10 5 10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
  terminal: "M4 17l6-6-6-6M12 19h8",
  activity: "M22 12h-4l-3 9L9 3l-3 9H2",
  wallet: "M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7M16 13h.01",
  drop: "M12 2.7s6 5.5 6 10.3a6 6 0 0 1-12 0C6 8.2 12 2.7 12 2.7z",
  compass: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM16.2 7.8 14 14l-6.2 2.2L10 10z",
  puzzle: "M4 7h3a2 2 0 1 0 4 0h3v3a2 2 0 1 1 0 4v3h-3a2 2 0 1 0-4 0H4v-3a2 2 0 1 1 0-4z",
  sliders: "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6",
  cog: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 2.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H7a1.6 1.6 0 0 0 1-1.5V1a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V7a1.6 1.6 0 0 0 1.5 1H23a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z",
  copy: "M9 9h10v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
  check: "M20 6 9 17l-5-5",
  ext: "M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
  refresh: "M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5",
  camera: "M14.5 4h-5L8 6H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  power: "M18.4 6.6a9 9 0 1 1-12.8 0M12 2v10",
  trash: "M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
  chevR: "M9 18l6-6-6-6",
  chevD: "M6 9l6 6 6-6",
  chevL: "M15 18l-6-6 6-6",
  x: "M18 6 6 18M6 6l12 12",
  play: "M5 3l14 9-14 9z",
  pause: "M6 4h4v16H6zM14 4h4v16h-4z",
  alert: "M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  filter: "M22 3H2l8 9.5V19l4 2v-8.5z",
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
  cmd: "M15 6a3 3 0 1 1 3 3h-3zm0 0v12m0-12H9m6 12a3 3 0 1 0 3-3h-3zm-6-6a3 3 0 1 1-3-3v3zm0 0v6m0 0a3 3 0 1 0-3 3v-3zm0 0h6",
  plug: "M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0zM12 17v5",
  database: "M12 8c5 0 8-1.3 8-3s-3-3-8-3-8 1.3-8 3 3 3 8 3zM4 5v6c0 1.7 3 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3 3 8 3s8-1.3 8-3v-6",
  box: "M21 8 12 3 3 8m18 0v8l-9 5-9-5V8m18 0-9 5m0 0L3 8m9 5v8",
  coins: "M9 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM15 10a6 6 0 1 1-6 9.7",
  arrowR: "M5 12h14M13 5l7 7-7 7",
  dot: "M12 12h.01",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2",
  hash: "M4 9h16M4 15h16M10 3 8 21M16 3l-2 18",
  zap: "M13 2 3 14h9l-1 8 10-12h-9z",
};
function Icon({ name, size = 16, className = "", style }) {
  const d = ICONS[name] || ICONS.dot;
  return (
    <svg className={"ic " + className} width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={style}>
      {d.split("M").filter(Boolean).map((seg, i) => <path key={i} d={"M" + seg} />)}
    </svg>
  );
}

/* ---------------- status → token mapping (the display-derivation seam) ---------------- */
const STATUS_MAP = {
  ready:     { token: "green",  glyph: "●", label: "Ready" },
  active:    { token: "yellow", glyph: "◐", label: "Active" },
  failed:    { token: "red",    glyph: "✕", label: "Failed" },
  acquiring: { token: "cyan",   glyph: "◌", label: "Acquiring" },
  idle:      { token: "white",  glyph: "○", label: "Idle" },
  blocked:   { token: "red",    glyph: "‖", label: "Blocked" },
  empty:     { token: "dim",    glyph: "·", label: "Empty" },
};
function statusInfo(s) { return STATUS_MAP[s] || STATUS_MAP.idle; }

function StatusBadge({ status, sm }) {
  const i = statusInfo(status);
  const pulse = status === "active" || status === "acquiring";
  return (
    <span className="badge" style={{ borderColor: `color-mix(in oklab, var(--c-${i.token}) 32%, var(--line-strong))` }}>
      <span className={`dot dot-${i.token} ${pulse ? "dot-pulse" : ""}`} />
      <span style={{ color: `var(--c-${i.token})`, fontWeight: 560, fontSize: sm ? 11 : 11.5 }}>{i.label}</span>
    </span>
  );
}

function Dot({ token, pulse }) { return <span className={`dot dot-${token} ${pulse ? "dot-pulse" : ""}`} />; }

/* ---------------- copy chip / address ---------------- */
function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = useCallback((t) => {
    try { navigator.clipboard.writeText(t); } catch (e) {}
    setCopied(true); setTimeout(() => setCopied(false), 1100);
  }, []);
  return [copied, copy];
}
function CopyChip({ text, display, mono = true, icon }) {
  const [copied, copy] = useCopy();
  return (
    <span className="chip" onClick={(e) => { e.stopPropagation(); copy(text); }} title={text}
      style={mono ? null : { fontFamily: "var(--font-ui)" }}>
      {icon && <Icon name={icon} size={13} />}
      <span className="trunc">{display || text}</span>
      <Icon name={copied ? "check" : "copy"} size={12} className="copy-ic"
        style={copied ? { opacity: 1, color: "var(--c-green)" } : null} />
    </span>
  );
}
function short(a, head = 6, tail = 4) {
  if (!a) return "—";
  if (a.length <= head + tail + 2) return a;
  return a.slice(0, head) + "…" + a.slice(-tail);
}
function AddressChip({ address, name, impersonate }) {
  return (
    <span className="row" style={{ gap: 6 }}>
      {name && <span style={{ color: "var(--c-magenta)", fontWeight: 540, fontSize: 12.5 }}>{name}</span>}
      <CopyChip text={address} display={short(address)} />
      {impersonate && <span className="badge" style={{ height: 18, fontSize: 10, color: "var(--c-yellow)" }}>impersonated</span>}
    </span>
  );
}

/* ---------------- endpoint link ---------------- */
function EndpointLink({ ep }) {
  if (!ep) return null;
  return (
    <a className="chip" href="#" onClick={(e) => e.preventDefault()} title={ep.url}
       style={{ color: "var(--c-cyan)", borderColor: "var(--line)" }}>
      <Dot token="cyan" />
      <span className="trunc" style={{ fontSize: 11.5 }}>{ep.label}</span>
      <Icon name="ext" size={12} className="copy-ic" style={{ opacity: .6 }} />
    </a>
  );
}

/* ---------------- coin amount ---------------- */
function fmtMist(mist, decimals = 9) {
  const v = mist / Math.pow(10, decimals);
  if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return v.toLocaleString(undefined, { maximumFractionDigits: 1 });
  return v.toLocaleString(undefined, { maximumFractionDigits: 3 });
}
function CoinAmount({ mist, symbol = "SUI", decimals = 9 }) {
  return (
    <span className="mono tnum" style={{ fontSize: 13 }}>
      {fmtMist(mist, decimals)} <span style={{ color: "var(--tx-lo)", fontSize: 11.5 }}>{symbol}</span>
    </span>
  );
}

/* ---------------- KPI tile ---------------- */
function Kpi({ label, value, sub, token, live, icon, spark, sparkColor }) {
  return (
    <div className="panel panel-pad fade-up" style={{ position: "relative", overflow: "hidden", minWidth: 0 }}>
      {live && <div className="live-sweep" style={{ position: "absolute", inset: 0, opacity: .5, pointerEvents: "none" }} />}
      <div className="row between" style={{ marginBottom: 10 }}>
        <span className="eyebrow">{label}</span>
        {icon && <Icon name={icon} size={15} style={{ color: token ? `var(--c-${token})` : "var(--tx-lo)" }} />}
      </div>
      <div className="row between" style={{ gap: 8, alignItems: "flex-end" }}>
        <div className="row" style={{ gap: 8, alignItems: "baseline" }}>
          <span className="tnum" style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-.02em", color: token ? `var(--c-${token})` : "var(--tx-hi)" }}>{value}</span>
          {sub && <span style={{ color: "var(--tx-lo)", fontSize: 12.5 }}>{sub}</span>}
        </div>
        {spark && window.Sparkline && <window.Sparkline data={spark} width={84} height={30} color={sparkColor || (token ? `var(--c-${token})` : "var(--viz-1)")} />}
      </div>
    </div>
  );
}

/* ---------------- section header ---------------- */
function SectionHead({ title, count, right }) {
  return (
    <div className="row between" style={{ marginBottom: 12 }}>
      <div className="row" style={{ gap: 9 }}>
        <h3 style={{ fontSize: 14.5 }}>{title}</h3>
        {count != null && <span className="badge" style={{ height: 19, fontSize: 11, color: "var(--tx-mid)" }}>{count}</span>}
      </div>
      {right}
    </div>
  );
}

/* ---------------- empty + skeleton ---------------- */
function EmptyState({ icon = "box", title, hint }) {
  return (
    <div className="col" style={{ alignItems: "center", justifyContent: "center", padding: "48px 20px", textAlign: "center", color: "var(--tx-lo)" }}>
      <div style={{ width: 46, height: 46, borderRadius: 12, display: "grid", placeItems: "center", background: "var(--bg-elev)", border: "1px solid var(--line)", marginBottom: 14 }}>
        <Icon name={icon} size={20} />
      </div>
      <div style={{ color: "var(--tx-mid)", fontWeight: 540, marginBottom: 4 }}>{title}</div>
      {hint && <div style={{ fontSize: 12.5, maxWidth: 320 }}>{hint}</div>}
    </div>
  );
}

/* ---------------- level pill (logs) ---------------- */
const LEVEL_TOKEN = { error: "red", warn: "yellow", info: "cyan", debug: "white" };
function LevelPill({ level }) {
  const t = LEVEL_TOKEN[level] || "white";
  return <span className="mono" style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: ".06em", textTransform: "uppercase", color: `var(--c-${t})`, minWidth: 38, display: "inline-block" }}>{level}</span>;
}

/* time ago */
function ago(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60); if (m < 60) return m + "m";
  const h = Math.floor(m / 60); if (h < 24) return h + "h";
  return Math.floor(h / 24) + "d";
}

/* confirm dialog */
function ConfirmDialog({ open, title, body, danger, confirmLabel = "Confirm", onConfirm, onCancel }) {
  if (!open) return null;
  return (
    <div className="overlay" onClick={onCancel}>
      <div className="panel" onClick={(e) => e.stopPropagation()} style={{ width: 420, padding: 22, animation: "popIn .2s ease both" }}>
        <div className="row" style={{ gap: 11, marginBottom: 10 }}>
          {danger && <div style={{ width: 32, height: 32, borderRadius: 8, display: "grid", placeItems: "center", background: "color-mix(in oklab, var(--c-red) 14%, transparent)", color: "var(--c-red)", flex: "none" }}><Icon name="alert" size={18} /></div>}
          <h3 style={{ fontSize: 16 }}>{title}</h3>
        </div>
        <p style={{ color: "var(--tx-mid)", fontSize: 13, lineHeight: 1.55, margin: "0 0 18px" }}>{body}</p>
        <div className="row" style={{ gap: 9, justifyContent: "flex-end" }}>
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className={danger ? "btn btn-danger" : "btn btn-primary"} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- tooltip ---------------- */
function Tooltip({ label, children, side = "top" }) {
  const [show, setShow] = useState(false);
  const pos = side === "top"
    ? { bottom: "calc(100% + 7px)", left: "50%", transform: "translateX(-50%)" }
    : { top: "calc(100% + 7px)", left: "50%", transform: "translateX(-50%)" };
  return (
    <span style={{ position: "relative", display: "inline-flex" }} onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      {children}
      {show && (
        <span style={{ position: "absolute", ...pos, zIndex: 300, whiteSpace: "nowrap", padding: "5px 9px", borderRadius: 6, background: "var(--bg-elev-2)", border: "1px solid var(--line-strong)", boxShadow: "var(--sh-2)", fontSize: 11.5, color: "var(--tx-hi)", pointerEvents: "none", animation: "fadeIn .12s ease both" }}>{label}</span>
      )}
    </span>
  );
}

/* ---------------- breadcrumbs ---------------- */
function Breadcrumbs({ items }) {
  return (
    <div className="row wrap" style={{ gap: 6 }}>
      {items.map((it, i) => (
        <span key={i} className="row" style={{ gap: 6 }}>
          {i > 0 && <Icon name="chevR" size={13} style={{ color: "var(--tx-dim)" }} />}
          {it.onClick ? (
            <button className="btn-ghost" onClick={it.onClick} style={{ background: "transparent", border: "none", padding: 0, color: i === items.length - 1 ? "var(--tx-hi)" : "var(--tx-lo)", fontSize: 13, fontWeight: i === items.length - 1 ? 540 : 500 }}>{it.label}</button>
          ) : (
            <span style={{ color: i === items.length - 1 ? "var(--tx-hi)" : "var(--tx-lo)", fontSize: 13, fontWeight: i === items.length - 1 ? 540 : 500 }}>{it.label}</span>
          )}
        </span>
      ))}
    </div>
  );
}

/* ---------------- skeleton ---------------- */
function Skeleton({ w = "100%", h = 14, r = 6, style }) {
  return <span className="skel" style={{ display: "block", width: w, height: h, borderRadius: r, ...style }} />;
}
function SkeletonRows({ rows = 5, cols = 4 }) {
  return (
    <div className="col" style={{ gap: 0 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="row" style={{ gap: 16, padding: "11px 13px", borderBottom: "1px solid var(--line-faint)" }}>
          {Array.from({ length: cols }).map((_, j) => <Skeleton key={j} w={j === 0 ? 150 : `${40 + (i + j) % 3 * 18}px`} />)}
        </div>
      ))}
    </div>
  );
}

/* ---------------- error panel ---------------- */
function ErrorPanel({ code, summary, hint, compact }) {
  return (
    <div className="panel panel-pad" style={{ borderColor: "color-mix(in oklab, var(--c-red) 36%, var(--line))", background: "color-mix(in oklab, var(--c-red) 7%, var(--bg-panel))", padding: compact ? "12px 14px" : null }}>
      <div className="row" style={{ gap: 8, marginBottom: summary ? 6 : 0 }}>
        <Icon name="alert" size={15} style={{ color: "var(--c-red)", flex: "none" }} />
        {code && <span className="mono" style={{ fontSize: 12, color: "var(--c-red)", fontWeight: 600 }}>{code}</span>}
      </div>
      {summary && <div style={{ fontSize: 13, color: "var(--tx-hi)", marginBottom: hint ? 6 : 0 }}>{summary}</div>}
      {hint && <div style={{ fontSize: 12, color: "var(--tx-mid)" }}>↳ {hint}</div>}
    </div>
  );
}

/* ---------------- funding status ---------------- */
const FUND_TOKENS = { funded: "green", cached: "green", pending: "yellow", skipped: "white", failed: "red" };
const FUND_LABELS = { funded: "✓ funded", cached: "✓ cached", pending: "pending", skipped: "skipped", failed: "failed" };
function FundingStatus({ funding }) {
  const tok = FUND_TOKENS[funding.status] || "white";
  return (
    <span className="row" style={{ gap: 6 }}>
      <Dot token={tok} pulse={funding.status === "pending"} />
      <span style={{ fontSize: 12, color: `var(--c-${tok})` }}>{FUND_LABELS[funding.status] || funding.status}</span>
    </span>
  );
}

/* ---------------- JSON tree (recursive, collapsible) ---------------- */
function JsonTree({ data, name, depth = 0, defaultOpen = true }) {
  const [open, setOpen] = useState(depth < 2 ? defaultOpen : false);
  const isObj = data && typeof data === "object";
  const isArr = Array.isArray(data);

  if (!isObj) {
    const tok = typeof data === "number" ? "blue" : typeof data === "boolean" ? "yellow" : data === null ? "dim" : "green";
    const looksAddr = typeof data === "string" && /^0x[0-9a-f]{6,}/i.test(data);
    return (
      <div className="row" style={{ gap: 7, padding: "1.5px 0", paddingLeft: depth * 15 }}>
        {name != null && <span className="mono" style={{ fontSize: 12, color: "var(--c-cyan)" }}>{name}:</span>}
        <span className="mono trunc" style={{ fontSize: 12, color: looksAddr ? "var(--c-magenta)" : `var(--c-${tok})`, maxWidth: 360 }}>{data === null ? "null" : typeof data === "string" ? `"${data}"` : String(data)}</span>
      </div>
    );
  }

  const entries = isArr ? data.map((v, i) => [i, v]) : Object.entries(data);
  return (
    <div>
      <div className="row" style={{ gap: 6, padding: "1.5px 0", paddingLeft: depth * 15, cursor: "pointer" }} onClick={() => setOpen((o) => !o)}>
        <Icon name={open ? "chevD" : "chevR"} size={13} style={{ color: "var(--tx-dim)", flex: "none" }} />
        {name != null && <span className="mono" style={{ fontSize: 12, color: "var(--c-cyan)" }}>{name}:</span>}
        <span className="mono" style={{ fontSize: 12, color: "var(--tx-lo)" }}>{isArr ? `[${entries.length}]` : `{${entries.length}}`}</span>
      </div>
      {open && entries.map(([k, v]) => <JsonTree key={k} name={k} data={v} depth={depth + 1} />)}
    </div>
  );
}

/* ---------------- transaction effects view ---------------- */
function TxEffectsView({ tx }) {
  const gasTotal = tx.gas.computation + tx.gas.storage - tx.gas.rebate;
  return (
    <div className="col" style={{ gap: 16 }}>
      {/* gas breakdown */}
      <div className="panel panel-pad">
        <div className="eyebrow" style={{ marginBottom: 12 }}>Gas</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px,1fr))", gap: 14 }}>
          {[["Computation", tx.gas.computation, "cyan"], ["Storage", tx.gas.storage, "blue"], ["Rebate", -tx.gas.rebate, "green"], ["Budget", tx.gas.budget, null], ["Price", tx.gas.price, null]].map(([l, v, tok]) => (
            <div key={l} className="col" style={{ gap: 3 }}>
              <span style={{ fontSize: 11, color: "var(--tx-lo)" }}>{l}</span>
              <span className="mono tnum" style={{ fontSize: 14, color: tok ? `var(--c-${tok})` : "var(--tx-hi)" }}>{v < 0 ? "−" : ""}{Math.abs(v).toLocaleString()}</span>
            </div>
          ))}
          <div className="col" style={{ gap: 3 }}>
            <span style={{ fontSize: 11, color: "var(--tx-lo)" }}>Total</span>
            <span className="mono tnum" style={{ fontSize: 14, fontWeight: 600 }}>{gasTotal.toLocaleString()}</span>
          </div>
        </div>
      </div>
      {/* balance changes */}
      <div className="panel" style={{ overflow: "hidden" }}>
        <div className="panel-pad" style={{ padding: "12px 16px" }}><div className="eyebrow">Balance changes</div></div>
        <table className="tbl">
          <thead><tr><th>Owner</th><th>Coin</th><th>Amount</th></tr></thead>
          <tbody>
            {tx.balanceChanges.map((b, i) => (
              <tr key={i}>
                <td><AddressChip address={b.owner} name={b.name} /></td>
                <td className="mono" style={{ fontSize: 12 }}>{b.coin}</td>
                <td className="mono tnum" style={{ color: b.amount >= 0 ? "var(--c-green)" : "var(--c-red)" }}>{b.amount >= 0 ? "+" : "−"}{Math.abs(b.amount).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* object changes */}
      <div className="panel" style={{ overflow: "hidden" }}>
        <div className="panel-pad" style={{ padding: "12px 16px" }}><div className="eyebrow">Object changes</div></div>
        <table className="tbl">
          <thead><tr><th>Change</th><th>Object</th><th>Type</th></tr></thead>
          <tbody>
            {tx.objectChanges.map((o, i) => {
              const tok = o.kind === "created" ? "green" : o.kind === "mutated" ? "yellow" : o.kind === "deleted" ? "red" : "cyan";
              return (
                <tr key={i}>
                  <td><span className="badge" style={{ height: 19, fontSize: 10.5, color: `var(--c-${tok})` }}>{o.kind}</span></td>
                  <td><CopyChip text={o.id} display={short(o.id, 7, 4)} /></td>
                  <td className="mono trunc" style={{ fontSize: 11.5, color: "var(--tx-lo)", maxWidth: 240 }}>{o.type}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------------- Panel + PanelHeader (formalized surface) ---------------- */
function Panel({ pad, header, children, style, className = "", ...rest }) {
  return (
    <div className={"panel " + className} style={{ overflow: header && !pad ? "hidden" : undefined, ...style }} {...rest}>
      {header && <div className="panel-pad" style={{ padding: "14px 18px", paddingBottom: pad ? 0 : 14 }}>{header}</div>}
      {pad ? <div className="panel-pad" style={header ? { paddingTop: 0 } : null}>{children}</div> : children}
    </div>
  );
}
const PanelHeader = SectionHead; // {title, count, right}

/* ---------------- DataTable (config-driven) ----------------
   columns: [{ key, label, render?(row), align?, width?, sortable?, sortVal?(row) }]
   sortable table-wide via the `sortable` prop; click headers to cycle asc/desc. */
function DataTable({ columns, rows, rowKey, onRowClick, sortable, empty, dense }) {
  const [sort, setSort] = useState(null); // { key, dir }
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    const val = (r) => (col?.sortVal ? col.sortVal(r) : r[sort.key]);
    return [...rows].sort((a, b) => {
      const x = val(a), y = val(b);
      const cmp = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
      return sort.dir === "asc" ? cmp : -cmp;
    });
  }, [rows, sort, columns]);
  const toggle = (c) => {
    if (!sortable && !c.sortable) return;
    setSort((s) => s?.key !== c.key ? { key: c.key, dir: "asc" } : s.dir === "asc" ? { key: c.key, dir: "desc" } : null);
  };
  return (
    <table className="tbl">
      <thead><tr>
        {columns.map((c) => {
          const on = sort?.key === c.key;
          const canSort = sortable || c.sortable;
          return (
            <th key={c.key} style={{ width: c.width, textAlign: c.align || "left", cursor: canSort ? "pointer" : "default" }} onClick={() => toggle(c)}>
              <span className="row" style={{ gap: 5, justifyContent: c.align === "right" ? "flex-end" : "flex-start" }}>
                {c.label}
                {canSort && <Icon name={on ? (sort.dir === "asc" ? "chevD" : "chevR") : "chevD"} size={11} style={{ opacity: on ? .9 : .3, transform: on && sort.dir === "asc" ? "rotate(180deg)" : "none" }} />}
              </span>
            </th>
          );
        })}
      </tr></thead>
      <tbody>
        {sorted.length === 0 ? (
          <tr><td colSpan={columns.length} style={{ padding: 0 }}>{empty || <EmptyState title="No rows" />}</td></tr>
        ) : sorted.map((r) => (
          <tr key={rowKey ? rowKey(r) : r.id || r.key} className={onRowClick ? "clickable" : ""} onClick={onRowClick ? () => onRowClick(r) : null}>
            {columns.map((c) => <td key={c.key} style={{ textAlign: c.align || "left", padding: dense ? "6px 13px" : undefined }}>{c.render ? c.render(r) : r[c.key]}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ---------------- Segmented control ---------------- */
function Segmented({ value, onChange, options }) {
  // options: [{value,label}] or [value,...]
  const opts = options.map((o) => (typeof o === "string" ? { value: o, label: o } : o));
  return (
    <div className="segmented">
      {opts.map((o) => <button key={o.value} className={"seg " + (value === o.value ? "seg-on" : "")} onClick={() => onChange(o.value)}>{o.label}</button>)}
    </div>
  );
}

/* ---------------- Form controls ---------------- */
function Field({ label, hint, children }) {
  return (
    <div className="col" style={{ gap: 6 }}>
      {label && <span className="eyebrow">{label}</span>}
      {children}
      {hint && <span style={{ fontSize: 11.5, color: "var(--tx-lo)" }}>{hint}</span>}
    </div>
  );
}
function Select({ value, onChange, options, style }) {
  const opts = options.map((o) => (typeof o === "string" ? { value: o, label: o } : o));
  return (
    <select className="field" value={value} onChange={(e) => onChange && onChange(e.target.value)} style={style}>
      {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}
function TextInput({ value, onChange, placeholder, mono, style, ...rest }) {
  return <input className={"field" + (mono ? " mono" : "")} value={value} placeholder={placeholder} onChange={(e) => onChange && onChange(e.target.value)} style={style} {...rest} />;
}
function NumberInput({ value, onChange, style, ...rest }) {
  return <input type="number" className="field mono" value={value} onChange={(e) => onChange && onChange(+e.target.value)} style={style} {...rest} />;
}
function Slider({ value, min = 0, max = 100, step = 1, onChange, suffix, width = 140 }) {
  return (
    <span className="row" style={{ gap: 10 }}>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange && onChange(+e.target.value)} style={{ width, accentColor: "var(--accent)" }} />
      <span className="mono tnum" style={{ fontSize: 12.5, minWidth: 44 }}>{value}{suffix ? " " + suffix : ""}</span>
    </span>
  );
}
function Switch({ checked, onChange }) {
  return (
    <button onClick={() => onChange && onChange(!checked)} style={{ width: 40, height: 23, borderRadius: 999, border: "1px solid var(--line-strong)", background: checked ? "var(--accent)" : "var(--bg-elev-2)", position: "relative", transition: ".16s", cursor: "pointer", padding: 0, flex: "none" }}>
      <span style={{ position: "absolute", top: 2, left: checked ? 19 : 2, width: 17, height: 17, borderRadius: "50%", background: checked ? "var(--accent-ink)" : "var(--tx-mid)", transition: ".16s" }} />
    </button>
  );
}

/* ---------------- DefList / DefRow (key-value) ---------------- */
function DefRow({ label, children, last }) {
  return (
    <div className="row between" style={{ padding: "9px 0", borderBottom: last ? "none" : "1px solid var(--line-faint)", gap: 12 }}>
      <span style={{ fontSize: 12.5, color: "var(--tx-lo)" }}>{label}</span>
      <span style={{ textAlign: "right", minWidth: 0 }}>{children}</span>
    </div>
  );
}
function DefList({ items }) {
  // items: [[label, value], ...]
  return (
    <div className="col">
      {items.map(([k, v], i) => <DefRow key={i} label={k} last={i === items.length - 1}>{typeof v === "string" || typeof v === "number" ? <span className="mono trunc" style={{ fontSize: 12, color: "var(--tx-hi)", maxWidth: 240, display: "inline-block", textAlign: "right" }}>{v}</span> : v}</DefRow>)}
    </div>
  );
}

/* ---------------- Meter ---------------- */
function Meter({ value, max = 100, token = "accent", width }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return <div className="meter" style={{ width }}><span style={{ width: pct + "%", background: token === "accent" ? "var(--accent)" : `var(--c-${token})` }} /></div>;
}

/* ---------------- Collapsible ---------------- */
function Collapsible({ title, defaultOpen = false, children, right }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="panel" style={{ overflow: "hidden" }}>
      <button className="row between" onClick={() => setOpen((o) => !o)} style={{ width: "100%", padding: "12px 16px", background: "transparent", border: "none", cursor: "pointer", gap: 10 }}>
        <span className="row" style={{ gap: 9 }}><Icon name={open ? "chevD" : "chevR"} size={15} style={{ color: "var(--tx-lo)" }} /><span style={{ fontWeight: 540, fontSize: 13.5, color: "var(--tx-hi)" }}>{title}</span></span>
        {right}
      </button>
      {open && <div className="panel-pad fade-up" style={{ paddingTop: 0, borderTop: "1px solid var(--line-faint)" }}><div style={{ paddingTop: 14 }}>{children}</div></div>}
    </div>
  );
}

Object.assign(window, {
  Icon, ICONS, StatusBadge, Dot, statusInfo, STATUS_MAP, CopyChip, AddressChip, EndpointLink,
  CoinAmount, fmtMist, Kpi, SectionHead, EmptyState, LevelPill, LEVEL_TOKEN, ago, short, useCopy, ConfirmDialog,
  Tooltip, Breadcrumbs, Skeleton, SkeletonRows, ErrorPanel, FundingStatus, FUND_TOKENS, FUND_LABELS, JsonTree, TxEffectsView,
  Panel, PanelHeader, DataTable, Segmented, Field, Select, TextInput, NumberInput, Slider, Switch, DefRow, DefList, Meter, Collapsible,
});
