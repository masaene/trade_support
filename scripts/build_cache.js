'use strict';

// One-time/manual batch: merges bars/*.json + jquants_data/csv/*.csv into
// jquants_cache/{code}.json + jquants_cache/{code}_finance.json (one file per
// code, kept separate from bars/ per the plan), then derives the Lynch-chart
// fair-value ranking into jquants_cache/_lynch_ranking.json.
//
// Run manually: node scripts/build_cache.js
//
// Memory note: this box runs with ~1GB RAM shared with other processes, and
// the CSVs total ~475k bars rows — holding every code's full merged bars +
// finance arrays in memory at once (for a later ranking pass) was enough to
// get this process OOM-killed silently partway through a run. So the ranking
// computation happens INLINE in the same per-code loop that writes the cache
// files (only the small ranking record is kept afterward), and each code's
// CSV-grouped rows are deleted from the lookup maps as soon as they're
// consumed, so peak memory doesn't grow with the number of codes processed.

const fs = require('fs');
const path = require('path');
const {
  mergeBarsForCode,
  mergeFinanceForCode,
  isCanonicalCode,
  buildS33ToIndustryNo,
  computeFairValue,
  computeBookValueInfo,
  computeEpsGrowthInfo,
  toNum,
} = require('../lib/mergeData');

const ROOT_DIR = path.join(__dirname, '..');
const BARS_DIR = path.join(ROOT_DIR, 'bars');
const CSV_DIR = path.join(ROOT_DIR, 'jquants_data', 'csv');
const PER_SECTOR_PATH = path.join(ROOT_DIR, 'public', 'market', 'data', 'per-by-sector.json');
const CACHE_DIR = path.join(ROOT_DIR, 'jquants_cache');

function code4(rawCode) {
  return String(rawCode).slice(0, 4);
}

// Returns the value of the `col`-th (0-based) comma field without splitting
// the whole line — used only to extract the grouping key cheaply.
function fieldAt(line, col) {
  let start = 0;
  for (let i = 0; i < col; i++) {
    const idx = line.indexOf(',', start);
    if (idx === -1) return '';
    start = idx + 1;
  }
  const end = line.indexOf(',', start);
  return end === -1 ? line.slice(start) : line.slice(start, end);
}

// Groups RAW LINES (not parsed objects) by code. ~475k bars rows parsed into
// JS objects up front (13-111 keys each) was enough peak memory to get this
// process OOM-killed by the kernel on this box's ~1GB RAM (confirmed via
// `/usr/bin/time -v`: 460MB RSS, 700k+ major page faults — thrashing, not a
// hung loop). Keeping lines as strings and parsing only the handful of rows
// a given code actually has (in the main loop below) keeps peak memory close
// to the raw CSV size (~44MB) instead of blowing it up ~10x in V8 objects.
// isCanonicalCode (see lib/mergeData.js) drops preferred-share rows so they
// don't get merged into the common stock's cache entry under the same
// truncated 4-digit code.
function groupLinesByCode(filePath, byCode) {
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split('\n');
  const header = lines[0];
  const codeIdx = header.split(',').indexOf('Code');
  let count = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const fullCode = fieldAt(line, codeIdx);
    if (!isCanonicalCode(fullCode)) continue;
    const code = code4(fullCode);
    let bucket = byCode.get(code);
    if (!bucket) {
      bucket = [];
      byCode.set(code, bucket);
    }
    bucket.push(line);
    count++;
  }
  return { count, header };
}

function parseLines(header, lines) {
  const cols = header.split(',');
  return lines.map((line) => {
    const cells = line.split(',');
    const row = {};
    for (let c = 0; c < cols.length; c++) row[cols[c]] = cells[c];
    return row;
  });
}

function loadExistingBars(code) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(BARS_DIR, `${code}.json`), 'utf8'));
    return Array.isArray(raw.data) ? raw.data : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

function loadExistingFinance(code) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(BARS_DIR, `${code}_finance_summary.json`), 'utf8'));
    return Array.isArray(raw.data) ? raw.data : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// ---- 1. group all CSV rows (as raw lines) by 4-digit code ----
console.log('Reading CSV files from', CSV_DIR);
const barsByCode = new Map();
const financeByCode = new Map();
let barsHeader = null;
let financeHeader = null;

const csvFiles = fs.readdirSync(CSV_DIR);
for (const file of csvFiles) {
  const filePath = path.join(CSV_DIR, file);
  if (file.startsWith('equities_bars_daily_')) {
    const { count, header } = groupLinesByCode(filePath, barsByCode);
    barsHeader = barsHeader || header;
    console.log(`  ${file}: ${count} rows`);
  } else if (file.startsWith('fins_summary_')) {
    const { count, header } = groupLinesByCode(filePath, financeByCode);
    financeHeader = financeHeader || header;
    console.log(`  ${file}: ${count} rows`);
  }
}

// ---- 2. sector/market reference data, loaded once up front (small) ----
const master = JSON.parse(fs.readFileSync(path.join(BARS_DIR, 'master.json'), 'utf8')).data;
const perSector = JSON.parse(fs.readFileSync(PER_SECTOR_PATH, 'utf8'));
const s33ToNo = buildS33ToIndustryNo(master);
const sectorByNo = new Map(perSector.sectors.map((s) => [s.no, s]));
const masterByCode = new Map(master.filter((r) => isCanonicalCode(r.Code)).map((r) => [code4(r.Code), r]));

// ---- 3. union of codes to process: anything in CSVs, existing bars/, or master ----
const existingCodes = fs.readdirSync(BARS_DIR)
  .map((f) => f.match(/^(\d{4})\.json$/))
  .filter(Boolean)
  .map((m) => m[1]);

const allCodes = new Set([...barsByCode.keys(), ...financeByCode.keys(), ...existingCodes]);
console.log(`Merging ${allCodes.size} codes...`);

fs.mkdirSync(CACHE_DIR, { recursive: true });

let barsWritten = 0;
let financeWritten = 0;
let processed = 0;
const ranking = [];
const startTime = Date.now();

for (const code of allCodes) {
  processed++;
  if (processed % 500 === 0) {
    console.log(`  ...${processed}/${allCodes.size} codes (${Math.round((Date.now() - startTime) / 1000)}s elapsed)`);
  }
  const existingBars = loadExistingBars(code);
  const csvBarsLines = barsByCode.get(code) || [];
  barsByCode.delete(code); // free as we go — don't hold every code's rows for the whole run
  const csvBars = barsHeader ? parseLines(barsHeader, csvBarsLines) : [];
  const mergedBars = mergeBarsForCode(existingBars, [csvBars]);
  const barsCachePath = path.join(CACHE_DIR, `${code}.json`);
  if (mergedBars.data.length) {
    fs.writeFileSync(barsCachePath, JSON.stringify(mergedBars));
    barsWritten++;
  } else if (fs.existsSync(barsCachePath)) {
    // A code that used to merge to some valid rows (e.g. before the no-trade-
    // day null filter in computeAdjustedSeries existed) but now merges to
    // zero must not leave that stale file sitting there — a skipped write is
    // not the same as "no change needed" once the merge result can shrink.
    fs.unlinkSync(barsCachePath);
  }

  const existingFinance = loadExistingFinance(code);
  const csvFinanceLines = financeByCode.get(code) || [];
  financeByCode.delete(code);
  const csvFinance = financeHeader ? parseLines(financeHeader, csvFinanceLines) : [];
  const mergedFinance = mergeFinanceForCode(existingFinance, [csvFinance]);
  const financeCachePath = path.join(CACHE_DIR, `${code}_finance.json`);
  if (mergedFinance.data.length) {
    fs.writeFileSync(financeCachePath, JSON.stringify(mergedFinance));
    financeWritten++;
  } else if (fs.existsSync(financeCachePath)) {
    fs.unlinkSync(financeCachePath);
  }

  // ---- Ranking for this code, computed inline while its data is already in
  // hand (see memory note at top of file). Lynch fair value (PER-based),
  // book value (PBR-based), and the EPS-growth-rate fair value are all
  // independent — a code is included if ANY is computable, so no filter is
  // limited to codes with a sector-PER match. ----
  const info = masterByCode.get(code);
  if (!info) continue;
  const fv = computeFairValue({
    masterInfo: info,
    s33ToNo,
    sectorByNo,
    financeRecords: mergedFinance.data,
    bars: mergedBars.data,
  });
  const lastBar = mergedBars.data[mergedBars.data.length - 1];
  const currentPrice = lastBar ? toNum(lastBar.C) : null;
  const bv = currentPrice !== null ? computeBookValueInfo(mergedFinance.data, lastBar.Date, currentPrice) : null;
  const growth = currentPrice !== null ? computeEpsGrowthInfo(mergedFinance.data, lastBar.Date, currentPrice) : null;
  if (!fv && !bv && !growth) continue;

  ranking.push({
    code,
    name: info.CoName,
    market: info.MktNm,
    sector: fv ? fv.sector : null,
    currentPrice: fv ? fv.currentPrice : currentPrice,
    eps: fv ? fv.eps : null,
    epsBasis: fv ? fv.epsBasis : null,
    sectorPER: fv ? fv.sectorPER : null,
    fairValue: fv ? fv.fairValue : null,
    deviationPct: fv ? fv.deviationPct : null,
    bps: bv ? bv.bps : null,
    pbr: bv ? bv.pbr : null,
    pbrDeviationPct: bv && bv.pbr !== null ? (1 - bv.pbr) * 100 : null,
    growthPct: growth ? growth.growthPct : null,
    growthFairValue: growth ? growth.fairValue : null,
    growthDeviationPct: growth ? growth.deviationPct : null,
  });
}

console.log(`Wrote ${barsWritten} bars files, ${financeWritten} finance files to ${CACHE_DIR}`);

// Nulls (no Lynch fair value for that code) sort after every real value,
// in both directions — this is a display default only, the ranking page's
// own sliders/sort control what's actually shown.
ranking.sort((a, b) => {
  if (a.deviationPct === null && b.deviationPct === null) return 0;
  if (a.deviationPct === null) return 1;
  if (b.deviationPct === null) return -1;
  return a.deviationPct - b.deviationPct;
});
// Minified, not pretty-printed — this file is only ever machine-read (by
// /api/lynch-ranking, streamed straight to the browser), and the 2-space
// indentation was inflating an already-large (~3800 rows) payload by ~30%
// for no benefit.
fs.writeFileSync(
  path.join(CACHE_DIR, '_lynch_ranking.json'),
  JSON.stringify({ asOf: new Date().toISOString().slice(0, 10), count: ranking.length, ranking }),
);
console.log(`Lynch ranking: ${ranking.length} codes ranked, saved to ${path.join(CACHE_DIR, '_lynch_ranking.json')}`);
