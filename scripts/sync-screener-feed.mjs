import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Config, QuoteContext } from "longport";

function loadLocalEnv() {
  const text = readFileSync(".env.local", "utf8");
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([^=#]+)=(.*)$/);
    if (match) process.env[match[1]] = match[2];
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
  return parseCsv(csv).slice(1).map((row) => ({
    sector: row[0] ?? "",
    oneDay: row[1] ?? "",
    fiveDay: row[3] ?? "",
    oneMonth: row[5] ?? "",
    status: row[15] ?? "",
    atrExtension: row[16] ?? "",
    ticker: row[17] ?? "",
    price: row[18] ?? "",
  })).filter((row) => row.sector && row.ticker);
}

function parseComponents(csv) {
  return parseCsv(csv).slice(1).map((row) => ({
    themeTicker: (row[0] ?? "").trim().toUpperCase(),
    ticker: (row[1] ?? "").trim().toUpperCase(),
    name: (row[2] ?? "").trim(),
    weight: (row[3] ?? "").trim(),
  })).filter((row) => row.themeTicker && /^[A-Z][A-Z0-9.-]*$/.test(row.ticker));
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

function pickStatus({ breakoutPullback, close, sma20, sma50, high20, high50, priorHigh50, low5, high5, threeMonth, line, adr }) {
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

function analyzeCandles(component, sectorLabel, candles) {
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
  const tightness = Math.max(0, Math.min(100, 100 - ((range15 / last.close) * 280)));
  const avgDollar50 = average(recent50.map((bar) => bar.turnover || (bar.close * bar.volume)));
  const breakoutPullback = findBreakoutPullback(bars, closes, ema21Series);
  const status = pickStatus({ breakoutPullback, close: last.close, sma20, sma50, high20, high50, priorHigh50, low5, high5, threeMonth, line, adr });
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
    line: Number(line.toFixed(2)),
    alert: wedge && ob ? "wedge+OB" : undefined,
    strong: true,
    weight: component.weight,
    breakoutDate: breakoutPullback?.breakoutDate,
    ema21: breakoutPullback?.ema21 ? Number(breakoutPullback.ema21.toFixed(2)) : undefined,
    lastDate: last.date,
  };
}

async function scanCandidates(ctx, sectors, components) {
  const sectorByTicker = new Map(sectors.map((sector, index) => [sector.ticker, `${sector.sector} #${index + 1}`]));
  const candidates = [];
  for (const component of components) {
    try {
      const candles = await ctx.candlesticks(`${component.ticker}.US`, 14, 260, 1, 0);
      const analyzed = analyzeCandles(component, sectorByTicker.get(component.themeTicker) ?? component.themeTicker, candles);
      if (analyzed) candidates.push(analyzed);
    } catch (error) {
      console.warn(`skip ${component.ticker}: ${error.message}`);
    }
  }
  candidates.sort((a, b) => {
    const statusWeight = { fakeout: 0, bpr: 1, anticipation: 2, pool: 3 };
    return statusWeight[a.status] - statusWeight[b.status] || a.line - b.line || b.threeMonth - a.threeMonth;
  });
  return candidates.map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

loadLocalEnv();
process.env.LONGPORT_PRINT_QUOTE_PACKAGES = "false";

const sheetUrl = `https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SHEET_ID}/export?format=csv&gid=${process.env.GOOGLE_SHEET_GID}`;
const sheetResponse = await fetch(sheetUrl);
if (!sheetResponse.ok) {
  throw new Error(`Google Sheet read failed: ${sheetResponse.status}`);
}

const sectors = parseSectors(await sheetResponse.text()).slice(0, 20);
const componentUrl = `https://docs.google.com/spreadsheets/d/${process.env.COMPONENTS_SHEET_ID}/export?format=csv&gid=${process.env.COMPONENTS_SHEET_GID ?? "0"}`;
const componentResponse = await fetch(componentUrl);
if (!componentResponse.ok) {
  throw new Error(`Components Sheet read failed: ${componentResponse.status}`);
}

const components = parseComponents(await componentResponse.text());
const strongThemeTickers = new Set(sectors.map((row) => row.ticker));
const activeComponents = components.filter((row) => strongThemeTickers.has(row.themeTicker));
const ctx = QuoteContext.new(Config.fromApikeyEnv());
const quotes = await quoteSymbols(ctx, sectors.map((row) => row.ticker));
const stockQuotes = await quoteSymbols(ctx, activeComponents.map((row) => row.ticker));
const candidates = await scanCandidates(ctx, sectors, activeComponents);

const feed = {
  updatedAt: new Date().toISOString(),
  sectors,
  components,
  activeComponents,
  candidates,
  quotes,
  stockQuotes,
};

mkdirSync("work", { recursive: true });
mkdirSync("public", { recursive: true });
writeFileSync(join("work", "screener-feed.json"), JSON.stringify(feed, null, 2));
writeFileSync(join("public", "screener-feed.json"), JSON.stringify(feed, null, 2));
console.log(`synced sectors=${sectors.length} components=${components.length} activeComponents=${activeComponents.length} candidates=${candidates.length} quotes=${Object.keys(quotes).length} stockQuotes=${Object.keys(stockQuotes).length}`);
