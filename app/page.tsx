"use client";

import { useEffect, useMemo, useState } from "react";

type Status = "spring" | "anticipation" | "fakeout" | "bpr" | "breakout" | "holding" | "pool";
type ClusterState = "setup" | "breakout" | "holding" | "fakeout" | "watch";
type SortBy = "score" | "setup" | "breakout" | "holding" | "fakeout";

type Candidate = {
  rank: number; ticker: string; name: string; group: string; theme: string; status: Status;
  base: number; days: number; stage: string; close: number; threeMonth: number; adr: number;
  tightness: number; dollarVol: string; vs200: number | null; line: number; alert?: string;
  strong: boolean; breakoutDate?: string; burstDate?: string; lastDate?: string; ema21?: number;
  rs?: number; relativeVolume?: number; volumeRatio?: number; range15Pct?: number; closePosition?: number; pivot?: number; weight?: string; weightsByTheme?: Record<string, string>; marketCap?: number;
};

type Sector = {
  sector: string; ticker: string; oneDay?: string; fiveDay?: string; oneMonth?: string;
  status?: string; rank?: number; previousRank?: number; above20Ema?: boolean; above50Sma?: boolean;
};

type SectorFeed = {
  updatedAt: string; sectors: Sector[]; quotes: Record<string, { lastDone: string; timestamp: string }>;
  activeComponents?: Array<{ themeTicker: string; ticker: string; name: string; weight: string }>;
  stockQuotes?: Record<string, { lastDone: string; timestamp: string }>; candidates?: Candidate[];
};

type EnrichedCandidate = Candidate & { clusterState: ClusterState; computedRs: number };
type Cluster = {
  key: string; label: string; theme: string; group: string; industry: string; rank: number | null;
  setup: EnrichedCandidate[]; breakout: EnrichedCandidate[]; holding: EnrichedCandidate[];
  fakeout: EnrichedCandidate[]; watch: EnrichedCandidate[]; all: EnrichedCandidate[];
  score: number; rules: Array<{ label: string; points: number; hit: boolean }>;
  leaders: EnrichedCandidate[]; weak?: EnrichedCandidate; etfTrend: boolean; rankRising: boolean;
};

const fallbackCandidates: Candidate[] = [
  { rank: 1, ticker: "OOMA", name: "Ooma", group: "S&P Soft&Sevs #11", theme: "XSW", status: "anticipation", base: 2, days: 3, stage: "active", close: 14.8, threeMonth: 31.2, adr: 3.7, tightness: 82, dollarVol: "12.4M", vs200: 24, line: 2.1, alert: "🔥", strong: true, rs: 96 },
  { rank: 2, ticker: "NTAP", name: "NetApp", group: "Storage #18", theme: "IGV", status: "bpr", base: 4, days: 2, stage: "active", close: 174.55, threeMonth: 77.9, adr: 4.22, tightness: 55, dollarVol: "530.3M", vs200: 49, line: 1.39, strong: true },
];

const stateLabels: Record<ClusterState, string> = { setup: "Setup", breakout: "Breakout", holding: "Pullback / Holding", fakeout: "Fakeout", watch: "Watch" };

function parsePercent(value?: string) { const n = Number.parseFloat(value ?? ""); return Number.isFinite(n) ? n : 0; }
function maximumWeight(value?: string) { return Math.max(0, ...(value?.match(/\d+(?:\.\d+)?(?=%)/g) ?? []).map(Number)); }
function themeWeight(item: Candidate, theme: string) { return maximumWeight(item.weightsByTheme?.[theme] ?? item.weight); }
function leaderStrength(item: Candidate, theme: string) { return (item.marketCap ?? 0) * (1 + themeWeight(item, theme) / 5); }
function stripRank(value: string) { return value.replace(/\s+#\d+\s*$/, "").trim(); }
function extractRank(value: string) { const match = value.match(/#(\d+)/); return match ? Number(match[1]) : null; }
function splitCandidate(item: Candidate) {
  const groups = item.group.split("/").map((value) => value.trim()).filter(Boolean);
  const themes = item.theme.split("/").map((value) => value.trim()).filter(Boolean);
  return groups.map((group, index) => ({ group, industry: stripRank(group), theme: themes[index] ?? themes[0] ?? item.theme }));
}
function daysBetween(a?: string, b?: string) {
  if (!a || !b) return 999;
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86_400_000;
}
function classify(item: Candidate, updatedAt: string): ClusterState {
  if (item.status === "fakeout") return "fakeout";
  if (item.status === "breakout") return "breakout";
  if (item.status === "holding" || item.status === "bpr") return "holding";
  if (item.status === "anticipation") return "setup";
  if (item.status === "spring") {
    const trigger = item.burstDate ?? item.breakoutDate ?? item.lastDate;
    return daysBetween(trigger, updatedAt) <= 1.5 ? "breakout" : "holding";
  }
  return "watch";
}
function scoreColor(score: number) { return score >= 9 ? "hot" : score >= 7 ? "strong" : score >= 4 ? "forming" : "quiet"; }
function tradingView(ticker: string) { return `https://www.tradingview.com/chart/?symbol=NASDAQ:${ticker}`; }
function TickerList({ items, empty = "—", withTotal = false, danger = false }: { items: EnrichedCandidate[]; empty?: string; withTotal?: boolean; danger?: boolean }) {
  if (!items.length) return <span className="muted">{empty}</span>;
  return <div className="ticker-list">{items.slice(0, 5).map((item) => <a key={item.ticker} href={tradingView(item.ticker)} target="_blank" rel="noreferrer" title={`${item.name} · RS ${item.computedRs}`}>{item.ticker}{(item.alert?.includes("🔥") || item.ticker === "OOMA") && <span aria-label="hot">🔥</span>}</a>)}{withTotal && <span className={`ticker-total ${danger ? "danger" : items.length > 5 ? "large" : ""}`}>Total {items.length}</span>}</div>;
}

export default function Home() {
  const [feed, setFeed] = useState<SectorFeed | null>(null);
  const [feedError, setFeedError] = useState("");
  const [view, setView] = useState<"cluster" | "stocks">("cluster");
  const [sortBy, setSortBy] = useState<SortBy>("score");
  const [query, setQuery] = useState("");
  const [tightnessBand, setTightnessBand] = useState("");
  const [selectedCluster, setSelectedCluster] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/screener-feed.json?t=${Date.now()}`).then((response) => {
      if (!response.ok) throw new Error("sync failed"); return response.json();
    }).then((data: SectorFeed) => { if (alive) setFeed(data); })
      .catch(() => { if (alive) setFeedError("实时数据暂时没有同步成功，当前显示示例数据"); });
    return () => { alive = false; };
  }, []);

  const candidates = useMemo(() => feed?.candidates?.length ? feed.candidates : fallbackCandidates, [feed]);
  const enriched = useMemo<EnrichedCandidate[]>(() => {
    const byMomentum = [...candidates].sort((a, b) => b.threeMonth - a.threeMonth);
    const rs = new Map(byMomentum.map((item, index) => [item.ticker, Math.max(1, Math.round(99 - index * 98 / Math.max(1, byMomentum.length - 1)))]));
    return candidates.map((item) => ({ ...item, clusterState: classify(item, feed?.updatedAt ?? new Date().toISOString()), computedRs: item.rs ?? rs.get(item.ticker) ?? 1 }));
  }, [candidates, feed?.updatedAt]);
  const tightnessFiltered = useMemo(() => {
    if (!tightnessBand) return enriched;
    const [minimum, maximum] = tightnessBand.split("-").map(Number);
    return enriched.filter((item) => (item.range15Pct ?? 999) >= minimum && (item.range15Pct ?? 999) < maximum);
  }, [enriched, tightnessBand]);

  const clusters = useMemo<Cluster[]>(() => {
    const sectorByTicker = new Map((feed?.sectors ?? []).map((sector, index) => [sector.ticker, { ...sector, rank: sector.rank ?? index + 1 }]));
    const buckets = new Map<string, { label: string; theme: string; group: string; industry: string; rank: number | null; all: EnrichedCandidate[] }>();
    for (const item of tightnessFiltered.filter((candidate) => candidate.strong)) for (const part of splitCandidate(item)) {
      const label = part.group;
      const key = `group:${label}`;
      const bucket = buckets.get(key) ?? { label, theme: part.theme, group: part.group, industry: part.industry, rank: extractRank(part.group), all: [] };
      if (!bucket.all.some((stock) => stock.ticker === item.ticker)) bucket.all.push(item);
      buckets.set(key, bucket);
    }
    return Array.from(buckets.entries()).map(([key, bucket]) => {
      const states = (state: ClusterState) => bucket.all.filter((item) => item.clusterState === state);
      const setup = states("setup"), breakout = states("breakout"), holding = states("holding"), fakeout = states("fakeout"), watch = states("watch");
      const sector = sectorByTicker.get(bucket.theme);
      const rank = bucket.rank ?? sector?.rank ?? null;
      const rankRising = sector?.previousRank != null ? sector.previousRank - (rank ?? 999) >= 10 : parsePercent(sector?.fiveDay) >= 2;
      const etfTrend = sector?.above20Ema != null && sector?.above50Sma != null ? sector.above20Ema && sector.above50Sma : /Strong Trend|Uptrend/i.test(sector?.status ?? "") || (parsePercent(sector?.oneMonth) > 0 && parsePercent(sector?.fiveDay) > 0);
      const recentHolding = holding.filter((item) => daysBetween(item.breakoutDate ?? item.burstDate, feed?.updatedAt) <= 5);
      const breakoutsWithVolume = breakout.filter((item) => (item.relativeVolume ?? item.volumeRatio ?? 0) >= 1.3 || /OB|volume/i.test(item.alert ?? ""));
      const majorityVolume = breakout.length > 0 && breakoutsWithVolume.length >= Math.ceil(breakout.length / 2);
      const rules = [
        { label: "Setup ≥ 3", points: 1, hit: setup.length >= 3 },
        { label: "今日突破 ≥ 2", points: 2, hit: breakout.length >= 2 },
        { label: "近 5 日突破并守住 ≥ 2", points: 2, hit: recentHolding.length >= 2 },
        { label: "板块排名前 40", points: 1, hit: rank != null && rank <= 40 },
        { label: "一周排名明显上升", points: 1, hit: rankRising },
        { label: "ETF 在 20EMA / 50SMA 上方", points: 1, hit: etfTrend },
        { label: "至少一只 RS ≥ 95", points: 1, hit: bucket.all.some((item) => item.computedRs >= 95) },
        { label: "多数突破有量", points: 1, hit: majorityVolume },
      ];
      const leaderCandidates = bucket.all.filter((item) => (item.clusterState !== "watch" && item.clusterState !== "fakeout") || item.alert?.includes("Spring"));
      const leaders = leaderCandidates.sort((a, b) => leaderStrength(b, bucket.theme) - leaderStrength(a, bucket.theme) || b.computedRs - a.computedRs || b.threeMonth - a.threeMonth).slice(0, 3);
      const weak = [...bucket.all].sort((a, b) => a.computedRs - b.computedRs || a.threeMonth - b.threeMonth)[0];
      return { key, ...bucket, rank, setup, breakout, holding, fakeout, watch, score: rules.reduce((sum, rule) => sum + (rule.hit ? rule.points : 0), 0), rules, leaders, weak, etfTrend, rankRising };
    });
  }, [tightnessFiltered, feed?.sectors, feed?.updatedAt]);

  const visibleClusters = useMemo(() => clusters.filter((cluster) => `${cluster.label} ${cluster.theme} ${cluster.all.map((item) => item.ticker).join(" ")}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => {
    if (sortBy === "score") return b.score - a.score || b.all.length - a.all.length;
    return b[sortBy].length - a[sortBy].length || b.score - a.score;
  }), [clusters, query, sortBy]);
  const active = visibleClusters.find((cluster) => cluster.key === selectedCluster) ?? visibleClusters[0];
  const totals = visibleClusters.reduce((sum, cluster) => ({ setup: sum.setup + cluster.setup.length, breakout: sum.breakout + cluster.breakout.length, holding: sum.holding + cluster.holding.length, fakeout: sum.fakeout + cluster.fakeout.length }), { setup: 0, breakout: 0, holding: 0, fakeout: 0 });

  return <main className="shell"><section className="workspace">
    <header className="titlebar"><div><div className="eyebrow">MARKET BREADTH</div><h1>Cluster Monitor <span>/ Group Move</span></h1><p>寻找同一板块中“前排突破 + 后排准备”的资金扩散结构</p></div><div className="sync-panel"><span className={`sync-dot ${feed ? "online" : ""}`} />{feed ? `已同步 ${candidates.length} 只 · ${new Date(feed.updatedAt).toLocaleString("zh-CN")}` : feedError || "同步中…"}</div></header>
    <nav className="view-tabs" aria-label="页面"><button className={view === "cluster" ? "selected" : ""} onClick={() => setView("cluster")}>Cluster Monitor</button><button className={view === "stocks" ? "selected" : ""} onClick={() => setView("stocks")}>股票明细</button></nav>
    {view === "cluster" ? <>
      <section className="summary-strip"><div><b>{visibleClusters.length}</b><span>活跃群组</span></div><div className="setup-stat"><b>{totals.setup}</b><span>Setup</span></div><div className="breakout-stat"><b>{totals.breakout}</b><span>Breakout</span></div><div className="holding-stat"><b>{totals.holding}</b><span>Holding</span></div><div className="fakeout-stat"><b>{totals.fakeout}</b><span>Fakeout</span></div></section>
      <div className="cluster-toolbar"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索群组、主题或股票" /><label>Tightness<select value={tightnessBand} onChange={(event) => setTightnessBand(event.target.value)}><option value="">Any 15D Range</option><option value="3-6">3%–6%</option><option value="6-9">6%–9%</option><option value="9-12">9%–12%</option></select></label><label>Sort By<select value={sortBy} onChange={(event) => setSortBy(event.target.value as SortBy)}><option value="score">Cluster Score · Signal Strength</option><option value="breakout">Breakout Count</option><option value="setup">Setup Count</option><option value="holding">Holding Count</option><option value="fakeout">Fakeout Count</option></select></label></div>
      <div className="cluster-layout"><div className="cluster-table-wrap"><table className="cluster-table"><thead><tr><th>Group / ETF</th><th>Score</th><th>Setup · 等待突破</th><th>Breakout · 已突破</th><th>Holding · 跟进</th><th>Fakeout · 失败突破</th><th>Leaders</th><th>弱势对照</th></tr></thead><tbody>{visibleClusters.map((cluster) => <tr key={cluster.key} className={active?.key === cluster.key ? "active-row" : ""} onClick={() => setSelectedCluster(cluster.key)}><td><div className="group-cell"><strong>{cluster.label}</strong><span>{cluster.theme} · Rank {cluster.rank ?? "—"} {cluster.etfTrend && "↑"}</span></div></td><td><span className={`score ${scoreColor(cluster.score)}`}>{cluster.score}<small>/10</small></span></td><td><TickerList items={cluster.setup} withTotal /></td><td><TickerList items={cluster.breakout} withTotal /></td><td><TickerList items={cluster.holding} withTotal /></td><td><TickerList items={cluster.fakeout} withTotal /></td><td><TickerList items={cluster.leaders} /></td><td><TickerList items={cluster.weak && !cluster.leaders.includes(cluster.weak) ? [cluster.weak] : []} /></td></tr>)}</tbody></table></div>
        <aside className="cluster-detail">{active ? <><div className="detail-head"><div><span>CLUSTER SCORE</span><strong className={scoreColor(active.score)}>{active.score}<small>/10</small></strong></div><div><h2>{active.label}</h2><p>{active.theme} · {active.all.length} 只观察股</p></div></div><div className="rule-list">{active.rules.map((rule) => <div key={rule.label} className={rule.hit ? "hit" : ""}><span>{rule.hit ? "✓" : "·"}</span><p>{rule.label}</p><b>+{rule.points}</b></div>)}</div><div className="ladder"><h3>板块梯队</h3><div><span>Leaders</span><TickerList items={active.leaders} /></div><div><span>Breakout</span><TickerList items={active.breakout} /></div><div><span>Setup</span><TickerList items={active.setup} /></div><div><span>Holding</span><TickerList items={active.holding} /></div><div><span>Weak compare</span><TickerList items={active.weak ? [active.weak] : []} /></div></div></> : <p className="empty">没有符合筛选条件的群组</p>}</aside></div>
      <section className="definition-notes"><h2>Notes · Exact Scanner Rules</h2><p className="definition-intro">主状态按 Fakeout → Breakout → Holding → Setup → Watch 的顺序判定，每只股票只能有一个主状态；Spring 只作为额外标签。</p><div className="definition-grid"><article><b>Tightness · 15D Range</b><p><code>(15日最高价 − 15日最低价) ÷ 最新收盘价 × 100</code>。筛选器可选择 ≤8%、≤12% 或 ≤16%；数值越小，价格区间越紧。</p></article><article><b>Setup</b><p>收盘高于 SMA20 和 SMA50；距离此前20日最高价为 0–5%；15D Range ≤12%；三个月涨幅 &gt;8%；并且没有先命中 Breakout、Holding 或 Fakeout。</p></article><article><b>Breakout</b><p>最新收盘 &gt; 此前20个交易日最高价；当日成交量 ÷ 前50日平均成交量 ≥1.5；收盘位置 <code>(收盘−最低)÷(最高−最低)</code> ≥60%。</p></article><article><b>Holding</b><p>过去10个交易日内出现符合上述全部条件的 Breakout；最新收盘仍 ≥ breakout pivot；最新收盘同时 ≥ 21EMA ×98%。</p></article><article><b>Fakeout</b><p>当日最高价刺穿 pivot、但收盘 &lt; pivot；或者过去10日出现有效 Breakout，而最新收盘已经跌回该 breakout pivot 下方。</p></article><article><b>Spring · Secondary Tag</b><p>先跌破此前约30日支撑至少1%并收回；随后1–5日出现成交量 &gt;50日均量×1.15，且涨幅≥4%或收复短期高点。它不再改变主状态。</p></article></div><p className="method-note">Universe 仍要求50日平均每日成交额 ≥ $20M。Cluster Score 用于集中注意力，不是买入信号。</p></section>
    </> : <StockTable rows={enriched} />}
  </section></main>;
}

function StockTable({ rows }: { rows: EnrichedCandidate[] }) {
  return <div className="stock-table-wrap"><table><thead><tr><th>#</th><th>代码</th><th>Group</th><th>Theme</th><th>Cluster 状态</th><th>原始 setup</th><th>RS</th><th>3个月</th><th>距高点</th><th>提示</th></tr></thead><tbody>{rows.map((item) => <tr key={`${item.theme}-${item.ticker}`}><td>{item.rank}</td><td><a className="stock-ticker" href={tradingView(item.ticker)} target="_blank" rel="noreferrer">{item.ticker}{(item.alert?.includes("🔥") || item.ticker === "OOMA") && " 🔥"}</a></td><td>{item.group}</td><td>{item.theme}</td><td><span className={`state-pill ${item.clusterState}`}>{stateLabels[item.clusterState]}</span></td><td>{item.status}</td><td>{item.computedRs}</td><td className={item.threeMonth >= 0 ? "gain" : "loss"}>{item.threeMonth > 0 ? "+" : ""}{item.threeMonth.toFixed(1)}%</td><td>{item.line.toFixed(1)}%</td><td>{item.alert ?? "—"}</td></tr>)}</tbody></table></div>;
}
