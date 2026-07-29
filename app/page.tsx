"use client";

import { useEffect, useMemo, useState } from "react";

type Status = "spring" | "anticipation" | "fakeout" | "bpr" | "pool";
type ClusterState = "setup" | "breakout" | "holding" | "fakeout" | "watch";
type GroupBy = "group" | "industry" | "theme";
type SortBy = "score" | "setup" | "breakout" | "holding" | "fakeout" | "rank";

type Candidate = {
  rank: number; ticker: string; name: string; group: string; theme: string; status: Status;
  base: number; days: number; stage: string; close: number; threeMonth: number; adr: number;
  tightness: number; dollarVol: string; vs200: number | null; line: number; alert?: string;
  strong: boolean; breakoutDate?: string; burstDate?: string; lastDate?: string; ema21?: number;
  rs?: number; relativeVolume?: number; volumeRatio?: number;
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
  leader?: EnrichedCandidate; weak?: EnrichedCandidate; etfTrend: boolean; rankRising: boolean;
};

const fallbackCandidates: Candidate[] = [
  { rank: 1, ticker: "OOMA", name: "Ooma", group: "S&P Soft&Sevs #11", theme: "XSW", status: "anticipation", base: 2, days: 3, stage: "active", close: 14.8, threeMonth: 31.2, adr: 3.7, tightness: 82, dollarVol: "12.4M", vs200: 24, line: 2.1, alert: "🔥", strong: true, rs: 96 },
  { rank: 2, ticker: "NTAP", name: "NetApp", group: "Storage #18", theme: "IGV", status: "bpr", base: 4, days: 2, stage: "active", close: 174.55, threeMonth: 77.9, adr: 4.22, tightness: 55, dollarVol: "530.3M", vs200: 49, line: 1.39, strong: true },
];

const stateLabels: Record<ClusterState, string> = { setup: "Setup", breakout: "Breakout", holding: "Pullback / Holding", fakeout: "Fakeout", watch: "Watch" };

function parsePercent(value?: string) { const n = Number.parseFloat(value ?? ""); return Number.isFinite(n) ? n : 0; }
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
  if (item.status === "bpr") return "holding";
  if (item.status === "anticipation") return "setup";
  if (item.status === "spring") {
    const trigger = item.burstDate ?? item.breakoutDate ?? item.lastDate;
    return daysBetween(trigger, updatedAt) <= 1.5 ? "breakout" : "holding";
  }
  return "watch";
}
function scoreColor(score: number) { return score >= 9 ? "hot" : score >= 7 ? "strong" : score >= 4 ? "forming" : "quiet"; }
function tradingView(ticker: string) { return `https://www.tradingview.com/chart/?symbol=NASDAQ:${ticker}`; }
function TickerList({ items, empty = "—" }: { items: EnrichedCandidate[]; empty?: string }) {
  if (!items.length) return <span className="muted">{empty}</span>;
  return <div className="ticker-list">{items.slice(0, 5).map((item) => <a key={item.ticker} href={tradingView(item.ticker)} target="_blank" rel="noreferrer" title={`${item.name} · RS ${item.computedRs}`}>{item.ticker}{(item.alert?.includes("🔥") || item.ticker === "OOMA") && <span aria-label="hot">🔥</span>}</a>)}</div>;
}

export default function Home() {
  const [feed, setFeed] = useState<SectorFeed | null>(null);
  const [feedError, setFeedError] = useState("");
  const [view, setView] = useState<"cluster" | "stocks">("cluster");
  const [groupBy, setGroupBy] = useState<GroupBy>("group");
  const [sortBy, setSortBy] = useState<SortBy>("score");
  const [query, setQuery] = useState("");
  const [minScore, setMinScore] = useState(0);
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

  const clusters = useMemo<Cluster[]>(() => {
    const sectorByTicker = new Map((feed?.sectors ?? []).map((sector, index) => [sector.ticker, { ...sector, rank: sector.rank ?? index + 1 }]));
    const buckets = new Map<string, { label: string; theme: string; group: string; industry: string; rank: number | null; all: EnrichedCandidate[] }>();
    for (const item of enriched) for (const part of splitCandidate(item)) {
      const label = groupBy === "theme" ? part.theme : groupBy === "industry" ? part.industry : part.group;
      const key = `${groupBy}:${label}`;
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
      const ordered = [...bucket.all].sort((a, b) => b.computedRs - a.computedRs || b.threeMonth - a.threeMonth);
      return { key, ...bucket, rank, setup, breakout, holding, fakeout, watch, score: rules.reduce((sum, rule) => sum + (rule.hit ? rule.points : 0), 0), rules, leader: ordered[0], weak: ordered.at(-1), etfTrend, rankRising };
    });
  }, [enriched, feed?.sectors, feed?.updatedAt, groupBy]);

  const visibleClusters = useMemo(() => clusters.filter((cluster) => cluster.score >= minScore && `${cluster.label} ${cluster.theme} ${cluster.all.map((item) => item.ticker).join(" ")}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => {
    if (sortBy === "rank") return (a.rank ?? 999) - (b.rank ?? 999);
    if (sortBy === "score") return b.score - a.score || b.all.length - a.all.length;
    return b[sortBy].length - a[sortBy].length || b.score - a.score;
  }), [clusters, minScore, query, sortBy]);
  const active = visibleClusters.find((cluster) => cluster.key === selectedCluster) ?? visibleClusters[0];
  const totals = visibleClusters.reduce((sum, cluster) => ({ setup: sum.setup + cluster.setup.length, breakout: sum.breakout + cluster.breakout.length, holding: sum.holding + cluster.holding.length, fakeout: sum.fakeout + cluster.fakeout.length }), { setup: 0, breakout: 0, holding: 0, fakeout: 0 });

  return <main className="shell"><section className="workspace">
    <header className="titlebar"><div><div className="eyebrow">MARKET BREADTH</div><h1>Cluster Monitor <span>/ Group Move</span></h1><p>寻找同一板块中“前排突破 + 后排准备”的资金扩散结构</p></div><div className="sync-panel"><span className={`sync-dot ${feed ? "online" : ""}`} />{feed ? `已同步 ${candidates.length} 只 · ${new Date(feed.updatedAt).toLocaleString("zh-CN")}` : feedError || "同步中…"}</div></header>
    <nav className="view-tabs" aria-label="页面"><button className={view === "cluster" ? "selected" : ""} onClick={() => setView("cluster")}>Cluster Monitor</button><button className={view === "stocks" ? "selected" : ""} onClick={() => setView("stocks")}>股票明细</button></nav>
    {view === "cluster" ? <>
      <section className="summary-strip"><div><b>{visibleClusters.length}</b><span>活跃群组</span></div><div className="setup-stat"><b>{totals.setup}</b><span>Setup</span></div><div className="breakout-stat"><b>{totals.breakout}</b><span>Breakout</span></div><div className="holding-stat"><b>{totals.holding}</b><span>Holding</span></div><div className="fakeout-stat"><b>{totals.fakeout}</b><span>Fakeout</span></div></section>
      <div className="cluster-toolbar"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索群组、主题或股票" /><label title="Choose how stocks are combined into rows">Group By<select value={groupBy} onChange={(event) => setGroupBy(event.target.value as GroupBy)}><option value="group">Group (ranked group)</option><option value="industry">Industry (business)</option><option value="theme">Theme (ETF)</option></select></label><label title="Choose what appears first in the table">Sort By<select value={sortBy} onChange={(event) => setSortBy(event.target.value as SortBy)}><option value="score">Cluster Score (highest)</option><option value="breakout">Breakout Count</option><option value="setup">Setup Count</option><option value="holding">Holding Count</option><option value="fakeout">Fakeout Count</option><option value="rank">Group Rank (best)</option></select></label><label>Min Score<select value={minScore} onChange={(event) => setMinScore(Number(event.target.value))}>{[0,4,7,9].map((value) => <option key={value} value={value}>{value}+</option>)}</select></label></div>
      <div className="cluster-layout"><div className="cluster-table-wrap"><table className="cluster-table"><thead><tr><th>群组 / ETF</th><th>Score</th><th>Setup</th><th>Breakout</th><th>Holding</th><th>Fakeout</th><th>Leader</th><th>已突破</th><th>等待突破</th><th>弱势对照</th></tr></thead><tbody>{visibleClusters.map((cluster) => <tr key={cluster.key} className={active?.key === cluster.key ? "active-row" : ""} onClick={() => setSelectedCluster(cluster.key)}><td><div className="group-cell"><strong>{cluster.label}</strong><span>{cluster.theme} · Rank {cluster.rank ?? "—"} {cluster.etfTrend && "↑"}</span></div></td><td><span className={`score ${scoreColor(cluster.score)}`}>{cluster.score}<small>/10</small></span></td><td><span className="count-pill setup-count">{cluster.setup.length}</span></td><td><span className="count-pill breakout-count">{cluster.breakout.length}</span></td><td><span className="count-pill holding-count">{cluster.holding.length}</span></td><td><span className="count-pill fakeout-count">{cluster.fakeout.length}</span></td><td><TickerList items={cluster.leader ? [cluster.leader] : []} /></td><td><TickerList items={cluster.breakout} /></td><td><TickerList items={cluster.setup} /></td><td><TickerList items={cluster.weak && cluster.weak !== cluster.leader ? [cluster.weak] : []} /></td></tr>)}</tbody></table></div>
        <aside className="cluster-detail">{active ? <><div className="detail-head"><div><span>CLUSTER SCORE</span><strong className={scoreColor(active.score)}>{active.score}<small>/10</small></strong></div><div><h2>{active.label}</h2><p>{active.theme} · {active.all.length} 只观察股</p></div></div><div className="rule-list">{active.rules.map((rule) => <div key={rule.label} className={rule.hit ? "hit" : ""}><span>{rule.hit ? "✓" : "·"}</span><p>{rule.label}</p><b>+{rule.points}</b></div>)}</div><div className="ladder"><h3>板块梯队</h3><div><span>Leader</span><TickerList items={active.leader ? [active.leader] : []} /></div><div><span>Breakout</span><TickerList items={active.breakout} /></div><div><span>Setup</span><TickerList items={active.setup} /></div><div><span>Holding</span><TickerList items={active.holding} /></div><div><span>Weak compare</span><TickerList items={active.weak ? [active.weak] : []} /></div></div></> : <p className="empty">没有符合筛选条件的群组</p>}</aside></div>
      <p className="method-note">分数用于集中注意力，不是买入信号。若数据源暂未提供 RS、排名历史、均线或 RVOL，页面会使用当前动量、周表现及趋势标签作兼容估算；字段同步后会自动采用精确值。</p>
    </> : <StockTable rows={enriched} />}
  </section></main>;
}

function StockTable({ rows }: { rows: EnrichedCandidate[] }) {
  return <div className="stock-table-wrap"><table><thead><tr><th>#</th><th>代码</th><th>Group</th><th>Theme</th><th>Cluster 状态</th><th>原始 setup</th><th>RS</th><th>3个月</th><th>距高点</th><th>提示</th></tr></thead><tbody>{rows.map((item) => <tr key={`${item.theme}-${item.ticker}`}><td>{item.rank}</td><td><a className="stock-ticker" href={tradingView(item.ticker)} target="_blank" rel="noreferrer">{item.ticker}{(item.alert?.includes("🔥") || item.ticker === "OOMA") && " 🔥"}</a></td><td>{item.group}</td><td>{item.theme}</td><td><span className={`state-pill ${item.clusterState}`}>{stateLabels[item.clusterState]}</span></td><td>{item.status}</td><td>{item.computedRs}</td><td className={item.threeMonth >= 0 ? "gain" : "loss"}>{item.threeMonth > 0 ? "+" : ""}{item.threeMonth.toFixed(1)}%</td><td>{item.line.toFixed(1)}%</td><td>{item.alert ?? "—"}</td></tr>)}</tbody></table></div>;
}
