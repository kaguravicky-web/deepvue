import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Config, QuoteContext, ScreenerContext } from "longport";

import { DEFAULT_PRESET, PARAMS, applyRsRating, classify } from "./rules.js";

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
  // The SDK reads LONGPORT_*; older local setups only define LONGBRIDGE_*.
  for (const name of ["APP_KEY", "APP_SECRET", "ACCESS_TOKEN"]) {
    if (!process.env[`LONGPORT_${name}`] && process.env[`LONGBRIDGE_${name}`]) {
      process.env[`LONGPORT_${name}`] = process.env[`LONGBRIDGE_${name}`];
    }
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

function formatDollarVolume(value) {
  if (!Number.isFinite(value) || value <= 0) return "-";
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${Math.round(value / 1_000)}K`;
}

/**
 * Turn one ticker's candles into a feed row.
 *
 * All state logic lives in scripts/rules.js — this function only shapes data
 * for the page. Returns null when the ticker is too illiquid or too new.
 */
function analyzeCandles(component, sectorLabel, candles, minAverageDollarVolume) {
  const bars = candles
    .map((candle) => ({
      open: toNumber(candle.open),
      high: toNumber(candle.high),
      low: toNumber(candle.low),
      close: toNumber(candle.close),
      volume: Number(candle.volume ?? 0),
      turnover: toNumber(candle.turnover),
      date: candle.timestamp?.toISOString?.().slice(0, 10) ?? "",
    }))
    .filter((bar) => bar.close > 0 && bar.high > 0 && bar.low > 0);

  const last = bars.at(-1);
  if (!last) return null;

  const averageDollarVolume = average(
    bars.slice(-50).map((bar) => bar.turnover || bar.close * bar.volume),
  );
  if (averageDollarVolume < minAverageDollarVolume) return null;

  const verdict = classify(bars);
  if (!verdict) return null;

  const closes = bars.map((bar) => bar.close);
  const sma200 = bars.length >= 200 ? average(closes.slice(-200)) : null;
  const adr = average(bars.slice(-20).map((bar) => ((bar.high - bar.low) / bar.close) * 100));

  return {
    ticker: component.ticker,
    name: component.name || component.ticker,
    group: sectorLabel,
    theme: component.themeTicker,

    // Rule output — the page renders these, it does not re-derive them.
    mainState: verdict.mainState,
    springTag: verdict.springTag,
    tightnessTag: verdict.tightnessTag,
    setupCriteriaMet: verdict.setupCriteriaMet,
    fakeoutReason: verdict.fakeoutReason,
    breakoutDate: verdict.breakoutDate,
    breakoutDaysAgo: verdict.breakoutDaysAgo,
    spring: verdict.spring
      ? {
          springDate: verdict.spring.springDate,
          reclaimDate: verdict.spring.reclaimDate,
          support: round(verdict.spring.support),
          undercutPct: round(verdict.spring.undercutPct),
          daysSinceReclaim: verdict.spring.daysSinceReclaim,
        }
      : null,

    // Metrics, all straight off the rule engine so the table and the state
    // can never disagree.
    close: round(verdict.close),
    sma20: round(verdict.sma20),
    sma50: round(verdict.sma50),
    ema21: round(verdict.ema21),
    pivot: round(verdict.pivot),
    highest20: round(verdict.highest20),
    rvol: round(verdict.rvol),
    rmv: round(verdict.rmv, 1),
    volumeDryUp: round(verdict.volumeDryUp),
    closePosition: Math.round(verdict.closePosition),
    range15Pct: round(verdict.range15Pct),
    threeMonthPct: round(verdict.threeMonthPct, 1),
    distanceToHighPct: round(verdict.distanceToHighPct),

    adr: round(adr),
    vs200: sma200 ? Math.round((verdict.close / sma200 - 1) * 100) : null,
    dollarVol: formatDollarVolume(averageDollarVolume),
    averageDollarVolume: Math.round(averageDollarVolume),

    marketCap: component.marketCap,
    weight: component.weight,
    weightsByTheme: component.weightsByTheme,
    etfTags: component.etfTags,
    strong: component.strong,
    lastDate: verdict.date,
  };
}

function round(value, digits = 2) {
  return value == null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));
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
  // Relative strength percentile over the scanned universe, 1-99. RS is a
  // rank, so it can only be known once every ticker has been classified —
  // that is why the Setup gate on it is applied here rather than in the rules.
  const byMomentum = [...candidates].sort((a, b) => (b.threeMonthPct ?? -999) - (a.threeMonthPct ?? -999));
  const rs = new Map(
    byMomentum.map((candidate, index) => [
      candidate.ticker,
      Math.max(1, Math.round(99 - (index * 98) / Math.max(1, byMomentum.length - 1))),
    ]),
  );

  const rated = candidates.map((candidate) => {
    const rsRating = rs.get(candidate.ticker);
    return { ...applyRsRating(candidate, rsRating), rs: rsRating };
  });

  // Actionable first, then closest to its pivot, then strongest 3-month move.
  const stateOrder = { breakout: 0, holding: 1, setup: 2, fakeout: 3, watch: 4 };
  rated.sort(
    (a, b) =>
      stateOrder[a.mainState] - stateOrder[b.mainState] ||
      (a.distanceToHighPct ?? 999) - (b.distanceToHighPct ?? 999) ||
      (b.threeMonthPct ?? -999) - (a.threeMonthPct ?? -999),
  );

  return rated.map((candidate, index) => ({ ...candidate, rank: index + 1 }));
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
  // Published so the page can label its own thresholds instead of hardcoding
  // numbers that drift away from the engine.
  preset: DEFAULT_PRESET,
  params: PARAMS,
  sectors,
  candidates,
  quotes,
  universeCount: universe.length,
};

mkdirSync("work", { recursive: true });
mkdirSync("public", { recursive: true });
// The working copy keeps the raw holdings for debugging; the published feed
// carries only what the page renders.
writeFileSync(
  join("work", "screener-feed.json"),
  JSON.stringify({ ...feed, components, activeComponents }, null, 2),
);
writeFileSync(join("public", "screener-feed.json"), JSON.stringify(feed));
console.log(`synced sectors=${sectors.length} holdings=${components.length} universe=${universe.length} candidates=${candidates.length} activeMapped=${candidates.filter((item) => item.strong).length} minAverageDollarVolume=${minAverageDollarVolume}`);
