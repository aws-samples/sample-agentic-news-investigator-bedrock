// fin dashboard — vanilla JS, no dependencies. Polls /api/overview and renders.
const $ = (sel, root = document) => root.querySelector(sel);
// A static export (src/dashboard-static.ts) inlines one /api/overview payload here; the page then renders it once and never polls.
const SNAPSHOT = window.__FIN_SNAPSHOT__ || null;
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const H = 3_600_000;
const RANGES = [["today", "Today"], ["24h", "24 hours"], ["72h", "72 hours"], ["7d", "7 days"]];
const state = {
  data: null,
  generatedAt: null,
  range: localStorage.getItem("fin.range") || "24h",
  table: false,
  /** Book chip selection; null = the focus arm (d.focusArm). Arms come from arms.json via /api/overview. */
  arm: null,
};
const focusOf = (d) => d.arms[d.focusArm] ?? null;
const supName = (s) => (s ? s.kind : "supervisor");

// ---------- formatting ----------
const usd0 = (n) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const usd2 = (n) => n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (n, d = 0) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const signed = (n, f) => (n > 0 ? "+" : n < 0 ? "−" : "") + f(Math.abs(n));
const pct = (n, d = 2) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(d)}%`;
const price = (p) => (p >= 1000 ? num(p, 0) : p >= 10 ? num(p, 2) : num(p, 3));
const compactUsd = (v) => (Math.abs(v) >= 1000 ? `$${(v / 1000).toFixed(1)}k` : usd0(v));
const tShort = (ms) => new Date(ms).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" });
const tDay = (ms) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const tDayTime = (ms) => new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const ago = (ms) => {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${(s / 3600).toFixed(s < 7200 ? 1 : 0)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};
const dur = (ms) => {
  const h = ms / H;
  return h >= 48 ? `${(h / 24).toFixed(1)} d` : h >= 1 ? `${h.toFixed(1)} h` : `${Math.round(ms / 60000)} min`;
};
const cls = (...xs) => xs.filter(Boolean).join(" ");
const localDay = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const dayNoon = (day) => new Date(`${day}T12:00:00`).getTime();
// Prediction-market slugs are sentences with hyphens; read them as sentences.
const shortSym = (s) => {
  if (!s) return "";
  if (s.length <= 30) return s;
  const t = s
    .replace(/^will-(a-|an-|the-|any-)?/, "")
    .replace(/-\d{17,}$/, "")
    .replace(/:YES$/, " · YES")
    .replace(/:NO$/, " · NO")
    .replace(/-/g, " ")
    .replace(/\b(january|february|march|april|june|july|august|september|october|november|december)\b/gi, (m) => m.slice(0, 3))
    .replace(/(\d{17,})/, "");
  return t.charAt(0).toUpperCase() + t.slice(1);
};

// ---------- DOM ----------
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}
const NS = "http://www.w3.org/2000/svg";
function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}
function card(id, title, sub) {
  const a = $(`#${id}`);
  const actions = el("div", { class: "card-actions" });
  const body = el("div", { class: "card-b" });
  a.replaceChildren(
    el("div", { class: "card-h" }, el("div", {}, el("h2", { text: title }), sub ? el("p", { class: "sub", text: sub }) : null), actions),
    body,
  );
  return { actions, body };
}

// Tooltip: one element, values lead, names follow, line keys not boxes.
const tip = $("#tip");
function showTip(x, y, title, rows) {
  tip.replaceChildren(
    title ? el("div", { class: "t", text: title }) : null,
    ...rows.map((r) =>
      el("div", { class: "r" }, el("span", { class: "n" }, r.color ? el("i", { style: `background:${r.color}` }) : null, el("span", { text: r.label })), el("b", { text: r.value })),
    ),
  );
  tip.classList.add("show");
  tip.setAttribute("aria-hidden", "false");
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = `${Math.min(x + 14, innerWidth - w - 12)}px`;
  tip.style.top = `${Math.min(Math.max(12, y - h - 14), innerHeight - h - 12)}px`;
}
function hideTip() {
  tip.classList.remove("show");
  tip.setAttribute("aria-hidden", "true");
}

// Redraw SVG charts when their container changes width (debounced).
const ro = new ResizeObserver((entries) => {
  for (const e of entries) {
    const fn = e.target.__draw;
    if (!fn) continue;
    clearTimeout(e.target.__t);
    e.target.__t = setTimeout(fn, 60);
  }
});
function observe(node, fn) {
  node.__draw = fn;
  ro.observe(node);
}

// Numbers tween from their previous value across refreshes.
const prevValues = {};
function valueNode(key, to, fmt) {
  const n = el("div", { class: "value" });
  const from = prevValues[key];
  prevValues[key] = to;
  if (REDUCED || from === undefined || from === to || !Number.isFinite(from)) {
    n.textContent = fmt(to);
    return n;
  }
  const t0 = performance.now(), d = 650;
  const step = (now) => {
    const k = Math.min(1, (now - t0) / d), e = 1 - Math.pow(1 - k, 3);
    n.textContent = fmt(from + (to - from) * e);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  return n;
}

function sparkline(points, { w = 160, h = 36, color = "var(--s1)" } = {}) {
  const pts = points.filter((p) => Number.isFinite(p.tMs) && Number.isFinite(p.value)).sort((a, b) => a.tMs - b.tMs);
  if (pts.length < 2) return null;
  const xs = pts.map((p) => p.tMs), ys = pts.map((p) => p.value);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const sx = (t) => (x1 === x0 ? 3 : ((t - x0) / (x1 - x0)) * (w - 8) + 4);
  const sy = (v) => (y1 === y0 ? h / 2 : h - 5 - ((v - y0) / (y1 - y0)) * (h - 10));
  const d = pts.map((p, i) => `${i ? "L" : "M"}${sx(p.tMs).toFixed(1)},${sy(p.value).toFixed(1)}`).join(" ");
  const last = pts.at(-1);
  return svg(
    "svg",
    { class: "spark", viewBox: `0 0 ${w} ${h}`, width: w, height: h, "aria-hidden": "true" },
    svg("path", { d, fill: "none", stroke: color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }),
    svg("circle", { cx: sx(last.tMs), cy: sy(last.value), r: 3.5, fill: color, stroke: "var(--surface)", "stroke-width": 2 }),
  );
}

function tile({ key, label, value, fmt, delta, hero, wide, spark, foot, meter, rows }) {
  const t = el("div", { class: cls("tile", hero && "hero", wide && "w2") }, el("div", { class: "label", text: label }));
  if (value !== undefined) t.append(valueNode(key, value, fmt));
  if (rows) t.append(el("div", { class: "rows" }, ...rows.map(([k, v]) => el("div", {}, el("span", { text: k }), el("span", { text: v })))));
  if (delta) {
    const dir = delta.good === null || delta.good === undefined ? "" : delta.good ? "up" : "down";
    t.append(el("div", { class: cls("delta", dir) }, el("b", { text: delta.text }), el("span", { text: delta.label })));
  }
  if (spark) t.append(spark);
  if (meter) t.append(meter);
  if (foot) t.append(el("div", { class: "foot", text: foot }));
  return t;
}

// ---------- header ----------
function pill(kind, b, txt) {
  return el("span", { class: cls("pill", kind) }, el("i", { class: "dot" }), el("b", { text: b }), el("span", { text: txt }));
}
function renderStatus(d) {
  const w = d.worker, now = Date.now();
  const logAge = w.logMtimeIso ? now - Date.parse(w.logMtimeIso) : Infinity;
  const rowAge = w.lastRowIso ? now - Date.parse(w.lastRowIso) : Infinity;
  const running = w.supervisor ? w.supervisor.state === "running" : logAge < 15 * 60000;
  let kind = "good", label = "Worker live";
  if (!running || logAge > 60 * 60000) { kind = "crit"; label = running ? "Worker silent" : "Worker offline"; }
  else if (rowAge > 2 * H) { kind = "warn"; label = "Worker quiet"; }
  const s = d.spend;
  $("#status").replaceChildren(
    ...[
      pill(kind, label, w.lastRowIso ? `last row ${ago(Date.parse(w.lastRowIso))}` : "no rows yet"),
      pill(!s.allowed ? "crit" : s.todayUsd >= s.newsCeilingUsd ? "warn" : "good", "Budget", `${usd2(s.todayUsd)} of ${usd0(s.dailyBudgetUsd)} today`),
      w.killSwitch ? pill("crit", "Kill switch", `ON — ${d.focusArm} halted`) : null,
      // One pill per other agent arm's worker (the focus arm has the Worker pill above).
      ...d.ops.arms.filter((a) => a.key !== d.focusArm).map(armPill),
      letterPill(d.ops.letter),
      pill("", "Model", d.model.replace(/^.*?claude-/, "")),
    ].filter(Boolean),
  );
}
function armPill(a) {
  if (!a) return null;
  const logAge = a.logMtimeIso ? Date.now() - Date.parse(a.logMtimeIso) : Infinity;
  const running = a.supervisor ? a.supervisor.state === "running" : logAge < 15 * 60000;
  const kind = !running ? "crit" : logAge > 60 * 60000 ? "warn" : "good";
  return pill(kind, `${a.key} worker`, a.killSwitch ? "kill switch ON" : running ? `${a.queue ? `${num(a.queue.visible)} queued` : "queue unread"}` : "offline");
}
function letterPill(L) {
  if (!L) return null;
  const code = L.supervisor ? L.supervisor.lastExitCode : null;
  const kind = code === 0 ? "good" : code === null ? "" : "crit";
  const last = L.lastRun ? L.lastRun.day : "none";
  return pill(kind, "Letter", code === 0 ? `${last} · last run ok` : code === null ? last : `${last} · last run failed`);
}

// ---------- KPIs ----------
function spendTile(d) {
  const s = d.spend;
  const frac = s.dailyBudgetUsd > 0 ? s.todayUsd / s.dailyBudgetUsd : 0;
  const meter = el("div", { class: cls("meter", s.todayUsd >= s.dailyBudgetUsd ? "crit" : s.todayUsd >= s.newsCeilingUsd ? "warn" : "") }, el("i", { style: `width:${Math.min(100, frac * 100).toFixed(1)}%` }));
  return tile({
    key: "spend", label: "LLM spend today (UTC day)", value: s.todayUsd, fmt: usd2, meter, wide: true,
    delta: { text: `${(frac * 100).toFixed(0)}%`, good: null, label: `of the ${usd0(s.dailyBudgetUsd)} budget · ${s.todayInvestigations} investigations` },
    foot: `${usd2(s.toDateUsd)} to date · this is real money, the P&L is not${s.allowed ? "" : ` · ${s.reason || "breaker tripped"}`}`,
  });
}
/** A wide tile for a non-focus arm: what it is, how it differs from the focus arm, and since when. */
function otherArmTile(a, focusKey) {
  const since = a.inceptionIso ? (a.kind === "pipeline" ? tDay(Date.parse(a.inceptionIso)) : tDayTime(Date.parse(a.inceptionIso))) : "?";
  const foot = a.kind === "pipeline"
    ? `${a.positions.length} positions · gated pipeline · longer window, context only`
    : `${a.positions.length} positions · cash ${usd0(a.cash)} · same news, ${a.worldModel ? "gated shared memory" : "another agent"}`;
  return tile({ key: a.key, label: a.label, value: a.equity, fmt: usd0, wide: true, delta: { text: pct(a.returnPct), good: a.returnPct >= 0, label: `on ${usd0(a.seed)} since ${since}` }, foot });
}
function renderKpis(d) {
  const v2 = focusOf(d);
  const others = d.armKeys.filter((k) => k !== d.focusArm).map((k) => d.arms[k]).filter(Boolean);
  const k = $("#kpis");
  k.replaceChildren();
  if (!v2) { k.append(el("div", { class: "emptymsg", text: `${d.focusArm} book not found` })); return; }
  const today = localDay(Date.now());
  const prevSnap = v2.snapshots.filter((s) => s.day < today).at(-1) ?? null;
  const sinceSnap = prevSnap ? v2.equity - prevSnap.equity : null;
  const sparkPts = v2.snapshots.map((s) => ({ tMs: dayNoon(s.day), value: s.equity }));
  if (v2.inceptionIso) sparkPts.unshift({ tMs: Date.parse(v2.inceptionIso), value: v2.seed });
  sparkPts.push({ tMs: Date.now(), value: v2.equity });
  const days = v2.inceptionIso ? (Date.now() - Date.parse(v2.inceptionIso)) / 86400000 : null;
  const cost = v2.positions.reduce((s, p) => s + p.costBasis, 0);
  k.append(
    tile({
      key: "eq", label: `${d.focusArm} equity`, value: v2.equity, fmt: usd0, hero: true,
      spark: sparkline(sparkPts, { w: 240, h: 44 }),
      delta: sinceSnap === null ? undefined : { text: signed(sinceSnap, usd0), good: sinceSnap >= 0, label: `since the ${prevSnap.day} snapshot` },
      foot: `on a ${usd0(v2.seed)} seed${v2.inceptionIso ? ` since ${tDayTime(Date.parse(v2.inceptionIso))} (${days.toFixed(1)} days)` : ""} · positions marked at the bid`,
    }),
    tile({ key: "ret", label: "Return on seed", value: v2.returnPct, fmt: (n) => pct(n), delta: { text: signed(v2.equity - v2.seed, usd0), good: v2.equity >= v2.seed, label: "total P&L" }, foot: `${v2.fills} fills · ${usd0(v2.buyNotional)} ever committed` }),
    tile({ key: "cash", label: "Cash", value: v2.cash, fmt: usd0, foot: `${((v2.cash / v2.equity) * 100).toFixed(1)}% of equity, earning nothing` }),
    tile({ key: "pos", label: "Positions at liquidation", value: v2.positionsValue, fmt: usd0, delta: { text: signed(v2.unrealized, usd0), good: v2.unrealized >= 0, label: "unrealized" }, foot: `${v2.positions.length} positions · cost basis ${usd0(cost)}` }),
    tile({ key: "real", label: "Realized P&L", value: v2.realized, fmt: (n) => signed(n, usd0), foot: "closed positions and settlements since inception" }),
    spendTile(d),
    mandateTile(d),
    // Every other arm in arms.json, in the server's order (other agents first, then pipeline arms).
    ...others.map((a) => otherArmTile(a, d.focusArm)),
    tile({ key: "bm", label: `Market since ${d.focusArm} inception`, wide: true, rows: d.benchmarks.map((b) => [`${b.symbol} · ${b.label}`, b.returnPct === null ? "—" : pct(b.returnPct)]), foot: "$100k bought at the last close before inception" }),
    ...(d.world ? worldTiles(d) : []),
  );
}
function mandateTile(d) {
  const m = d.mandate;
  if (!m) return null;
  const dep = m.deployedPct === null ? null : m.deployedPct * 100;
  const lo = m.minDeployedPct * 100, hi = m.maxDeployedPct * 100;
  const meter = el("div", { class: cls("meter", "band", m.status === "under" && "under", m.status === "over" && "over"), role: "img", "aria-label": `deployed ${dep === null ? "unknown" : dep.toFixed(0) + "%"} against a ${lo.toFixed(0)}–${hi.toFixed(0)}% band` },
    el("span", { class: "zone", style: `left:${lo}%;width:${hi - lo}%` }),
    el("i", { style: `width:${Math.min(100, Math.max(0, dep ?? 0)).toFixed(1)}%` }));
  const status = m.status === "under" ? `${usd0(m.gapUsd)} short of the ${lo.toFixed(0)}% floor` : m.status === "over" ? `${usd0(m.gapUsd)} above the ${hi.toFixed(0)}% ceiling` : m.status === "in-band" ? `inside the ${lo.toFixed(0)}–${hi.toFixed(0)}% band` : "equity unknown";
  const posNote = m.positionsStatus === "few" ? "below the mandate's minimum" : m.positionsStatus === "many" ? "above the mandate's maximum" : "within the band";
  return tile({
    key: "mandate", label: "Deployed vs mandate", value: dep ?? 0, fmt: (n) => `${n.toFixed(0)}%`, meter, wide: true,
    delta: { text: `${m.positions} positions`, good: m.positionsStatus === "in-band" ? true : null, label: `of ${m.minPositions}–${m.maxPositions} · ${posNote}` },
    foot: `${usd0(m.deployedUsd)} gross at liquidation · ${status}${m.largestPositionPct !== null ? ` · largest ${(m.largestPositionPct * 100).toFixed(1)}% (cap ${(m.maxPositionPct * 100).toFixed(0)}%)` : ""}`,
  });
}
function worldTiles(d) {
  const w = d.world, s = w.stats;
  const ents = Object.entries(s.nodes).filter(([, n]) => n > 0).map(([t, n]) => [t, num(n)]);
  const total = w.proposals.accepted + w.proposals.rejected;
  return [
    tile({ key: "wm", label: `World model (${d.worldArm})`, wide: true, rows: [["entities", num(Object.values(s.nodes).reduce((a, b) => a + b, 0))], ["exposure links", num(s.edges)], ["facts", num(s.facts)]], foot: ents.length ? ents.map(([t, n]) => `${t} ${n}`).join(" · ") : "empty — waiting for the first investigation" }),
    tile({ key: "gate", label: "Gate, last 7 days", value: total ? (w.proposals.rejected / total) * 100 : 0, fmt: (n) => `${n.toFixed(0)}%`, wide: true, delta: { text: `${num(w.proposals.rejected)} of ${num(total)}`, good: null, label: "proposals rejected" }, foot: total ? Object.entries(w.proposals.checks).map(([k, v]) => `${k} ${v}`).join(" · ") : "no proposals yet" }),
  ];
}

// ---------- equity chart ----------
const seriesColor = (s) => (s.role === "focus" ? "var(--s1)" : s.role === "arm" ? "var(--s3)" : s.role === "identity" ? "var(--s2)" : "var(--ctx)");
function niceTicks(lo, hi, n) {
  const span = hi - lo || 1, raw = span / n, mag = 10 ** Math.floor(Math.log10(raw)), norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v);
  return out;
}
function dayTicks(x0, x1, pw) {
  const out = [];
  const d = new Date(x0); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 1);
  for (let t = d.getTime(); t <= x1; t += 86400000) out.push(new Date(t).setHours(0, 0, 0, 0));
  const k = Math.ceil(out.length / Math.max(2, Math.floor(pw / 72)));
  return out.filter((_, i) => i % k === 0);
}
function lastAtOrBefore(points, t) {
  let best = null;
  for (const p of points) if (p.tMs <= t && (!best || p.tMs > best.tMs)) best = p;
  return best;
}
function drawEquity(wrap, series, seed) {
  const W = Math.max(320, wrap.clientWidth || 800), Hh = 320;
  const m = { t: 18, r: 118, b: 34, l: 62 };
  const pw = W - m.l - m.r, ph = Hh - m.t - m.b;
  const all = series.flatMap((s) => s.points).filter((p) => Number.isFinite(p.value) && Number.isFinite(p.tMs));
  if (all.length === 0) { wrap.replaceChildren(el("div", { class: "emptymsg", text: "No equity points yet." })); return; }
  const x0 = Math.min(...all.map((p) => p.tMs)), x1 = Math.max(...all.map((p) => p.tMs), Date.now());
  let y0 = Math.min(...all.map((p) => p.value), seed), y1 = Math.max(...all.map((p) => p.value), seed);
  const pad = Math.max((y1 - y0) * 0.14, 400); y0 -= pad; y1 += pad;
  const sx = (t) => m.l + ((t - x0) / Math.max(1, x1 - x0)) * pw;
  const sy = (v) => m.t + ph - ((v - y0) / (y1 - y0)) * ph;
  const armNames = series.filter((s) => s.role !== "context").map((s) => s.key).join(", ");
  const root = svg("svg", { viewBox: `0 0 ${W} ${Hh}`, width: W, height: Hh, role: "img", "aria-label": `Equity per $100,000 seeded: ${armNames} and benchmarks` });
  const grid = svg("g", { class: "grid" });
  for (const v of niceTicks(y0, y1, 5)) {
    grid.append(svg("line", { x1: m.l, x2: m.l + pw, y1: sy(v), y2: sy(v) }));
    root.append(svg("text", { x: m.l - 8, y: sy(v) + 4, "text-anchor": "end", text: compactUsd(v) }));
  }
  root.append(grid);
  const axis = svg("g", { class: "axis" }, svg("line", { x1: m.l, x2: m.l + pw, y1: m.t + ph, y2: m.t + ph }));
  for (const t of dayTicks(x0, x1, pw)) {
    axis.append(svg("line", { x1: sx(t), x2: sx(t), y1: m.t + ph, y2: m.t + ph + 4 }));
    root.append(svg("text", { x: sx(t), y: m.t + ph + 18, "text-anchor": "middle", text: tDay(t) }));
  }
  root.append(axis);
  root.append(svg("g", { class: "seed" }, svg("line", { x1: m.l, x2: m.l + pw, y1: sy(seed), y2: sy(seed) }), svg("text", { x: m.l + 4, y: sy(seed) - 5, text: `seed ${compactUsd(seed)}` })));
  const ends = [];
  for (const s of series) {
    const pts = s.points.filter((p) => Number.isFinite(p.value)).sort((a, b) => a.tMs - b.tMs);
    if (pts.length === 0) continue;
    const d = pts.map((p, i) => `${i ? "L" : "M"}${sx(p.tMs).toFixed(1)},${sy(p.value).toFixed(1)}`).join(" ");
    root.append(svg("path", { class: cls("line", s.role === "context" && "ctx"), d, stroke: seriesColor(s) }));
    const last = pts.at(-1);
    root.append(svg("circle", { class: "dot", cx: sx(last.tMs), cy: sy(last.value), r: s.role === "context" ? 3 : 4.5, fill: seriesColor(s) }));
    ends.push({ s, x: sx(last.tMs), y: sy(last.value), value: last.value });
  }
  // Direct end labels, pushed apart when lines converge, with leader lines.
  ends.sort((a, b) => a.y - b.y);
  let prevY = -Infinity;
  for (const e of ends) { e.ly = Math.max(e.y, prevY + 14); prevY = e.ly; }
  const over = (ends.at(-1)?.ly ?? 0) - (m.t + ph);
  if (over > 0) for (const e of ends) e.ly -= over;
  for (const e of ends) {
    const lx = m.l + pw + 12;
    if (Math.abs(e.ly - e.y) > 2 || lx - e.x > 20) root.append(svg("line", { class: "leader", x1: e.x + 6, y1: e.y, x2: lx - 4, y2: e.ly }));
    root.append(svg("text", { class: cls("endlab", e.s.role === "focus" && "focus"), x: lx, y: e.ly + 4, text: `${e.s.key} ${compactUsd(e.value)}` }));
  }
  const xh = svg("line", { class: "xh", x1: 0, x2: 0, y1: m.t, y2: m.t + ph, opacity: 0 });
  const hit = svg("rect", { class: "hit", x: m.l, y: m.t, width: pw, height: ph });
  hit.addEventListener("pointermove", (ev) => {
    const r = root.getBoundingClientRect();
    const px = (ev.clientX - r.left) * (W / r.width);
    const t = x0 + ((px - m.l) / pw) * (x1 - x0);
    const rows = series.map((s) => { const p = lastAtOrBefore(s.points, t); return p ? { label: s.key, color: seriesColor(s), value: usd0(p.value) } : null; }).filter(Boolean);
    xh.setAttribute("x1", px); xh.setAttribute("x2", px); xh.setAttribute("opacity", 1);
    showTip(ev.clientX, ev.clientY, tDayTime(t), rows);
  });
  hit.addEventListener("pointerleave", () => { xh.setAttribute("opacity", 0); hideTip(); });
  root.append(xh, hit);
  wrap.replaceChildren(root);
}
function equityTable(series) {
  const days = [...new Set(series.flatMap((s) => s.points.map((p) => localDay(p.tMs))))].sort();
  return el("table", { class: "tbl" },
    el("thead", {}, el("tr", {}, el("th", { text: "Day" }), ...series.map((s) => el("th", { class: "num", text: s.key })))),
    el("tbody", {}, ...days.map((day) => {
      const end = new Date(`${day}T23:59:59`).getTime();
      return el("tr", {}, el("td", { text: day }), ...series.map((s) => { const p = lastAtOrBefore(s.points, end); return el("td", { class: "num", text: p ? usd0(p.value) : "—" }); }));
    })),
  );
}
function legend(series, d) {
  const items = [];
  const f = series.find((s) => s.role === "focus");
  if (f) items.push(el("span", {}, el("i", { class: "k", style: "background:var(--s1)" }), `${f.label} · the arm this page follows${d.arms[f.key]?.worldModel ? "" : " (no world model)"}`));
  for (const a of series.filter((s) => s.role === "arm")) {
    const wm = d.arms[a.key]?.worldModel;
    items.push(el("span", {}, el("i", { class: "k", style: "background:var(--s3)" }), `${a.label} · same news${wm ? ", same code with the gated world model" : ", another agent arm"}`));
  }
  for (const i1 of series.filter((s) => s.role === "identity")) items.push(el("span", {}, el("i", { class: "k", style: "background:var(--s2)" }), `${i1.label} · seeded earlier, shown at actual equity`));
  const ctx = series.filter((s) => s.role === "context");
  if (ctx.length) items.push(el("span", {}, el("i", { class: "k ctx", style: "background:var(--ctx)" }), `benchmarks ${ctx.map((s) => s.key).join(", ")} · $100k bought at the last close before inception`));
  return el("div", { class: "legend" }, ...items);
}
function renderEquity(d) {
  const seed = focusOf(d)?.seed ?? 100000;
  const { actions, body } = card("equity-card", "Equity", `Dollars per $100,000 seeded · books at liquidation value · benchmarks as $100k bought at the last close before ${d.focusArm}'s inception`);
  actions.append(el("button", { class: "chip sm", "aria-pressed": String(state.table), text: state.table ? "Chart" : "Table", onclick: () => { state.table = !state.table; renderEquity(d); } }));
  if (state.table) body.append(equityTable(d.curve));
  else {
    const wrap = el("div", { class: "chart" });
    body.append(wrap);
    const draw = () => drawEquity(wrap, d.curve, seed);
    draw();
    observe(wrap, draw);
  }
  body.append(legend(d.curve, d));
}

// ---------- book ----------
function renderBook(d) {
  const selected = state.arm && d.arms[state.arm] ? state.arm : d.focusArm;
  const arm = d.arms[selected] ?? null;
  const { actions, body } = card("book-card", "Book", arm ? `${arm.label} · ${arm.positions.length} positions · cash ${usd0(arm.cash)}` : "");
  for (const k of d.armKeys) if (d.arms[k]) actions.append(el("button", { class: "chip sm", "aria-pressed": String(selected === k), text: k, onclick: () => { state.arm = k; renderBook(d); } }));
  if (!arm) { body.append(el("div", { class: "emptymsg", text: "No book found." })); return; }
  if (arm.positions.length === 0) { body.append(el("div", { class: "emptymsg", text: "All cash." })); return; }
  const maxW = Math.max(1, ...arm.positions.map((p) => Math.abs(p.weightPct)));
  // Long books scroll inside the card so the row beside the equity chart keeps a sane height.
  body.append(el("div", { class: cls("tblwrap", arm.positions.length > 12 && "book-scroll") }, el("table", { class: "tbl" },
    el("thead", {}, el("tr", {}, el("th", { text: "Position · weight of equity" }), el("th", { class: "num", text: "Qty" }), el("th", { class: "num", text: "Entry → mark (bid)" }), el("th", { class: "num", text: "Unrealized" }))),
    el("tbody", {}, ...arm.positions.map((p) => {
      const thin = p.depth !== null && p.depth < 1000;
      const wide = p.bid !== null && p.ask !== null && p.ask - p.bid > 0.1 * Math.max(p.mark, 1e-9);
      const pnlPct = p.costBasis ? (p.unrealized / p.costBasis) * 100 : 0;
      return el("tr", {},
        el("td", { class: "name" },
          el("div", { class: "sym", title: p.symbol, text: shortSym(p.symbol) }),
          el("div", { class: "wrow" }, el("i", { class: "wbar", style: `width:${Math.max(4, (Math.abs(p.weightPct) / maxW) * 56).toFixed(0)}px` }), el("span", { class: "dim", text: `${p.weightPct.toFixed(1)}% of equity${p.side === "short" ? " (short)" : ""}` })),
          el("div", { class: "dim" }, el("span", { class: "tagk", text: p.kind }), p.side === "short" ? [" ", el("span", { class: "tagk", text: "short" })] : null,
            p.resolved ? " · resolved" : "",
            p.quotable ? (p.bid !== null && p.ask !== null ? ` · book ${price(p.bid)} / ${price(p.ask)}` : "") : " · unquotable, held at cost",
            p.depth !== null ? ` · depth ${usd0(p.depth)}` : "",
            thin || wide ? [" ", el("span", { class: "warnflag", text: thin ? "thin book" : "wide spread" })] : null)),
        el("td", { class: "num", text: num(p.qty, p.qty < 100 ? 2 : 0) }),
        el("td", { class: "num" }, el("div", { text: `${price(p.avgCost)} → ${price(p.mark)}` }), el("div", { class: "dim", text: `${pct(((p.mark - p.avgCost) / (p.avgCost || 1)) * 100, 1)}` })),
        el("td", { class: cls("num", p.unrealized >= 0 ? "pos" : "neg") }, el("div", { text: signed(p.unrealized, usd0) }), el("div", { class: "dim", text: `${pct(pnlPct, 1)} of cost` })),
      );
    })),
  )));
  if (selected === d.focusArm && d.corrections.length) {
    body.append(el("div", { class: "mini-title", style: "margin-top:12px" }, el("span", { text: "Book corrections in the window — administrative reversals at cost, not trades" }), el("span", { text: String(d.corrections.length) })));
    for (const c of d.corrections) body.append(el("div", { class: "gapline", title: c.reason },
      el("span", { text: `${tDayTime(c.atMs)} · reversed ${c.qty > 0 ? "long" : "short"} ${num(Math.abs(c.qty))} ${shortSym(c.symbol)} at cost ${price(c.avgCost)} (${usd0(c.costBasis)})` }),
      el("span", { class: "d", text: `${signed(-c.unrealizedRemovedUsd, usd0)} to equity` })));
  }
}

// ---------- activity window ----------
function sinceMs() {
  if (state.range === "today") { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
  return Date.now() - ({ "24h": 24, "72h": 72, "7d": 168 }[state.range] ?? 24) * H;
}
function renderFilters(d) {
  $("#filters").replaceChildren(
    el("span", { class: "flabel", text: "Activity window" }),
    ...RANGES.map(([k, label]) => el("button", { class: "chip", "aria-pressed": String(state.range === k), text: label, onclick: () => { state.range = k; localStorage.setItem("fin.range", k); renderFilters(d); renderActivity(d); } })),
  );
}
function renderActivity(d) {
  const since = Math.max(sinceMs(), d.windowStartMs);
  renderPulse(d, since);
  renderCoverage(d, since);
  renderNews(d, since);
  renderFeed(d, since);
  renderWorld(d);
}
function clippedGaps(d, since, now) {
  return d.gaps.map((g) => ({ fromMs: Math.max(g.fromMs, since), toMs: Math.min(g.toMs, now) })).filter((g) => g.toMs > g.fromMs);
}
function topRounded(x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}
function drawColumns(wrap, buckets, gaps, x0, x1, val, { height = 96, showAxis = true, marks = null } = {}) {
  const W = Math.max(320, wrap.clientWidth || 700);
  const m = { t: 10, r: 8, b: showAxis ? 22 : 6, l: 36 };
  const pw = W - m.l - m.r, ph = height - m.t - m.b;
  const root = svg("svg", { viewBox: `0 0 ${W} ${height}`, width: W, height, role: "img" });
  const max = Math.max(1, ...buckets.map(val));
  const sx = (t) => m.l + ((t - x0) / Math.max(1, x1 - x0)) * pw;
  const sy = (v) => m.t + ph - (v / max) * ph;
  for (const g of gaps) root.append(svg("rect", { class: "gap", x: sx(g.fromMs), y: m.t, width: Math.max(1, sx(g.toMs) - sx(g.fromMs)), height: ph }));
  root.append(svg("text", { x: m.l - 6, y: m.t + 4, "text-anchor": "end", text: num(max) }), svg("text", { x: m.l - 6, y: m.t + ph + 4, "text-anchor": "end", text: "0" }));
  root.append(svg("g", { class: "axis" }, svg("line", { x1: m.l, x2: m.l + pw, y1: m.t + ph, y2: m.t + ph })));
  const slot = pw / Math.max(1, buckets.length);
  const bw = Math.min(24, Math.max(2, slot - 2));
  for (const b of buckets) {
    const v = val(b), x = sx(b.tMs) + (slot - bw) / 2, y = sy(v), h = m.t + ph - y;
    const hitr = svg("rect", { class: "slot", x: sx(b.tMs), y: m.t, width: Math.max(1, slot), height: ph });
    const bar = v > 0 ? svg("path", { class: "bar", d: topRounded(x, y, bw, h, 4), fill: "var(--s1)" }) : svg("rect", { class: "bar", x, y: m.t + ph, width: bw, height: 0 });
    hitr.addEventListener("pointermove", (ev) => showTip(ev.clientX, ev.clientY, `${tDayTime(b.tMs)} – ${new Date(b.tMs + H).toLocaleTimeString("en-US", { hour: "numeric" })}`, [
      { label: "news triaged", value: num(b.triaged) },
      { label: "investigations", value: num(b.investigated) },
      { label: "fills", value: num(b.fills) },
      { label: "position alerts", value: num(b.alerts) },
      ...(b.suppressed ? [{ label: "alerts suppressed", value: num(b.suppressed) }] : []),
    ]));
    hitr.addEventListener("pointerleave", hideTip);
    root.append(hitr, bar);
    if (marks && marks(b) > 0) root.append(svg("circle", { class: "dot", cx: x + bw / 2, cy: Math.max(m.t + 5, y - 8), r: 4, fill: "var(--s3)" }));
  }
  if (showAxis) for (const t of dayTicks(x0, x1, pw)) root.append(svg("text", { x: sx(t), y: height - 6, "text-anchor": "middle", text: tDay(t) }));
  for (const g of gaps) if (sx(g.toMs) - sx(g.fromMs) > 56) root.append(svg("text", { class: "gaplab", x: (sx(g.fromMs) + sx(g.toMs)) / 2, y: m.t + 12, "text-anchor": "middle", text: `offline ${dur(g.toMs - g.fromMs)}` }));
  wrap.replaceChildren(root);
}
function renderPulse(d, since) {
  const now = Date.now();
  const buckets = d.pulse.filter((b) => b.tMs + H > since && b.tMs <= now);
  const gaps = clippedGaps(d, since, now);
  const total = buckets.reduce((a, b) => ({ triaged: a.triaged + b.triaged, investigated: a.investigated + b.investigated, fills: a.fills + b.fills }), { triaged: 0, investigated: 0, fills: 0 });
  const { body } = card("pulse-card", "Activity per hour", `${num(total.triaged)} news items triaged · ${num(total.investigated)} investigations · ${num(total.fills)} fills · grey bands: no rows written for 2 h or more`);
  const w1 = el("div", { class: "chart" }), w2 = el("div", { class: "chart" });
  body.append(
    el("div", { class: "mini-title" }, el("span", { text: "News triaged" }), el("span", { text: num(total.triaged) })), w1,
    el("div", { class: "mini-title" }, el("span", { text: "Investigations · dots mark hours with fills" }), el("span", { text: num(total.investigated) })), w2,
  );
  const draw = () => {
    drawColumns(w1, buckets, gaps, since, now, (b) => b.triaged, { height: 96, showAxis: false });
    drawColumns(w2, buckets, gaps, since, now, (b) => b.investigated, { height: 104, showAxis: true, marks: (b) => b.fills });
  };
  draw();
  observe(w1, draw);
}
function renderCoverage(d, since) {
  const now = Date.now();
  const ev = d.events.filter((e) => e.atMs >= since);
  const gaps = clippedGaps(d, since, now);
  const suppressed = ev.filter((e) => e.suppressed), skipped = ev.filter((e) => e.skipped && !e.investigated), deduped = ev.filter((e) => e.deduped), errored = ev.filter((e) => e.errored);
  const offlineMs = gaps.reduce((s, g) => s + (g.toMs - g.fromMs), 0);
  const { body } = card("coverage-card", "When the agent was not looking", `${((offlineMs / Math.max(1, now - since)) * 100).toFixed(0)}% of the window with no rows written`);
  const list = el("div", {});
  if (gaps.length === 0) list.append(el("div", { class: "emptymsg", text: "No processing gaps of 2 hours or more in this window." }));
  for (const g of gaps) list.append(el("div", { class: "gapline" }, el("span", { text: `${tDayTime(g.fromMs)} → ${tDayTime(g.toMs)}` }), el("span", { class: "d", text: dur(g.toMs - g.fromMs) })));
  body.append(list);
  const bySym = new Map();
  for (const e of suppressed) bySym.set(e.suppressed.symbol, (bySym.get(e.suppressed.symbol) ?? 0) + 1);
  const w = d.worker;
  const dl = el("dl", { class: "kv" });
  const row = (k, v) => dl.append(el("dt", { text: k }), el("dd", { text: v }));
  const budgetSup = suppressed.filter((e) => e.suppressed.kind !== "thin-book"), thinSup = suppressed.filter((e) => e.suppressed.kind === "thin-book");
  const countBy = (xs) => { const m = new Map(); for (const e of xs) m.set(e.suppressed.symbol, (m.get(e.suppressed.symbol) ?? 0) + 1); return [...m].map(([s, n]) => `${shortSym(s)} ×${n}`).join(", ") || "0"; };
  row("Position alerts suppressed by budget", countBy(budgetSup));
  row("Moves on thin books judged not events", countBy(thinSup));
  row("Material news skipped by budget", String(skipped.length));
  row("Duplicate headlines dropped", String(deduped.length));
  row("Errored investigations", String(errored.length));
  row("Budget breaker (UTC day)", d.spend.allowed ? "open — no refusals today" : `${d.spend.reason || "tripped"}${d.spend.trippedAtIso ? ` · last refusal ${ago(Date.parse(d.spend.trippedAtIso))}` : ""}`);
  row("Kill switch", w.killSwitch ? `ON — ${d.focusArm} halted` : "off");
  row(`Worker (${supName(w.supervisor)})`, w.supervisor ? `${w.supervisor.state}${w.supervisor.pid ? ` · pid ${w.supervisor.pid}` : ""}` : d.ops.supervisor === "none" ? "no supervisor configured (V2_SUPERVISOR)" : "not found on this machine");
  row("Last audit row", w.lastRowIso ? ago(Date.parse(w.lastRowIso)) : "—");
  row("Last log write", w.logMtimeIso ? ago(Date.parse(w.logMtimeIso)) : "—");
  body.append(el("div", { style: "margin-top:14px" }, dl));
  if (w.logLastLine) body.append(el("p", { class: "note", text: w.logLastLine }));
}
function decisionChips(e) {
  const frag = document.createDocumentFragment();
  for (const dc of e.decisions.slice(0, 3)) {
    const filled = e.fills.some((f) => f.symbol === dc.symbol);
    const txt = dc.action === "hold"
      ? `hold${dc.watch ? ` · watch ${shortSym(dc.watch)}` : ""}`
      : `${dc.action} ${shortSym(dc.symbol ?? "")}${dc.notional ? ` ${usd0(dc.notional)}` : ""}${dc.limit ? ` @ ≤${price(dc.limit)}` : ""}`;
    frag.append(el("span", { class: cls("dec", dc.action, filled && "filled"), title: `confidence ${dc.confidence}` }, el("i", { class: "k" }), `${txt} · ${dc.confidence.toFixed(2)}`, filled ? " · filled" : ""));
  }
  if (e.decisions.length > 3) frag.append(el("span", { class: "dim", text: `+${e.decisions.length - 3} more` }));
  if (e.errored) frag.append(el("span", { class: "badge err", text: "ERRORED" }));
  return frag;
}
function renderNews(d, since) {
  const ev = d.events.filter((e) => e.atMs >= since && e.materiality !== undefined);
  const { body } = card("news-card", "News flow", `${num(ev.length)} items triaged in the window · by type, then the most material headlines`);
  const types = new Map();
  for (const e of ev) { const t = e.eventType || "other"; const c = types.get(t) ?? { n: 0, inv: 0 }; c.n++; if (e.investigated) c.inv++; types.set(t, c); }
  const rows = [...types].sort((a, b) => b[1].n - a[1].n);
  const max = Math.max(1, ...rows.map((r) => r[1].n));
  if (rows.length === 0) body.append(el("div", { class: "emptymsg", text: "Nothing triaged in this window." }));
  body.append(el("div", { class: "hbars" }, ...rows.map(([t, c]) => el("div", { class: "hbar" }, el("span", { class: "lab", text: t }), el("div", { class: "trk" }, el("div", { class: "fill", style: `width:${((c.n / max) * 100).toFixed(1)}%` }), el("span", { class: "val" }, el("b", { text: num(c.n) }), ` · ${c.inv} investigated`))))));
  const seen = new Map();
  for (const e of ev) {
    const k = e.headline.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80);
    const cur = seen.get(k);
    if (!cur) { seen.set(k, { e, n: 1 }); continue; }
    cur.n++;
    if ((e.investigated && !cur.e.investigated) || (e.investigated === cur.e.investigated && e.materiality > cur.e.materiality)) cur.e = e;
  }
  const top = [...seen.values()].sort((a, b) => b.e.materiality - a.e.materiality || b.e.atMs - a.e.atMs).slice(0, 10);
  if (top.length) {
    body.append(el("div", { class: "mini-title", style: "margin-top:16px" }, el("span", { text: "Most material headlines" }), el("span", { text: "* touches a held position" })));
    body.append(el("div", { class: "list" }, ...top.map(({ e, n }) => el("div", { class: "item" },
      el("div", { class: "when", text: tShort(e.atMs) }),
      el("div", { class: "what" }, el("div", { class: "hl", text: e.headline }), el("div", { class: "meta" },
        el("span", { class: "badge mat", text: `mat ${e.materiality.toFixed(2)}${e.touches ? "*" : ""}` }),
        el("span", { class: "tagk", text: e.eventType || "other" }),
        n > 1 ? el("span", { class: "dim", text: `×${n}` }) : null,
        e.investigated ? decisionChips(e) : el("span", { class: "dim", text: e.skipped ? "budget-skipped" : "not investigated" }))),
      el("div", { class: "side", text: e.cost !== undefined ? usd2(e.cost) : "" }),
    ))));
  }
}
function renderFeed(d, since) {
  const ev = d.events.filter((e) => e.atMs >= since && e.investigated).sort((a, b) => b.atMs - a.atMs);
  const spend = ev.reduce((s, e) => s + (e.cost ?? 0), 0);
  const { body } = card("feed-card", "Investigations", `${num(ev.length)} in the window · ${usd2(spend)} · ${ev.filter((e) => e.fills.length).length} with fills · newest first`);
  if (ev.length === 0) { body.append(el("div", { class: "emptymsg", text: "No investigations in this window." })); return; }
  body.append(el("div", { class: "list" }, ...ev.slice(0, 40).map((e) => el("div", { class: "item" },
    el("div", { class: "when", text: tShort(e.atMs) }),
    el("div", { class: "what" }, el("div", { class: "hl", text: e.headline || "(no headline recorded)" }), el("div", { class: "meta" },
      el("span", { class: "tagk", text: e.trigger || "news" }),
      e.materiality !== undefined ? el("span", { class: "badge mat", text: `mat ${e.materiality.toFixed(2)}${e.touches ? "*" : ""}` }) : null,
      decisionChips(e),
      ...e.fills.map((f) => el("span", { class: "dim", text: `filled ${f.side} ${num(f.qty)} @ ${price(f.price)}${f.deferred ? " (deferred)" : ""}` })),
      e.parked ? el("span", { class: "dim", text: `${e.parked} parked` }) : null,
      ...e.dropped.map((r) => el("span", { class: "dim", text: `dropped: ${r}` })))),
    el("div", { class: "side" }, el("div", { text: e.cost !== undefined ? usd2(e.cost) : "" }), el("div", { text: e.turns !== undefined ? `${e.turns} turns` : "" })),
  ))));
  if (ev.length > 40) body.append(el("p", { class: "note", text: `${ev.length - 40} older investigations not shown.` }));
}

// ---------- world model & curiosity (v3) ----------
function renderWorld(d) {
  const row = $("#world-row");
  if (!d.world) { row.hidden = true; return; }
  row.hidden = false;
  const w = d.world;
  const since = Math.max(sinceMs(), d.windowStartMs);
  const inWin = w.events.filter((e) => e.atMs >= since && e.proposals);
  const acc = inWin.reduce((n, e) => n + e.proposals.accepted, 0), rej = inWin.reduce((n, e) => n + e.proposals.rejected, 0);
  const checks = {};
  for (const e of inWin) for (const [k, v] of Object.entries(e.proposals.checks)) checks[k] = (checks[k] ?? 0) + v;
  const { body } = card("world-card", "What the gate ruled", `${num(acc)} proposals accepted · ${num(rej)} rejected in the window · rejections are the model refusing to learn something the evidence did not support`);
  const rows = Object.entries(checks).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...rows.map((r) => r[1]));
  if (rows.length) body.append(el("div", { class: "hbars" }, ...rows.map(([k, v]) => el("div", { class: "hbar" }, el("span", { class: "lab", text: k }), el("div", { class: "trk" }, el("div", { class: "fill", style: `width:${((v / max) * 100).toFixed(1)}%` }), el("span", { class: "val" }, el("b", { text: num(v) }), " checks"))))));
  const rejs = w.rejections.filter((r) => Date.parse(r.at) >= since).slice(0, 12);
  if (rejs.length) {
    body.append(el("div", { class: "mini-title", style: "margin-top:14px" }, el("span", { text: "Recent rejections" })));
    body.append(el("div", { class: "list" }, ...rejs.map((r) => el("div", { class: "item" }, el("div", { class: "when", text: tShort(Date.parse(r.at)) }), el("div", { class: "what" }, el("div", { class: "hl", text: r.text }), el("div", { class: "meta" }, el("span", { class: "dim", text: r.headline }))), el("div", { class: "side" })))));
  } else if (!rows.length) body.append(el("div", { class: "emptymsg", text: "No proposals in this window yet." }));

  const cur = w.curiosity.filter((c) => Date.parse(c.at) >= since);
  const c = card("curiosity-card", "What the model asked on its own", `${num(cur.length)} curiosity-driven investigations in the window · ${num(cur.filter((x) => x.filled).length)} led to a trade`);
  if (cur.length === 0) c.body.append(el("div", { class: "emptymsg", text: "Nothing yet. The loop runs hourly and asks about contradictions, unexplained positions and stale facts." }));
  else c.body.append(el("div", { class: "list" }, ...cur.map((x) => el("div", { class: "item" }, el("div", { class: "when", text: tShort(Date.parse(x.at)) }), el("div", { class: "what" }, el("div", { class: "hl", text: x.headline }), el("div", { class: "meta" }, el("span", { class: cls("dec", x.filled && "filled") }, el("i", { class: "k" }), x.outcome, x.filled ? " · filled" : ""))), el("div", { class: "side", text: x.cost !== undefined ? usd2(x.cost) : "" })))));
}

// ---------- scores, theses, letters ----------
function renderScores(d) {
  const { body } = card("scores-card", "Outcome scores to date", "Every decision re-priced after 1 h, 1 d and 7 d");
  if (d.scores.length === 0) { body.append(el("div", { class: "emptymsg", text: "No scored horizons yet." })); return; }
  body.append(el("table", { class: "tbl" },
    el("thead", {}, el("tr", {}, el("th", { text: "" }), el("th", { text: "Horizon" }), el("th", { class: "num", text: "n" }), el("th", { class: "num", text: "Mean" }), el("th", { class: "num", text: "Right" }))),
    el("tbody", {}, ...d.scores.map((r) => el("tr", {},
      el("td", { class: "sym", text: r.group }), el("td", { text: r.horizon }), el("td", { class: "num", text: num(r.n) }),
      el("td", { class: cls("num", r.group === "trades" && (r.meanPct >= 0 ? "pos" : "neg")), text: pct(r.meanPct) }),
      el("td", { class: "num", text: `${r.rightPct.toFixed(0)}%` })))),
  ));
  body.append(el("p", { class: "note", text: "Trades: signed return in the trade's direction; Right = share on the right side. Holds: scored as the buy the agent declined; Right = share where that buy did not gain, so the hold was vindicated. Means are dominated by a few thin-book outliers." }));
}
function renderTheses(d) {
  const { body } = card("theses-card", "Standing theses", `${d.theses.length} held symbols · the latest rationale the agent recorded for each`);
  if (d.theses.length === 0) { body.append(el("div", { class: "emptymsg", text: "Nothing held." })); return; }
  for (const t of d.theses) body.append(el("details", { class: "th" },
    el("summary", {}, el("span", {}, el("span", { class: "sym", title: t.symbol, text: shortSym(t.symbol) }), el("span", { class: "dim", text: `  ${t.action} · conf ${t.confidence.toFixed(2)} · ${t.trigger}` })), el("span", { class: "dim", text: ago(Date.parse(t.at)) })),
    el("p", { class: "rat", text: t.rationale }),
  ));
}
function renderLetters(d) {
  const LO = d.ops.letter, code = LO && LO.supervisor ? LO.supervisor.lastExitCode : null;
  const runNote = code === null ? "" : code === 0 ? " · scheduled 08:00 run ok" : ` · scheduled 08:00 run FAILED (exit ${code})`;
  const { body } = card("letters-card", "Daily letters", d.letters.length ? `latest ${d.letters[0].day} · written ${ago(Date.parse(d.letters[0].mtimeIso))}${runNote}` : `none yet${runNote}`);
  if (d.letters.length === 0) { body.append(el("div", { class: "emptymsg", text: "No letters written yet." })); return; }
  const L = d.letters[0];
  if (L.watching) body.append(el("div", { class: "mini-title" }, el("span", { text: "What the latest letter is watching" })), el("p", { class: "quote", text: L.watching }));
  else if (L.opening) body.append(el("p", { class: "quote small", text: L.opening }));
  body.append(el("div", {}, ...d.letters.map((l) => el("div", { class: "letter" },
    el("span", {}, el("span", { class: "sym", text: l.day }), el("span", { class: "dim", text: `  ${tDayTime(Date.parse(l.mtimeIso))}` })),
    // The letter files live on the loopback server; a static copy has nowhere to link.
    SNAPSHOT ? null : el("span", { class: "links" },
      el("a", { href: `/reports/${l.files.md}`, target: "_blank", rel: "noopener", text: "md" }),
      l.files.pdf ? el("a", { href: `/reports/${l.files.pdf}`, target: "_blank", rel: "noopener", text: "pdf" }) : null,
      l.files.docx ? el("a", { href: `/reports/${l.files.docx}`, text: "docx" }) : null),
  ))));
}

// ---------- orders ----------
function orderRow(o) {
  const head = `${o.side} ${shortSym(o.symbol)} ${usd0(o.remainingUsd)}${o.limitPrice ? ` @ ${o.side === "buy" ? "≤" : "≥"}${price(o.limitPrice)}` : ""}`;
  const right = o.working
    ? (o.nextSliceInMs === null ? "slices when due" : o.nextSliceInMs <= 0 ? "slice due now" : `next slice in ${dur(o.nextSliceInMs)}`)
    : o.reason.replace(/_/g, " ");
  const kids = [
    el("span", {}, el("span", { class: "sym", title: o.symbol, text: head }), el("span", { class: "dim", text: o.working ? "  working exit" : `  conf ${o.confidence.toFixed(2)}` })),
    el("span", { class: "d", text: right }),
  ];
  if (o.working && o.progressPct !== null) kids.push(el("div", { class: "meter", role: "img", "aria-label": `${o.progressPct.toFixed(0)}% filled` }, el("i", { style: `width:${o.progressPct.toFixed(1)}%` })));
  kids.push(el("div", { class: "sub", text:
    (o.working ? `${usd0(o.filledUsd)} of ${usd0(o.requestedUsd)} filled · 25% of the visible book per slice · ` : "") +
    (o.expiresInMs <= 0 ? "expired — the next watch pass writes it off" : `expires ${tDayTime(o.expiresMs)} (in ${dur(o.expiresInMs)})`) }));
  return el("div", { class: "ord", title: o.rationale }, ...kids);
}
function renderOrders(d) {
  const { working, parked } = d.orders;
  const { body } = card("orders-card", "Orders", `${working.length} working exit${working.length === 1 ? "" : "s"} · ${parked.length} parked · the watcher retries every 5 min`);
  if (!working.length && !parked.length) { body.append(el("div", { class: "emptymsg", text: "Nothing parked, nothing working the book." })); return; }
  if (working.length) {
    body.append(el("div", { class: "mini-title" }, el("span", { text: "Working exits — a capped fill's remainder, one slice per hour" })));
    for (const o of working) body.append(orderRow(o));
  }
  if (parked.length) {
    body.append(el("div", { class: "mini-title", style: working.length ? "margin-top:10px" : "" }, el("span", { text: "Parked — venue closed or limit not met" })));
    for (const o of parked) body.append(orderRow(o));
  }
}

// ---------- operations ----------
const compactBytes = (b) => (b === null || b === undefined ? "?" : b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} kB`);
function armBlock(a) {
  const now = Date.now();
  const logAge = a.logMtimeIso ? now - Date.parse(a.logMtimeIso) : Infinity;
  const running = a.supervisor ? a.supervisor.state === "running" : logAge < 15 * 60000;
  const k = !running ? "crit" : logAge > 60 * 60000 ? "warn" : "good";
  const spendK = a.budgetUsd && a.spendTodayUsd >= a.budgetUsd ? "crit" : a.budgetUsd && a.spendTodayUsd >= a.budgetUsd * 0.8 ? "warn" : "";
  const frac = a.budgetUsd ? Math.min(100, (a.spendTodayUsd / a.budgetUsd) * 100) : 0;
  return el("div", { class: "blk" },
    el("div", { class: "row" }, el("span", {}, el("i", { class: cls("dotk", k) }), el("b", { text: a.label })), el("span", { text: a.supervisor ? `${a.supervisor.state}${a.supervisor.pid ? ` · pid ${a.supervisor.pid}` : ""}` : running ? "log alive" : "not under a supervisor" })),
    el("div", { class: "row" }, el("span", { text: "log written" }), el("span", { text: a.logMtimeIso ? ago(Date.parse(a.logMtimeIso)) : "no log on this machine" })),
    el("div", { class: "row" }, el("span", { text: "news queue" }), el("span", { text: a.queue ? `${num(a.queue.visible)} waiting · ${num(a.queue.inFlight)} in flight` : "unreadable" })),
    el("div", { class: "row" }, el("span", { text: "spend today (UTC)" }), el("span", {}, el("span", { text: `${usd2(a.spendTodayUsd)}${a.budgetUsd ? ` of ${usd0(a.budgetUsd)}` : ""} · ${a.investigationsToday} inv.` }), a.budgetUsd ? el("span", { class: cls("meter", spendK), role: "img", "aria-label": `${frac.toFixed(0)}% of budget` }, el("i", { style: `width:${frac.toFixed(1)}%` })) : null)),
    a.killSwitch ? el("div", { class: "row" }, el("span", { text: "kill switch" }), el("span", { class: "neg", text: "ON — halted" })) : null,
  );
}
function renderOps(d) {
  const sup = d.ops.supervisor === "none" ? "no supervisor" : d.ops.supervisor;
  const { body } = card("ops-card", "Operations", `workers, queues, spend, the letter and the printer — read from ${sup}, SQS, SSM, DynamoDB${d.ops.letter.printer ? " and CUPS" : ""}`);
  body.classList.add("ops");
  for (const a of d.ops.arms) body.append(armBlock(a));
  const L = d.ops.letter;
  const code = L.supervisor ? L.supervisor.lastExitCode : null;
  const lk = code === 0 ? "good" : code === null ? "" : "crit";
  const blk = el("div", { class: "blk" },
    el("div", { class: "row" }, el("span", {}, el("i", { class: cls("dotk", lk) }), el("b", { text: "Daily letter" })), el("span", { text: `scheduled ${L.scheduledLocal} local` })),
    el("div", { class: "row" }, el("span", { text: "last letter" }), el("span", { text: L.lastRun ? `${L.lastRun.day} · written ${ago(Date.parse(L.lastRun.generatedAt))}` : "no anchor row yet" })),
    L.lastRun ? el("div", { class: "row" }, el("span", { text: "next window starts" }), el("span", { text: tDayTime(Date.parse(L.lastRun.generatedAt)) })) : null,
    L.supervisor ? el("div", { class: "row" }, el("span", { text: "last scheduled run" }), el("span", { class: code === 0 ? "" : "neg", text: code === 0 ? `ok · ${L.supervisor.runs ?? "?"} runs` : code === null ? "unknown" : `exit ${code} — failed, see the log` })) : null,
  );
  const P = L.printer;
  if (P) {
    const empty = P.alerts.some((a) => /media-empty|media-needed/.test(a)), low = P.alerts.some((a) => /marker-supply-low|marker-supply-empty|toner-low/.test(a));
    const pk = empty ? "crit" : low || P.state !== "idle" ? "warn" : "good";
    blk.append(el("div", { class: "row" }, el("span", {}, el("i", { class: cls("dotk", pk) }), el("span", { text: "printer" })), el("span", { text: `${P.name.replace(/_+/g, " ").trim()} · ${P.state}${empty ? " · OUT OF PAPER" : ""}${low ? " · ink low" : ""}` })));
    if (L.lastJob) blk.append(el("div", { class: "row" }, el("span", { text: "last print job" }), el("span", { class: L.lastJob.failed ? "neg" : "", text: `${L.lastJob.submittedAt ?? L.lastJob.id} · ${L.lastJob.failed ? `FAILED (${L.lastJob.status || L.lastJob.alerts})` : "completed"}` })));
  }
  body.append(blk);
  const T = d.ops.tape;
  body.append(el("div", { class: "blk" }, el("div", { class: "row" }, el("span", {}, el("i", { class: cls("dotk", T ? "good" : "") }), el("b", { text: "Quote tape" })), el("span", { text: T ? `≈${num(T.itemCount ?? 0)} rows · ${compactBytes(T.sizeBytes)} · capturing since ${T.captureSince}` : "unreadable" }))));
}

// ---------- bench ----------
function renderBench(d) {
  const rows = d.bench;
  const { body } = card("bench-card", "Replay bench", rows.length ? `${rows.length} recent runs · same triaged events, as-of quotes, a simulated book per variant` : "no bench runs recorded");
  if (!rows.length) { body.append(el("div", { class: "emptymsg", text: "Run the replay bench to compare decision-layer variants on an archived week; summaries appear here." })); return; }
  body.append(el("div", { class: "tblwrap" }, el("table", { class: "tbl" },
    el("thead", {}, el("tr", {}, el("th", { text: "Run" }), el("th", { text: "Variant" }), el("th", { class: "num", text: "Days" }), el("th", { class: "num", text: "Seen → passed" }), el("th", { class: "num", text: "Buy / sell / hold" }), el("th", { class: "num", text: "Filled" }), el("th", { class: "num", text: "1 d · 7 d" }), el("th", { class: "num", text: "Cost" }))),
    el("tbody", {}, ...rows.map((r) => el("tr", { title: `${r.window ?? ""}${r.ranAt ? ` · ran ${tDayTime(Date.parse(r.ranAt))}` : ""}${r.unscoreable ? ` · ${r.unscoreable} unscoreable` : ""}` },
      el("td", { class: "sym", text: r.name }), el("td", { text: r.variant }), el("td", { class: "num", text: r.windowDays === null ? "—" : String(r.windowDays) }),
      el("td", { class: "num", text: `${num(r.eventsSeen)} → ${num(r.triagePassed)}${r.eventsSeen ? ` (${((r.triagePassed / r.eventsSeen) * 100).toFixed(0)}%)` : ""}` }),
      el("td", { class: "num", text: `${r.buys} / ${r.sells} / ${r.holds}` }),
      el("td", { class: cls("num", r.dropped && "neg"), text: `${num(r.filled)}${r.dropped ? ` (${num(r.dropped)} dropped)` : ""}` }),
      el("td", { class: "num", text: `${r.tradeMeanRet1d === null ? "—" : pct(r.tradeMeanRet1d * 100, 1)} · ${r.tradeMeanRet7d === null ? "—" : pct(r.tradeMeanRet7d * 100, 1)}` }),
      el("td", { class: "num", text: usd2(r.costUsd) })))))));
  body.append(el("p", { class: "note", text: "Seen → passed is Haiku's triage on the archived items; buy / sell / hold are the variant's decisions on those that passed; 1 d · 7 d are the mean signed returns of its trades against historical prices. Bench rows never touch the live book." }));
}

// ---------- lifecycle ----------
function render(d) {
  $("#empty").classList.add("hidden");
  $("#main").hidden = false;
  renderStatus(d);
  renderKpis(d);
  renderEquity(d);
  renderBook(d);
  renderOrders(d);
  renderOps(d);
  renderBench(d);
  renderFilters(d);
  renderActivity(d);
  renderWorld(d);
  renderScores(d);
  renderTheses(d);
  renderLetters(d);
  $("#footnote").textContent = `Paper trading only: no broker, no real money. Positions are marked at liquidation value (the bid). Times are local. Snapshot ${new Date(d.generatedAt).toLocaleString()} · the server re-reads every ${d.refreshSeconds} s while this page is open.`;
}
let timer = null;
function schedule(ms) { clearTimeout(timer); timer = setTimeout(load, ms); }
function renderSnapshot() {
  const d = SNAPSHOT.overview;
  state.generatedAt = d.generatedAt;
  state.data = d;
  render(d);
  const dataAt = new Date(d.generatedAt).toLocaleString();
  $("#updated").textContent = `static copy · data as of ${dataAt}`;
  $("#refresh").hidden = true;
  $("#download").hidden = true;
  $("#footnote").textContent = `Paper trading only: no broker, no real money. Positions are marked at liquidation value (the bid). Times are local. This is a static copy exported ${new Date(SNAPSHOT.exportedAt).toLocaleString()} with data as of ${dataAt}; nothing on it updates.`;
}
async function load({ force = false } = {}) {
  if (SNAPSHOT) return renderSnapshot();
  const btn = $("#refresh");
  try {
    if (force) { document.body.classList.add("refreshing"); btn.classList.add("spin"); await fetch("/api/refresh"); }
    const r = await fetch("/api/overview", { cache: "no-store" });
    const j = await r.json();
    if (!j.ok) { $("#updated").textContent = j.lastError ? `warming up · ${j.lastError}` : "warming up…"; schedule(3000); return; }
    const d = j.overview;
    if (d.generatedAt !== state.generatedAt) { state.generatedAt = d.generatedAt; state.data = d; render(d); }
    $("#updated").textContent = `data ${ago(Date.parse(d.generatedAt))}${j.refreshing ? " · refreshing…" : ""}`;
    schedule(20000);
  } catch (e) {
    $("#updated").textContent = "connection lost · retrying";
    schedule(5000);
  } finally {
    document.body.classList.remove("refreshing");
    btn.classList.remove("spin");
  }
}
setInterval(() => { if (state.data && !SNAPSHOT) $("#updated").textContent = `data ${ago(Date.parse(state.data.generatedAt))}`; }, 10000);
const root = document.documentElement;
const savedTheme = localStorage.getItem("fin.theme");
if (savedTheme) root.dataset.theme = savedTheme;
$("#theme").addEventListener("click", () => {
  const cur = root.dataset.theme;
  const next = cur === "dark" ? "light" : cur === "light" ? "" : "dark";
  if (next) { root.dataset.theme = next; localStorage.setItem("fin.theme", next); }
  else { delete root.dataset.theme; localStorage.removeItem("fin.theme"); }
});
$("#refresh").addEventListener("click", () => load({ force: true }));
load();
