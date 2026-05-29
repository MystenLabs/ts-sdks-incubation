/* ============================================================
   components-viz.jsx — REAL charts via Recharts (window.Recharts)
   Matches the build target: shadcn/ui charts are Recharts under
   the hood, so these port 1:1 to <ChartContainer> + <Area/Bar/Line>.
   Themed with our --viz-* / --c-* CSS tokens (theme-aware).
   Exports: Sparkline, AreaChart, BarChart, DepthChart, CHART_TOOLTIP
   ============================================================ */
(function () {
  const R = window.Recharts;
  if (!R) { console.error("Recharts not loaded"); return; }
  const { ResponsiveContainer, AreaChart: RArea, Area, LineChart: RLine, Line,
    BarChart: RBar, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell } = R;
  const { useId: vUseId } = React;

  /* shared tooltip styling (token-aware) — mirrors shadcn chart tooltip */
  const CHART_TOOLTIP = {
    contentStyle: {
      background: "var(--bg-elev-2)", border: "1px solid var(--line-strong)",
      borderRadius: 8, fontSize: 12, fontFamily: "var(--font-mono)",
      boxShadow: "var(--sh-2)", padding: "7px 10px",
    },
    labelStyle: { color: "var(--tx-lo)", fontSize: 11, marginBottom: 2 },
    itemStyle: { color: "var(--tx-hi)", padding: 0 },
    cursor: { stroke: "var(--line-strong)", strokeWidth: 1 },
  };

  const toData = (arr) => arr.map((v, i) => (typeof v === "number" ? { i, v } : { i, ...v }));

  /* ---------------- Sparkline (tiny, axis-less) ---------------- */
  function Sparkline({ data, color = "var(--viz-1)", width = 96, height = 28, type = "area", className = "" }) {
    const id = vUseId().replace(/:/g, "");
    const d = toData(data);
    return (
      <div className={className} style={{ width, height }}>
        <ResponsiveContainer width="100%" height="100%">
          {type === "area" ? (
            <RArea data={d} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
              <defs>
                <linearGradient id={"sp" + id} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={0.3} />
                  <stop offset="100%" stopColor={color} stopOpacity={0} />
                </linearGradient>
              </defs>
              <Area dataKey="v" stroke={color} strokeWidth={1.5} fill={"url(#sp" + id + ")"} type="monotone" isAnimationActive={false} dot={false} />
            </RArea>
          ) : (
            <RLine data={d} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
              <Line dataKey="v" stroke={color} strokeWidth={1.5} type="monotone" isAnimationActive={false} dot={false} />
            </RLine>
          )}
        </ResponsiveContainer>
      </div>
    );
  }

  /* ---------------- AreaChart (full, optional axes/grid/tooltip) ---------------- */
  function AreaChart({ data, color = "var(--viz-1)", height = 120, grid = true, axis = false, tooltip = true, xKey = "i", className = "" }) {
    const id = vUseId().replace(/:/g, "");
    const d = toData(data);
    return (
      <div className={className} style={{ width: "100%", height }}>
        <ResponsiveContainer width="100%" height="100%">
          <RArea data={d} margin={{ top: 6, right: 6, bottom: axis ? 2 : 6, left: axis ? -16 : 6 }}>
            <defs>
              <linearGradient id={"ar" + id} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.3} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            {grid && <CartesianGrid stroke="var(--viz-grid)" vertical={false} />}
            {axis && <XAxis dataKey={xKey} tick={{ fill: "var(--tx-lo)", fontSize: 10 }} axisLine={false} tickLine={false} />}
            {axis && <YAxis tick={{ fill: "var(--tx-lo)", fontSize: 10 }} axisLine={false} tickLine={false} width={36} />}
            {tooltip && <Tooltip {...CHART_TOOLTIP} />}
            <Area dataKey="v" stroke={color} strokeWidth={2} fill={"url(#ar" + id + ")"} type="monotone" isAnimationActive={false} dot={false} />
          </RArea>
        </ResponsiveContainer>
      </div>
    );
  }

  /* ---------------- BarChart ---------------- */
  function BarChart({ data, color = "var(--viz-2)", height = 120, grid = true, axis = false, tooltip = true, xKey = "label", className = "" }) {
    const d = data.map((x, i) => (typeof x === "number" ? { i, label: i, v: x } : { i, label: x.label, v: x.value }));
    return (
      <div className={className} style={{ width: "100%", height }}>
        <ResponsiveContainer width="100%" height="100%">
          <RBar data={d} margin={{ top: 6, right: 6, bottom: axis ? 2 : 6, left: axis ? -16 : 6 }}>
            {grid && <CartesianGrid stroke="var(--viz-grid)" vertical={false} />}
            {axis && <XAxis dataKey={xKey} tick={{ fill: "var(--tx-lo)", fontSize: 10 }} axisLine={false} tickLine={false} />}
            {axis && <YAxis tick={{ fill: "var(--tx-lo)", fontSize: 10 }} axisLine={false} tickLine={false} width={36} />}
            {tooltip && <Tooltip {...CHART_TOOLTIP} cursor={{ fill: "var(--bg-hover)" }} />}
            <Bar dataKey="v" fill={color} radius={[2, 2, 0, 0]} isAnimationActive={false} />
          </RBar>
        </ResponsiveContainer>
      </div>
    );
  }

  /* ---------------- DepthChart (order book) ---------------- */
  function DepthChart({ bids, asks, height = 160, className = "" }) {
    // cumulative depth, combined into one price-sorted series with bid/ask keys
    let bc = 0, ac = 0;
    const bidPts = bids.map((o) => ({ price: o.price, bid: (bc += o.size) }));
    const askPts = asks.map((o) => ({ price: o.price, ask: (ac += o.size) }));
    const data = [...bidPts].reverse().concat(askPts);
    return (
      <div className={className} style={{ width: "100%", height }}>
        <ResponsiveContainer width="100%" height="100%">
          <RArea data={data} margin={{ top: 6, right: 6, bottom: 2, left: -16 }}>
            <defs>
              <linearGradient id="depthBid" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--c-green)" stopOpacity={0.32} /><stop offset="100%" stopColor="var(--c-green)" stopOpacity={0.02} /></linearGradient>
              <linearGradient id="depthAsk" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--c-red)" stopOpacity={0.32} /><stop offset="100%" stopColor="var(--c-red)" stopOpacity={0.02} /></linearGradient>
            </defs>
            <CartesianGrid stroke="var(--viz-grid)" vertical={false} />
            <XAxis dataKey="price" tick={{ fill: "var(--tx-lo)", fontSize: 10 }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fill: "var(--tx-lo)", fontSize: 10 }} axisLine={false} tickLine={false} width={36} />
            <Tooltip {...CHART_TOOLTIP} />
            <Area dataKey="bid" stroke="var(--c-green)" strokeWidth={1.5} fill="url(#depthBid)" type="stepAfter" isAnimationActive={false} dot={false} connectNulls />
            <Area dataKey="ask" stroke="var(--c-red)" strokeWidth={1.5} fill="url(#depthAsk)" type="stepAfter" isAnimationActive={false} dot={false} connectNulls />
          </RArea>
        </ResponsiveContainer>
      </div>
    );
  }

  Object.assign(window, { Sparkline, AreaChart, BarChart, DepthChart, CHART_TOOLTIP });
})();
