import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";

type SectorRow = {
  sector: string;
  oneDay: string;
  fiveDay: string;
  oneMonth: string;
  status: string;
  atrExtension: string;
  ticker: string;
  price: string;
};

function loadLocalEnv() {
  try {
    const text = readFileSync(join(process.cwd(), ".env.local"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^([^=#]+)=(.*)$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2];
      }
    }
  } catch {
    // Local env is optional in hosted mode.
  }
}

function parseCsv(text: string) {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
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

function parseSectors(csv: string): SectorRow[] {
  const rows = parseCsv(csv);
  return rows.slice(1).map((row) => ({
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

export async function GET() {
  loadLocalEnv();

  try {
    const cached = readFileSync(join(process.cwd(), "work", "screener-feed.json"), "utf8");
    return NextResponse.json(JSON.parse(cached));
  } catch {
    // Fall through to sheet-only live read when the local cache has not been built yet.
  }

  const sheetId = process.env.GOOGLE_SHEET_ID;
  const gid = process.env.GOOGLE_SHEET_GID;
  if (!sheetId || !gid) {
    return NextResponse.json({ error: "Google Sheet is not configured." }, { status: 400 });
  }

  const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
  const sheetResponse = await fetch(sheetUrl, { cache: "no-store" });
  if (!sheetResponse.ok) {
    return NextResponse.json({ error: "Could not read the Google Sheet." }, { status: 502 });
  }

  const sectors = parseSectors(await sheetResponse.text()).slice(0, 20);
  return NextResponse.json({
    updatedAt: new Date().toISOString(),
    sectors,
    quotes: {},
  });
}
