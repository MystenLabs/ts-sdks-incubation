/* ============================================================
   components-extra.jsx — Banner, MultiSelect, Pagination,
   LoadMore, CodeBlock, CoinIcon, Identicon. Utility-first.
   ============================================================ */
const { useState: xUseState, useRef: xUseRef, useEffect: xUseEffect, useMemo: xUseMemo } = React;
const xI = (p) => window.Icon(p);

/* ---------------- Banner / Callout ---------------- */
const BANNER_TONE = {
  info:    { tok: "cyan",   icon: "dot" },
  warn:    { tok: "yellow", icon: "alert" },
  success: { tok: "green",  icon: "check" },
  danger:  { tok: "red",    icon: "alert" },
  neutral: { tok: "white",  icon: "dot" },
};
function Banner({ tone = "info", title, children, action, onClose, className = "" }) {
  const t = BANNER_TONE[tone] || BANNER_TONE.info;
  return (
    <div className={"flex items-start gap-[11px] rounded-[9px] px-[14px] py-[11px] " + className}
      style={{ background: `color-mix(in oklab, var(--c-${t.tok}) 7%, var(--bg-panel))`, border: `1px solid color-mix(in oklab, var(--c-${t.tok}) 34%, var(--line))` }}>
      {t.icon === "dot"
        ? <span className={`dot dot-${t.tok} mt-[5px] shrink-0`} />
        : <window.Icon name={t.icon} size={16} style={{ color: `var(--c-${t.tok})`, marginTop: 1, flex: "none" }} />}
      <div className="flex-1 min-w-0">
        {title && <div className="text-[13px] font-medium text-hi">{title}</div>}
        {children && <div className="text-[12.5px] text-mid mt-[2px] leading-[1.5]">{children}</div>}
      </div>
      {action}
      {onClose && <button className="iconbtn shrink-0" style={{ width: 24, height: 24 }} onClick={onClose}><window.Icon name="x" size={14} /></button>}
    </div>
  );
}

/* ---------------- MultiSelect (faceted filter) ---------------- */
function MultiSelect({ label, icon, options, selected, onToggle, align = "left" }) {
  const [open, setOpen] = xUseState(false);
  const ref = xUseRef();
  xUseEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h);
  }, []);
  const opts = options.map((o) => (typeof o === "string" ? { value: o, label: o } : o));
  const count = selected.length;
  return (
    <div ref={ref} className="relative">
      <button className="btn btn-sm" onClick={() => setOpen((o) => !o)} style={count ? { borderColor: "var(--accent-line)", color: "var(--tx-hi)" } : null}>
        {icon && <window.Icon name={icon} size={13} />}{label}
        {count > 0 && <span className="badge" style={{ height: 16, fontSize: 10, padding: "0 6px", color: "var(--accent)" }}>{count}</span>}
        <window.Icon name="chevD" size={12} />
      </button>
      {open && (
        <div className="panel absolute z-30 min-w-[180px] p-[6px] max-h-[320px] overflow-y-auto" style={{ top: "calc(100% + 6px)", [align]: 0, boxShadow: "var(--sh-pop)" }}>
          {opts.map((o) => {
            const on = selected.includes(o.value);
            return (
              <button key={o.value} className="flex items-center justify-between w-full px-[8px] py-[6px] rounded-[6px] bg-transparent border-none text-[12.5px] cursor-pointer gap-[8px] hover:bg-hover"
                onClick={() => onToggle(o.value)}>
                <span className="flex items-center gap-[7px]">{o.token && <span className={`dot dot-${o.token}`} />}<span style={{ color: on ? "var(--tx-hi)" : "var(--tx-mid)" }}>{o.label}</span></span>
                {on && <window.Icon name="check" size={13} style={{ color: "var(--accent)" }} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ---------------- Pagination + LoadMore ---------------- */
function Pagination({ page, pageCount, onPage }) {
  const nums = [];
  const win = 1;
  for (let i = 0; i < pageCount; i++) {
    if (i === 0 || i === pageCount - 1 || Math.abs(i - page) <= win) nums.push(i);
    else if (nums[nums.length - 1] !== "…") nums.push("…");
  }
  return (
    <div className="flex items-center gap-[5px]">
      <button className="iconbtn" disabled={page === 0} onClick={() => onPage(page - 1)}><window.Icon name="chevL" size={15} /></button>
      {nums.map((n, i) => n === "…"
        ? <span key={i} className="px-[6px] text-dim text-[12px]">…</span>
        : <button key={i} onClick={() => onPage(n)} className="h-[30px] min-w-[30px] px-[8px] rounded-[6px] border text-[12.5px] font-mono tabular-nums cursor-pointer transition-all"
            style={n === page ? { background: "var(--accent-soft)", borderColor: "var(--accent-line)", color: "var(--tx-hi)" } : { background: "transparent", borderColor: "transparent", color: "var(--tx-mid)" }}>{n + 1}</button>)}
      <button className="iconbtn" disabled={page === pageCount - 1} onClick={() => onPage(page + 1)}><window.Icon name="chevR" size={15} /></button>
    </div>
  );
}
function LoadMore({ onClick, loading, remaining }) {
  return (
    <button className="btn w-full" onClick={onClick} disabled={loading}>
      {loading ? <><span className="dot dot-white dot-pulse" /> Loading…</> : <>Load more{remaining != null ? ` · ${remaining.toLocaleString()} remaining` : ""}</>}
    </button>
  );
}

/* ---------------- CodeBlock (lightweight Move/ABI highlight) ---------------- */
const MOVE_KW = /\b(public|entry|fun|struct|module|use|has|key|store|copy|drop|let|mut|return|if|else|while|loop|abort|const|friend|native|acquires|as|move|spec)\b/g;
const MOVE_TY = /\b(u8|u16|u32|u64|u128|u256|bool|address|vector|signer|String|Coin|Balance|TxContext|UID|ID|Option)\b/g;
function highlightMove(line) {
  // order matters; produce array of {t, c}
  const esc = line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let html = esc
    .replace(/(\/\/.*$)/g, '<span style="color:var(--tx-dim)">$1</span>')
    .replace(/("[^"]*")/g, '<span style="color:var(--c-green)">$1</span>')
    .replace(MOVE_KW, '<span style="color:var(--c-magenta)">$1</span>')
    .replace(MOVE_TY, '<span style="color:var(--c-blue)">$1</span>')
    .replace(/\b(0x[0-9a-fA-F]+|\d+)\b/g, '<span style="color:var(--c-yellow)">$1</span>');
  return html;
}
function CodeBlock({ code, lang = "move", className = "" }) {
  const lines = code.replace(/\n$/, "").split("\n");
  return (
    <div className={"rounded-[9px] border border-line bg-base overflow-hidden " + className}>
      <div className="flex items-center justify-between px-[14px] py-[8px] border-b border-line-faint">
        <span className="font-mono text-[11px] text-lo uppercase tracking-[0.08em]">{lang}</span>
        <button className="iconbtn" style={{ width: 24, height: 24 }} onClick={() => navigator.clipboard.writeText(code)}><window.Icon name="copy" size={13} /></button>
      </div>
      <pre className="overflow-x-auto px-[14px] py-[10px] m-0 leading-[1.6]">
        {lines.map((l, i) => (
          <div key={i} className="flex gap-[14px]">
            <span className="font-mono text-[11px] text-dim select-none text-right" style={{ minWidth: 22 }}>{i + 1}</span>
            <code className="font-mono text-[12px] text-hi whitespace-pre" dangerouslySetInnerHTML={{ __html: highlightMove(l) || "&nbsp;" }} />
          </div>
        ))}
      </pre>
    </div>
  );
}

/* ---------------- CoinIcon ---------------- */
const COIN_GLYPH = {
  SUI: { g: "◎", tok: "cyan" }, USDC: { g: "$", tok: "green" }, DEEP: { g: "◆", tok: "blue" },
  WAL: { g: "▲", tok: "magenta" }, NS: { g: "✦", tok: "yellow" },
};
function CoinIcon({ symbol, size = 22 }) {
  const m = COIN_GLYPH[symbol] || { g: (symbol || "?")[0], tok: "white" };
  return (
    <span className="inline-grid place-items-center rounded-full font-mono shrink-0"
      style={{ width: size, height: size, fontSize: size * 0.5, background: `color-mix(in oklab, var(--c-${m.tok}) 16%, transparent)`, color: `var(--c-${m.tok})`, border: `1px solid color-mix(in oklab, var(--c-${m.tok}) 30%, transparent)` }}>
      {m.g}
    </span>
  );
}

/* ---------------- Identicon (deterministic avatar) ---------------- */
function hashStr(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h; }
function Identicon({ address = "", size = 28, className = "" }) {
  const h = hashStr(address);
  const hue = h % 360, hue2 = (hue + 40) % 360;
  const cells = [];
  // 5x5 symmetric pattern
  for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) {
    const on = ((h >> (y * 3 + x)) & 1) === 1;
    if (on) { cells.push([x, y]); if (x < 2) cells.push([4 - x, y]); }
  }
  const fg = `hsl(${hue} 70% 65%)`;
  return (
    <span className={"inline-block rounded-[6px] overflow-hidden shrink-0 " + className} style={{ width: size, height: size }}>
      <svg viewBox="0 0 5 5" width={size} height={size}>
        <rect width="5" height="5" fill={`hsl(${hue2} 30% 18%)`} />
        {cells.map(([x, y], i) => <rect key={i} x={x} y={y} width="1.02" height="1.02" fill={fg} />)}
      </svg>
    </span>
  );
}

Object.assign(window, { Banner, MultiSelect, Pagination, LoadMore, CodeBlock, CoinIcon, Identicon, BANNER_TONE });
