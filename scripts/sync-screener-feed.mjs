import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Config, QuoteContext, ScreenerContext } from "longport";

function loadLocalEnv() {
  try {
    const text = readFileSync(".env.local", "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^([^=#]+)=(.*)$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
    }
  } catch {
    // Hosted or managed environments can provide credentials directly.
  }
}

function parseCsv(text) {
  const rows = [];
  let field = "";
  let row = [];
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && quoted && next === '"') {
      field += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(field);
      if (row.some(Boolean)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  row.push(field);
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function parseSectors(csv) {
  const rows = parseCsv(csv);
  const headerIndex = rows.findIndex((row) => String(row[0]).trim().toLowerCase() === "sector");
  return rows.slice(headerIndex + 1).map((row) => {
    if (row[17]) {
      return { sector: row[0] ?? "", oneDay: row[1] ?? "", fiveDay: row[3] ?? "", oneMonth: row[5] ?? "", status: row[15] ?? "", atrExtension: row[16] ?? "", ticker: row[17] ?? "", price: row[18] ?? "" };
    }
    const label = String(row[0] ?? "").trim();
    const embeddedTicker = label.match(/^(.*?)\s*\(([A-Z][A-Z0-9.-]*)\)$/);
    return { sector: embeddedTicker?.[1]?.trim() ?? label, oneDay: row[2] ?? "", fiveDay: "", oneMonth: row[4] ?? "", status: row[14] ?? "", atrExtension: "", ticker: embeddedTicker?.[2] ?? "", price: row[1] ?? "" };
  }).filter((row) => row.sector && row.ticker);
}

function parseComponents(csv) {
  return parseCsv(csv).slice(1).map((row) => ({
    themeTicker: (row[0] ?? "").trim().toUpperCase(),
    ticker: (row[1] ?? "").trim().toUpperCase(),
    name: (row[2] ?? "").trim(),
    weight: (row[3] ?? "").trim(),
  })).filter((row) => row.themeTicker && /^[A-Z][A-Z0-9.-]*$/.test(row.ticker));
}

function parseLocalComponentsFromCsv(path) {
  const rows = parseCsv(readFileSync(path, "utf8"));
  const headers = rows[0].map((value) => String(value ?? "").trim());
  const positions = Object.fromEntries(headers.map((header, index) => [header, index]));
  for (const required of ["ETF", "Holding Ticker", "Holding Name", "Weight (%)"]) {
    if (!(required in positions)) throw new Error(`Missing ${required} column in ${path}`);
  }
  const components = [];

  for (const row of rows.slice(1)) {
    const themeTicker = String(row[positions.ETF] ?? "").trim().toUpperCase();
    const ticker = String(row[positions["Holding Ticker"]] ?? "").trim().toUpperCase();
    const name = String(row[positions["Holding Name"]] ?? "").trim();
    const rawWeight = row[positions["Weight (%)"]];
    const weightNumber = Number(rawWeight);
    const weight = Number.isFinite(weightNumber) ? `${weightNumber.toFixed(2)}%` : String(rawWeight ?? "").trim();

    if (!/^[A-Z][A-Z0-9.-]*$/.test(ticker)) continue;
    if (ticker.includes("CASH") || ticker.includes("USD")) continue;
    components.push({ themeTicker, ticker, name, weight });
  }

  return components;
}

function isTradableStock(item) {
  const ticker = String(item.counterId ?? item.counter_id ?? "").split("/").at(-1)?.toUpperCase() ?? "";
  const name = String(item.name ?? "");
  if (!/^[A-Z][A-Z0-9.-]*$/.test(ticker)) return false;
  if (/\.(WT|WS|RT|U)$/.test(ticker) || /-(WT|WS|RT|U)$/.test(ticker)) return false;
  return !/\b(ETF|ETN|WARRANTS?|RIGHTS?|UNITS?|PREFERRED|BOND|NOTES?)\b/i.test(name);
}

async function fetchLiquidUniverse(ctx, currentDollarVolumeFloor) {
  const pageSize = 200;
  const condition = [{ key: "balance", min: String(Math.round(currentDollarVolumeFloor / 1000)), max: "", techValues: "" }];
  const stocks = [];
  let page = 1;
  let total = Infinity;
  while ((page - 1) * pageSize < total) {
    let response;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        response = await ctx.screenerSearch("US", null, condition, [], page, pageSize);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, attempt * 2500));
      }
    }
    const payload = typeof response.data === "string" ? JSON.parse(response.data) : (response.data ?? response);
    total = Number(payload.total ?? payload.totalCount ?? payload.total_count ?? 0);
    const items = payload.items ?? [];
    stocks.push(...items.filter(isTradableStock).map((item) => ({
      ticker: String(item.counterId ?? item.counter_id).split("/").at(-1).toUpperCase(),
      name: String(item.name ?? "").trim(),
      marketCap: toNumber(item.indicators?.find((indicator) => indicator.key === "marketcap")?.value),
    })));
    if (!items.length) break;
    page += 1;
    await new Promise((resolve) => setTimeout(resolve, 900));
  }
  return Array.from(new Map(stocks.map((stock) => [stock.ticker, stock])).values());
}

function consolidateOverlappingThemes(sectors, holdings, overlapThreshold = 0.7) {
  const activeTickers = new Set(sectors.map((sector) => sector.ticker));
  const sets = new Map([...activeTickers].map((ticker) => [ticker, new Set()]));
  for (const row of holdings) if (sets.has(row.themeTicker)) sets.get(row.themeTicker).add(row.ticker);
  const parent = new Map([...activeTickers].map((ticker) => [ticker, ticker]));
  const find = (ticker) => parent.get(ticker) === ticker ? ticker : (parent.set(ticker, find(parent.get(ticker))), parent.get(ticker));
  const union = (a, b) => { const rootA = find(a); const rootB = find(b); if (rootA !== rootB) parent.set(rootB, rootA); };
  const tickers = [...activeTickers];
  for (let i = 0; i < tickers.length; i += 1) for (let j = i + 1; j < tickers.length; j += 1) {
    const a = sets.get(tickers[i]); const b = sets.get(tickers[j]);
    const intersection = [...a].filter((ticker) => b.has(ticker)).length;
    if (intersection / Math.max(1, Math.min(a.size, b.size)) >= overlapThreshold) union(tickers[i], tickers[j]);
  }
  const clusters = new Map();
  for (const ticker of tickers) { const root = find(ticker); if (!clusters.has(root)) clusters.set(root, []); clusters.get(root).push(ticker); }
  const result = new Map();
  for (const members of clusters.values()) {
    const names = members.map((ticker) => sectors.find((sector) => sector.ticker === ticker)?.sector ?? ticker);
    const cluster = { theme: members.join("+"), group: names.join(" + ") };
    for (const ticker of members) result.set(ticker, cluster);
  }
  return result;
}

function mapUniverseToThemes(universe, sectors, holdings) {
  const activeTickers = new Set(sectors.map((sector) => sector.ticker));
  const themeClusters = consolidateOverlappingThemes(sectors, holdings);
  const byStock = new Map();
  for (const row of holdings) { if (!byStock.has(row.ticker)) byStock.set(row.ticker, []); byStock.get(row.ticker).push(row); }
  return universe.map((stock) => {
    const rows = byStock.get(stock.ticker) ?? [];
    const activeRows = rows.filter((row) => activeTickers.has(row.themeTicker));
    const clusters = Array.from(new Map(activeRows.map((row) => { const cluster = themeClusters.get(row.themeTicker); return [cluster.theme, cluster]; })).values());
    const weightsByTheme = Object.fromEntries(clusters.map((cluster) => {
      const members = new Set(cluster.theme.split("+"));
      const weights = activeRows.filter((row) => members.has(row.themeTicker)).map((row) => row.weight).filter(Boolean);
      return [cluster.theme, weights.join(" / ")];
    }));
    return { ...stock, themeTicker: clusters.map((cluster) => cluster.theme).join("/") || "UNMAPPED", group: clusters.map((cluster) => cluster.group).join("/") || "No active Strong/Uptrend theme", weight: Object.values(weightsByTheme).filter(Boolean).join(" / "), weightsByTheme, etfTags: [...new Set(rows.map((row) => row.themeTicker))], strong: activeRows.length > 0 };
  });
}

async function quoteSymbols(ctx, tickers) {
  const unique = Array.from(new Set(tickers.filter(Boolean)));
  const quotes = {};
  for (let index = 0; index < unique.length; index += 50) {
    const chunk = unique.slice(index, index + 50);
    const response = await ctx.quote(chunk.map((ticker) => `${ticker}.US`));
    for (const quote of response) {
      quotes[quote.symbol.replace(".US", "")] = {
        lastDone: quote.lastDone?.toString?.() ?? "",
        timestamp: quote.timestamp?.toISOString?.() ?? quote.timestamp?.toString?.() ?? "",
      };
    }
  }
  return quotes;
}

function toNumber(value) {
  const parsed = Number(value?.toString?.() ?? value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function average(values) {
  const usable = values.filter((value) => Number.isFinite(value));
  if (!usable.length) return 0;
  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
}

function emaSeries(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  const series = [values[0]];
  for (const value of values.slice(1)) {
    series.push((value * k) + (series.at(-1) * (1 - k)));
  }
  return series;
}

function formatDollarVolume(value) {
  if (!Number.isFinite(value) || value <= 0) return "-";
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${Math.round(value / 1_000)}K`;
}

function findBreakoutPullback(bars, closes, ema21Series) {
  const start = Math.max(20, bars.length - 24);
  for (let index = start; index < bars.length - 1; index += 1) {
    const bar = bars[index];
    const prior = bars.slice(Math.max(0, index - 12), index);
    const priorHigh = Math.max(...prior.map((item) => item.high));
    const priorVolume = average(bars.slice(Math.max(0, index - 50), index).map((item) => item.volume));
    const dayChange = index > 0 ? ((bar.close / bars[index - 1].close) - 1) * 100 : 0;
    const priceBreak = bar.close > priorHigh * 1.02 || dayChange >= 4;
    const volumeBreak = priorVolume ? bar.volume > priorVolume * 1.15 : true;
    if (!priceBreak || !volumeBreak) continue;

    const after = bars.slice(index + 1);
    if (!after.length) continue;
    const touched21 = after.some((item, offset) => {
      const ema21 = ema21Series[index + 1 + offset];
      return ema21 && item.low <= ema21 * 1.04 && item.close >= ema21 * 0.97;
    });
    const last = bars.at(-1);
    const lastEma21 = ema21Series.at(-1);
    const stillConstructive = lastEma21 && last.close >= lastEma21 * 0.98 && last.close <= bar.high * 1.18;
    if (touched21 && stillConstructive) {
      return {
        breakoutDate: bar.date,
        breakoutClose: bar.close,
        breakoutHigh: bar.high,
        pivot: priorHigh,
        ema21: lastEma21,
      };
    }
  }
  return null;
}

function findSpringBurst(bars) {
  // A spring sweeps a nearby swing low, then reclaims it with real demand.
  // The absolute 30-day low missed stair-step bases; a fixed 1% undercut
  // missed marginal liquidity sweeps.
  const start = Math.max(5, bars.length - 12);
  let latestSpring = null;

  for (let index = start; index < bars.length - 1; index += 1) {
    const bar = bars[index];
    const prior = bars.slice(index - 5, index);
    if (prior.length < 5) continue;

    const support = Math.min(...prior.map((item) => item.low));
    const sweptSupport = bar.low <= support * 1.002 && bar.low >= support * 0.94;
    if (!sweptSupport) continue;

    const springDayAverageVolume = average(bars.slice(Math.max(0, index - 50), index).map((priorBar) => priorBar.volume));
    const springDayVolumeBurst = springDayAverageVolume ? bar.volume >= springDayAverageVolume * 1.15 : true;

    const followThrough = bars.slice(index + 1, Math.min(index + 6, bars.length));
    const burst = followThrough.find((item, offset) => {
      const previous = bars[index + offset];
      const absoluteIndex = index + 1 + offset;
      const averageVolume50 = average(bars.slice(Math.max(0, absoluteIndex - 50), absoluteIndex).map((priorBar) => priorBar.volume));
      const range = Math.max(item.high - item.low, 0.01);
      const closePosition = (item.close - item.low) / range;
      const dayChange = previous ? ((item.close / previous.close) - 1) * 100 : 0;
      const volumeBurst = springDayVolumeBurst || (averageVolume50 ? item.volume >= averageVolume50 * 1.15 : true);
      return item.close > support && volumeBurst && closePosition >= 0.55 && dayChange >= 4;
    });

    const last = bars.at(-1);
    const stillValid = burst && last.close > bar.close && last.close >= support * 0.97;
    if (stillValid) {
      latestSpring = {
        springDate: bar.date,
        burstDate: burst.date,
        liquidityLevel: support,
      };
    }
  }

  return latestSpring;
}

function pickStatus({ springBurst, breakoutPullback, close, sma20, sma50, high20, high50, priorHigh50, low5, high5, threeMonth, line, adr }) {
  if (springBurst) return "spring";
  if (breakoutPullback) return close < breakoutPullback.pivot ? "fakeout" : "bpr";
  const reclaimed20 = low5 < sma20 && close > sma20 && close > sma50 && threeMonth > 5;
  const failedBreakout = high5 > priorHigh50 * 1.01 && close < priorHigh50 && close > sma50;
  const nearPivot = close > sma20 && close > sma50 && high20 > 0 && line <= Math.max(adr * 1.8, 8) && threeMonth > 8;
  if (failedBreakout) return "fakeout";
  if (reclaimed20) return "bpr";
  if (nearPivot) return "anticipation";
  if (close > sma50 && close > sma20 && close > high50 * 0.82) return "anticipation";
  return "pool";
}

function breakoutSignalAt(bars, index) {
  if (index < 50) return null;
  const bar = bars[index];
  const pivot = Math.max(...bars.slice(index - 20, index).map((item) => item.high));
  const averageVolume50 = average(bars.slice(index - 50, index).map((item) => item.volume));
  const volumeRatio = averageVolume50 ? bar.volume / averageVolume50 : 0;
  const closePosition = (bar.close - bar.low) / Math.max(bar.high - bar.low, 0.01);
  return { valid: bar.close > pivot && volumeRatio >= 1.5 && closePosition >= 0.6, pivot, volumeRatio, closePosition, date: bar.date };
}

function analyzeCandles(component, sectorLabel, candles, minAverageDollarVolume) {
  const bars = candles.map((bar) => ({
    open: toNumber(bar.open),
    high: toNumber(bar.high),
    low: toNumber(bar.low),
    close: toNumber(bar.close),
    volume: Number(bar.volume ?? 0),
    turnover: toNumber(bar.turnover),
    date: bar.timestamp?.toISOString?.().slice(0, 10) ?? "",
  })).filter((bar) => bar.close > 0 && bar.high > 0 && bar.low > 0);

  const last = bars.at(-1);
  if (!last || bars.length < 80) return null;

  const closes = bars.map((bar) => bar.close);
  const ema21Series = emaSeries(closes, 21);
  const highs = bars.map((bar) => bar.high);
  const lows = bars.map((bar) => bar.low);
  const recent5 = bars.slice(-5);
  const recent15 = bars.slice(-15);
  const recent20 = bars.slice(-20);
  const recent50 = bars.slice(-50);
  const prior50 = bars.slice(-60, -10);
  const sma20 = average(closes.slice(-20));
  const sma50 = average(closes.slice(-50));
  const sma200 = average(closes.slice(-200));
  const high20 = Math.max(...recent20.map((bar) => bar.high));
  const high50 = Math.max(...recent50.map((bar) => bar.high));
  const priorHigh50 = Math.max(...prior50.map((bar) => bar.high));
  const low5 = Math.min(...recent5.map((bar) => bar.low));
  const high5 = Math.max(...recent5.map((bar) => bar.high));
  const close63 = closes.at(-64) ?? closes[0];
  const threeMonth = close63 ? ((last.close / close63) - 1) * 100 : 0;
  const adr = average(bars.slice(-20).map((bar) => ((bar.high - bar.low) / bar.close) * 100));
  const vs200 = sma200 ? ((last.close / sma200) - 1) * 100 : null;
  const line = high20 ? Math.max(0, ((high20 - last.close) / last.close) * 100) : 0;
  const range15 = Math.max(...recent15.map((bar) => bar.high)) - Math.min(...recent15.map((bar) => bar.low));
  const range15Pct = (range15 / last.close) * 100;
  const tightness = Math.max(0, Math.min(100, 100 - (range15Pct * 2.8)));
  const avgDollar50 = average(recent50.map((bar) => bar.turnover || (bar.close * bar.volume)));
  if (avgDollar50 < minAverageDollarVolume) return null;
  const springBurst = findSpringBurst(bars);
  const todayBreakout = breakoutSignalAt(bars, bars.length - 1);
  let recentBreakout = null;
  for (let index = Math.max(50, bars.length - 5); index < bars.length - 1; index += 1) {
    const signal = breakoutSignalAt(bars, index);
    if (signal?.valid) recentBreakout = signal;
  }
  const pivot = todayBreakout?.pivot ?? recentBreakout?.pivot ?? Math.max(...bars.slice(-21, -1).map((bar) => bar.high));
  const distanceToPivot = ((pivot - last.close) / last.close) * 100;
  const currentVolumeRatio = last.volume / average(bars.slice(-51, -1).map((bar) => bar.volume));
  const currentClosePosition = (last.close - last.low) / Math.max(last.high - last.low, 0.01);
  const rejectedToday = !todayBreakout?.valid
    && last.high > pivot
    && last.close < pivot
    && currentVolumeRatio >= 1.5
    && currentClosePosition < 0.5;
  const lostRecentBreakout = recentBreakout && last.close < recentBreakout.pivot;
  const failedBreakout = rejectedToday || lostRecentBreakout;
  const holding = recentBreakout && last.close >= recentBreakout.pivot && last.close >= ema21Series.at(-1) * 0.98;
  const setup = last.close > sma20 && last.close > sma50 && distanceToPivot >= 0 && distanceToPivot <= 5 && range15Pct <= 12 && threeMonth > 8;
  const status = failedBreakout ? "fakeout" : todayBreakout?.valid ? "breakout" : holding ? "holding" : setup ? "anticipation" : "pool";
  const daysSinceHigh20 = Math.max(1, recent20.length - 1 - recent20.findLastIndex((bar) => bar.high === high20));
  const base = line < 4 && tightness > 70 ? 2 : line < 9 && tightness > 55 ? 3 : line < 16 ? 4 : 5;
  const ob = last.volume > average(bars.slice(-50, -1).map((bar) => bar.volume)) * 1.6 && last.close > last.open;
  const wedge = recent5[0]?.high > recent5[1]?.high && recent5[1]?.high > recent5[2]?.high && recent5.at(-1)?.close > recent5.at(-2)?.close;

  return {
    rank: 0,
    ticker: component.ticker,
    name: component.name || component.ticker,
    group: sectorLabel,
    theme: component.themeTicker,
    status,
    base,
    days: daysSinceHigh20,
    stage: status === "pool" ? "watch" : "active",
    close: Number(last.close.toFixed(2)),
    threeMonth: Number(threeMonth.toFixed(1)),
    adr: Number(adr.toFixed(2)),
    tightness: Math.round(tightness),
    dollarVol: formatDollarVolume(avgDollar50),
    vs200: vs200 === null ? null : Math.round(vs200),
    line: Number(Math.max(0, distanceToPivot).toFixed(2)),
    range15Pct: Number(range15Pct.toFixed(2)),
    relativeVolume: Number((todayBreakout?.volumeRatio ?? (last.volume / average(bars.slice(-51, -1).map((bar) => bar.volume)))).toFixed(2)),
    closePosition: Number(((todayBreakout?.closePosition ?? ((last.close - last.low) / Math.max(last.high - last.low, 0.01))) * 100).toFixed(0)),
    pivot: Number(pivot.toFixed(2)),
    alert: springBurst ? "Spring" : wedge && ob ? "wedge+OB" : undefined,
    strong: component.strong,
    etfTags: component.etfTags,
    weight: component.weight,
    weightsByTheme: component.weightsByTheme,
    marketCap: component.marketCap,
    breakoutDate: todayBreakout?.valid ? todayBreakout.date : recentBreakout?.date,
    springDate: springBurst?.springDate,
    burstDate: springBurst?.burstDate,
    liquidityLevel: springBurst?.liquidityLevel ? Number(springBurst.liquidityLevel.toFixed(2)) : undefined,
    ema21: Number(ema21Series.at(-1).toFixed(2)),
    lastDate: last.date,
  };
}

async function scanCandidates(ctx, sectors, components, minAverageDollarVolume) {
  const candidates = [];
  const concurrency = Number(process.env.CANDLE_SCAN_CONCURRENCY ?? 5);
  for (let index = 0; index < components.length; index += concurrency) {
    const batch = components.slice(index, index + concurrency);
    const results = await Promise.all(batch.map(async (component) => {
      try {
        const candles = await ctx.candlesticks(`${component.ticker}.US`, 14, 260, 1, 0);
        return analyzeCandles(component, component.group, candles, minAverageDollarVolume);
      } catch (error) {
        console.warn(`skip ${component.ticker}: ${error.message}`);
        return null;
      }
    }));
    candidates.push(...results.filter(Boolean));
    if (index && index % 250 === 0) console.log(`scanned ${index}/${components.length}, passed ${candidates.length}`);
  }
  candidates.sort((a, b) => {
    const statusWeight = { breakout: 0, holding: 1, fakeout: 2, anticipation: 3, pool: 4, spring: 5, bpr: 5 };
    return statusWeight[a.status] - statusWeight[b.status] || a.line - b.line || b.threeMonth - a.threeMonth;
  });
  return candidates.map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

loadLocalEnv();
process.env.LONGPORT_PRINT_QUOTE_PACKAGES = "false";

const sheetId = process.env.GOOGLE_SHEET_ID || "1zXbIfknybtivC5hgkqthyhqwK9OjYCKVadvJTPZrHqE";
const sheetGid = process.env.GOOGLE_SHEET_GID || "1076580676";
const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${sheetGid}`;
const sheetResponse = await fetch(sheetUrl);
if (!sheetResponse.ok) {
  throw new Error(`Google Sheet read failed: ${sheetResponse.status}`);
}

const sectors = parseSectors(await sheetResponse.text()).filter((row) => /Strong Trend|Uptrend/i.test(row.status));
const localHoldingsPath = process.env.LOCAL_ETF_HOLDINGS_CSV || String.raw`D:\交易为生\deepvue\ETF_holdings_clean_with_IGV.csv`;
const minAverageDollarVolume = Number(process.env.MIN_AVERAGE_DOLLAR_VOLUME ?? 20_000_000);
const universePrefilterDollarVolume = Number(process.env.UNIVERSE_PREFILTER_DOLLAR_VOLUME ?? 5_000_000);
const components = parseLocalComponentsFromCsv(localHoldingsPath);
const ctx = QuoteContext.new(Config.fromApikeyEnv());
const screenerCtx = ScreenerContext.new(Config.fromApikeyEnv());
const universe = await fetchLiquidUniverse(screenerCtx, universePrefilterDollarVolume);
const activeComponents = mapUniverseToThemes(universe, sectors, components);
const quotes = await quoteSymbols(ctx, sectors.map((row) => row.ticker));
const candidates = await scanCandidates(ctx, sectors, activeComponents, minAverageDollarVolume);

const feed = {
  updatedAt: new Date().toISOString(),
  sectors,
  components,
  activeComponents,
  candidates,
  quotes,
  universeCount: universe.length,
  stockQuotes: {},
};

mkdirSync("work", { recursive: true });
mkdirSync("public", { recursive: true });
writeFileSync(join("work", "screener-feed.json"), JSON.stringify(feed, null, 2));
writeFileSync(join("public", "screener-feed.json"), JSON.stringify(feed, null, 2));
console.log(`synced sectors=${sectors.length} holdings=${components.length} universe=${universe.length} candidates=${candidates.length} activeMapped=${candidates.filter((item) => item.strong).length} minAverageDollarVolume=${minAverageDollarVolume}`);
