/**
 * Cache daily bars for a sample of the scanned universe.
 *
 * Parameter tuning needs real price action, and a full sync takes ~15 minutes.
 * This pulls a few hundred tickers once into work/bars-sample.json so that
 * threshold experiments run in seconds.
 *
 *   node scripts/cache-bars.mjs [count]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Config, QuoteContext } from "longport";

function loadLocalEnv() {
  try {
    const text = readFileSync(".env.local", "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^([^=#]+)=(.*)$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
    }
  } catch {
    // Credentials may come from the environment instead.
  }
  for (const name of ["APP_KEY", "APP_SECRET", "ACCESS_TOKEN"]) {
    if (!process.env[`LONGPORT_${name}`] && process.env[`LONGBRIDGE_${name}`]) {
      process.env[`LONGPORT_${name}`] = process.env[`LONGBRIDGE_${name}`];
    }
  }
}

loadLocalEnv();
process.env.LONGPORT_PRINT_QUOTE_PACKAGES = "false";

const count = Number(process.argv[2] ?? 300);
const feed = JSON.parse(readFileSync(join("public", "screener-feed.json"), "utf8"));

// Spread the sample across the liquidity range rather than taking the top
// names, so the distribution of any tuned indicator is representative.
const pool = feed.candidates.filter((item) => item.averageDollarVolume > 0);
const step = Math.max(1, Math.floor(pool.length / count));
const sample = pool.filter((_, index) => index % step === 0).slice(0, count);

const ctx = QuoteContext.new(Config.fromApikeyEnv());
const bars = {};

for (let index = 0; index < sample.length; index += 5) {
  const batch = sample.slice(index, index + 5);
  await Promise.all(
    batch.map(async (item) => {
      try {
        const candles = await ctx.candlesticks(`${item.ticker}.US`, 14, 260, 1, 0);
        bars[item.ticker] = candles
          .map((candle) => ({
            date: candle.timestamp?.toISOString?.().slice(0, 10) ?? "",
            open: Number(candle.open?.toString?.() ?? candle.open),
            high: Number(candle.high?.toString?.() ?? candle.high),
            low: Number(candle.low?.toString?.() ?? candle.low),
            close: Number(candle.close?.toString?.() ?? candle.close),
            volume: Number(candle.volume ?? 0),
          }))
          .filter((bar) => bar.close > 0 && bar.high > 0 && bar.low > 0);
      } catch (error) {
        console.warn(`skip ${item.ticker}: ${error.message}`);
      }
    }),
  );
  if (index && index % 100 === 0) console.log(`cached ${index}/${sample.length}`);
}

mkdirSync("work", { recursive: true });
writeFileSync(join("work", "bars-sample.json"), JSON.stringify(bars));
console.log(`cached ${Object.keys(bars).length} tickers to work/bars-sample.json`);
