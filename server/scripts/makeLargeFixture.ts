/**
 * Phase 5 fixture generator — stream-writes a synthetic, FMCG-shaped CSV of N
 * rows WITHOUT holding them in memory (backpressure-aware), so it can produce
 * 1M / 10M-row files for scale + regression testing.
 *
 *   node --import tsx scripts/makeLargeFixture.ts <rows> [outPath]
 *   node --import tsx scripts/makeLargeFixture.ts 1000000 /tmp/fixture-1m.csv
 *   node --import tsx scripts/makeLargeFixture.ts 10000000 /tmp/fixture-10m.csv
 *
 * Columns: Date, Region, Brand, Channel, Sales, Units — a mix of date / string /
 * numeric so DuckDB type inference, temporal facets and aggregations all exercise.
 */
import fs from "fs";
import path from "path";
import os from "os";

const rows = Number(process.argv[2] || 1_000_000);
const outPath = process.argv[3] || path.join(os.tmpdir(), `fixture-${rows}.csv`);

if (!Number.isFinite(rows) || rows <= 0) {
  console.error("usage: makeLargeFixture.ts <rows> [outPath]");
  process.exit(1);
}

const REGIONS = ["North", "South", "East", "West", "Central"];
const BRANDS = ["Parachute", "Saffola", "Nihar", "HairAndCare", "Livon"];
const CHANNELS = ["MT", "GT", "Ecom", "Wholesale"];
const DAY_MS = 86_400_000;
const START = Date.UTC(2021, 0, 1);

function rowAt(i: number): string {
  const date = new Date(START + (i % 1500) * DAY_MS).toISOString().slice(0, 10);
  const region = REGIONS[i % REGIONS.length];
  const brand = BRANDS[(i * 3) % BRANDS.length];
  const channel = CHANNELS[(i * 7) % CHANNELS.length];
  const sales = ((i * 7) % 100000) + 1;
  const units = (i % 200) + 1;
  return `${date},${region},${brand},${channel},${sales},${units}\n`;
}

const ws = fs.createWriteStream(outPath);
ws.write("Date,Region,Brand,Channel,Sales,Units\n");

function pump(i: number): void {
  let ok = true;
  while (i < rows && ok) {
    ok = ws.write(rowAt(i));
    i++;
  }
  if (i < rows) {
    ws.once("drain", () => pump(i));
  } else {
    ws.end(() => {
      const mb = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
      console.log(`wrote ${rows.toLocaleString("en-US")} rows -> ${outPath} (${mb} MB)`);
    });
  }
}

pump(0);
