import { Config, QuoteContext } from "longport";

const symbols = process.argv.slice(2);
if (!symbols.length) {
  console.log("{}");
  process.exit(0);
}

const config = Config.fromApikeyEnv();
const ctx = QuoteContext.new(config);
const response = await ctx.quote(symbols);

const quotes = Object.fromEntries(response.map((quote) => [
  quote.symbol.replace(".US", ""),
  {
    lastDone: quote.lastDone?.toString?.() ?? "",
    timestamp: quote.timestamp?.toISOString?.() ?? quote.timestamp?.toString?.() ?? "",
  },
]));

console.log(JSON.stringify(quotes));
