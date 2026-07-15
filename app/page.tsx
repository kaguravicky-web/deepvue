"use client";

import { useEffect, useMemo, useState } from "react";

type Status = "spring" | "anticipation" | "fakeout" | "bpr" | "pool";

type Candidate = {
  rank: number;
  ticker: string;
  name: string;
  group: string;
  theme: string;
  status: Status;
  base: number;
  days: number;
  stage: string;
  close: number;
  threeMonth: number;
  adr: number;
  tightness: number;
  dollarVol: string;
  vs200: number | null;
  line: number;
  alert?: string;
  strong: boolean;
};

type SectorFeed = {
  updatedAt: string;
  sectors: Array<{ sector: string; ticker: string }>;
  quotes: Record<string, { lastDone: string; timestamp: string }>;
  activeComponents?: Array<{ themeTicker: string; ticker: string; name: string; weight: string }>;
  stockQuotes?: Record<string, { lastDone: string; timestamp: string }>;
  candidates?: Candidate[];
};

const fallbackCandidates: Candidate[] = [
  { rank: 1, ticker: "NTAP", name: "NetApp", group: "Storage", theme: "IGV", status: "bpr", base: 4, days: 2, stage: "active", close: 174.55, threeMonth: 77.9, adr: 4.22, tightness: 55, dollarVol: "530.3M", vs200: 49, line: 1.39, strong: true },
  { rank: 2, ticker: "BB", name: "BlackBerry", group: "Software", theme: "IGV", status: "bpr", base: 5, days: 8, stage: "active", close: 11.01, threeMonth: 184.5, adr: 7.98, tightness: 0, dollarVol: "339.1M", vs200: 109, line: 23.43, strong: true },
];

const setupOptions: Status[] = ["spring", "fakeout", "bpr", "anticipation", "pool"];
const baseOptions = [2, 3, 4, 5];
const setupLabels: Record<Status, string> = {
  spring: "spring",
  fakeout: "fakeout",
  anticipation: "anticipation",
  bpr: "bpr",
  pool: "watch",
};

function toggleValue<T>(values: T[], value: T) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function StatusPill({ status }: { status: Status }) {
  return <span className={`pill ${status}`}>{setupLabels[status]}</span>;
}

function BaseBadge({ value }: { value: number }) {
  return <span className={`base base-${value}`}>{value}</span>;
}

function formatPercent(value: number, signed = false) {
  if (!value) return "-";
  const prefix = signed && value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(1)}%`;
}

function parseDollarVolume(value: string) {
  const match = value.match(/^([\d.]+)([KMB])$/i);
  if (!match) return 0;
  const amount = Number(match[1]);
  const unit = match[2].toUpperCase();
  if (unit === "B") return amount * 1_000_000_000;
  if (unit === "M") return amount * 1_000_000;
  return amount * 1_000;
}

function rowKey(item: Candidate) {
  return `${item.theme}-${item.ticker}-${item.rank}`;
}

export default function Home() {
  const [query, setQuery] = useState("");
  const [selectedSetups, setSelectedSetups] = useState<Status[]>([]);
  const [selectedThemes, setSelectedThemes] = useState<string[]>([]);
  const [selectedBases, setSelectedBases] = useState<number[]>([]);
  const [strongOnly, setStrongOnly] = useState(true);
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const [feed, setFeed] = useState<SectorFeed | null>(null);
  const [feedError, setFeedError] = useState("");

  useEffect(() => {
    let alive = true;
    fetch(`/screener-feed.json?t=${Date.now()}`)
      .then((response) => {
        if (!response.ok) throw new Error("sync failed");
        return response.json();
      })
      .then((data: SectorFeed) => {
        if (alive) setFeed(data);
      })
      .catch(() => {
        if (alive) setFeedError("Google Sheet 或 LB 暂时没有同步成功");
      });
    return () => {
      alive = false;
    };
  }, []);

  const candidateRows = useMemo(() => {
    if (feed?.candidates?.length) return feed.candidates;
    if (!feed?.activeComponents?.length) return fallbackCandidates;

    const sectorByTheme = new Map(feed.sectors.map((sector) => [sector.ticker, sector.sector]));
    return feed.activeComponents.map((component, index): Candidate => {
      const quote = feed.stockQuotes?.[component.ticker];
      return {
        rank: index + 1,
        ticker: component.ticker,
        name: component.name || component.ticker,
        group: sectorByTheme.get(component.themeTicker) ?? component.themeTicker,
        theme: component.themeTicker,
        status: "pool",
        base: 0,
        days: 0,
        stage: "watch",
        close: Number(quote?.lastDone ?? 0),
        threeMonth: 0,
        adr: 0,
        tightness: 0,
        dollarVol: component.weight || "-",
        vs200: null,
        line: 0,
        strong: true,
      };
    });
  }, [feed]);

  const themeOptions = useMemo(
    () => Array.from(new Set(candidateRows.flatMap((item) => item.theme.split("/")))).sort(),
    [candidateRows],
  );

  const liquidityByRow = useMemo(() => {
    const ranked = candidateRows
      .map((item) => ({ key: rowKey(item), value: parseDollarVolume(item.dollarVol) }))
      .filter((item) => item.value > 0)
      .sort((a, b) => b.value - a.value);
    return new Map(ranked.map((item, index) => {
      const percentile = ranked.length <= 1 ? 100 : Math.round((1 - (index / (ranked.length - 1))) * 100);
      return [item.key, { rank: index + 1, percentile, total: ranked.length }];
    }));
  }, [candidateRows]);

  const visible = candidateRows.filter((item) => {
    const matchesQuery = item.ticker.toLowerCase().includes(query.toLowerCase());
    const matchesSetup = selectedSetups.length === 0 || selectedSetups.includes(item.status);
    const itemThemes = item.theme.split("/");
    const matchesTheme = selectedThemes.length === 0 || selectedThemes.some((theme) => itemThemes.includes(theme));
    const matchesBase = selectedBases.length === 0 || selectedBases.includes(item.base);
    const matchesStrong = !strongOnly || item.strong;
    return matchesQuery && matchesSetup && matchesTheme && matchesBase && matchesStrong;
  });

  return (
    <main className="shell">
      <section className="workspace">
        <div className="titlebar">
          <div>
            <h1>候选名单</h1>
            <p>强势板块成分股 · 日K结构扫描 · TradingView 按钮在每只股票后面</p>
          </div>
          <div className="sync-panel">
            <span className={`sync-dot ${feed ? "online" : ""}`} />
            {feed ? `已同步 ${candidateRows.length} 只` : feedError || "同步中"}
          </div>
        </div>

        <div className="toolbar" aria-label="筛选器">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索代码" />

          <div className="filter-block">
            <span>setup</span>
            <div className="chip-row">
              {setupOptions.map((setup) => (
                <button
                  key={setup}
                  className={`chip tab-${setup} ${selectedSetups.includes(setup) ? "selected" : ""}`}
                  onClick={() => setSelectedSetups((current) => toggleValue(current, setup))}
                  title={setup === "pool" ? "watch = 在强势板块股票池里，但暂时没有命中特定 setup" : undefined}
                >
                  {setupLabels[setup]}
                </button>
              ))}
            </div>
          </div>

          <div className="filter-block dropdown-block">
            <span>板块</span>
            <button className="dropdown-trigger" onClick={() => setThemeMenuOpen((open) => !open)}>
              {selectedThemes.length ? `${selectedThemes.length} selected` : "全部板块"}
            </button>
            {themeMenuOpen && (
              <div className="dropdown-menu">
                <button className="dropdown-action" onClick={() => setSelectedThemes([])}>全部清除</button>
                {themeOptions.map((theme) => (
                  <label key={theme} className="dropdown-option">
                    <input
                      type="checkbox"
                      checked={selectedThemes.includes(theme)}
                      onChange={() => setSelectedThemes((current) => toggleValue(current, theme))}
                    />
                    {theme}
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="filter-block compact">
            <span>base</span>
            <div className="chip-row">
              {baseOptions.map((base) => (
                <button
                  key={base}
                  className={`chip ${selectedBases.includes(base) ? "selected" : ""}`}
                  onClick={() => setSelectedBases((current) => toggleValue(current, base))}
                >
                  {base}
                </button>
              ))}
            </div>
          </div>

          <label className="check">
            <input type="checkbox" checked={strongOnly} onChange={(event) => setStrongOnly(event.target.checked)} />
            只看强势板块
          </label>
          <span className="count">显示 {visible.length} / {candidateRows.length}</span>
        </div>

        <div className="base-note">
          base# 暂定规则：2 = 距高点 &lt; 4% 且紧密度 &gt; 70；3 = 距高点 &lt; 9% 且紧密度 &gt; 55；4 = 距高点 &lt; 16%；5 = 更松/更远。后续会改成真正的 Stockbee base count。
        </div>

        <div className="grid">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>代码</th>
                  <th>TV</th>
                  <th>板块</th>
                  <th>setup</th>
                  <th>base#</th>
                  <th>base日</th>
                  <th>状态</th>
                  <th>收盘</th>
                  <th>3月%</th>
                  <th>ADR%</th>
                  <th title="最近15日价格收缩程度，越高越紧。">紧密度%</th>
                  <th title="50日平均成交额，并显示当前股票池内的流动性排名。">$vol50</th>
                  <th>vs200MA</th>
                  <th title="距离最近20日高点，越低越贴近突破点。">距高点%</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visible.map((item) => (
                  <tr key={rowKey(item)}>
                    <td>{item.rank}</td>
                    <td className="ticker-cell">{item.ticker}</td>
                    <td>
                      <a className="tv-link" href={`https://www.tradingview.com/chart/?symbol=NASDAQ:${item.ticker}`} target="_blank" rel="noreferrer">
                        TV
                      </a>
                    </td>
                    <td title={item.group}>{item.theme}</td>
                    <td><StatusPill status={item.status} /></td>
                    <td>{item.base ? <BaseBadge value={item.base} /> : "-"}</td>
                    <td>{item.days || "-"}</td>
                    <td>{item.stage}</td>
                    <td>{item.close ? item.close.toFixed(2) : "-"}</td>
                    <td className={item.threeMonth > 0 ? "gain" : item.threeMonth < 0 ? "loss" : ""}>{formatPercent(item.threeMonth, true)}</td>
                    <td>{item.adr ? `${item.adr.toFixed(2)}%` : "-"}</td>
                    <td>{item.tightness ? `${item.tightness}%` : "-"}</td>
                    <td>
                      <div className="vol-cell" title={`流动性排名 #${liquidityByRow.get(rowKey(item))?.rank ?? "-"} / ${liquidityByRow.get(rowKey(item))?.total ?? "-"}`}>
                        <span>{item.dollarVol}</span>
                        <em>#{liquidityByRow.get(rowKey(item))?.rank ?? "-"}</em>
                        <i style={{ width: `${liquidityByRow.get(rowKey(item))?.percentile ?? 0}%` }} />
                      </div>
                    </td>
                    <td className={item.vs200 === null || item.vs200 < 0 ? "loss" : "gain"}>{item.vs200 === null ? "n/a" : `${item.vs200 > 0 ? "+" : ""}${item.vs200}%`}</td>
                    <td>{item.line ? `${item.line.toFixed(2)}%` : "-"}</td>
                    <td>{item.alert && <span className="alert">{item.alert}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </main>
  );
}
