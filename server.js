const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT_DIR = __dirname;
const BARS_DIR = path.join(ROOT_DIR, 'bars');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const POSITIONS_DIR = path.join(ROOT_DIR, 'positions');
const DIVIDEND_POSITIONS_DIR = path.join(ROOT_DIR, 'dividend_positions');
const CODE_RE = /^\d{4}$/;
const MAX_BODY_BYTES = 64 * 1024;

fs.mkdirSync(POSITIONS_DIR, { recursive: true });
fs.mkdirSync(DIVIDEND_POSITIONS_DIR, { recursive: true });

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function methodNotAllowed(res) {
  res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Method Not Allowed');
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('malformed JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function sendStaticFile(res, filePath) {
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

// master.json (~2MB) is cached in memory and reloaded only when the file changes on disk.
let masterCache = { mtimeMs: 0, byCode: new Map() };

function loadMaster() {
  const masterPath = path.join(BARS_DIR, 'master.json');
  let stat;
  try {
    stat = fs.statSync(masterPath);
  } catch {
    return new Map();
  }
  if (stat.mtimeMs === masterCache.mtimeMs) {
    return masterCache.byCode;
  }
  const raw = JSON.parse(fs.readFileSync(masterPath, 'utf8'));
  const byCode = new Map();
  for (const row of raw.data || []) {
    // Master codes are 5 digits (4-digit ticker + trailing check digit).
    const code4 = String(row.Code).slice(0, 4);
    byCode.set(code4, row);
  }
  masterCache = { mtimeMs: stat.mtimeMs, byCode };
  return byCode;
}

function listSymbols() {
  const master = loadMaster();
  const files = fs.readdirSync(BARS_DIR);
  const symbols = [];
  for (const file of files) {
    const match = file.match(/^(\d{4})\.json$/);
    if (!match) continue;
    const code = match[1];
    const info = master.get(code);
    const bars = loadBars(code);
    symbols.push({
      code,
      name: info ? info.CoName : code,
      nameEn: info ? info.CoNameEn : '',
      market: info ? info.MktNm : '',
      sector: info ? info.S33Nm : '',
      lastClose: bars && bars.length ? bars[bars.length - 1].close : null,
    });
  }
  symbols.sort((a, b) => a.code.localeCompare(b.code));
  return symbols;
}

function loadBars(code) {
  const barsPath = path.join(BARS_DIR, `${code}.json`);
  if (!fs.existsSync(barsPath)) return null;
  const raw = JSON.parse(fs.readFileSync(barsPath, 'utf8'));
  const rows = (raw.data || [])
    .slice()
    .sort((a, b) => (a.Date < b.Date ? -1 : a.Date > b.Date ? 1 : 0));
  return rows.map((row) => ({
    time: row.Date,
    open: row.AdjO,
    high: row.AdjH,
    low: row.AdjL,
    close: row.AdjC,
    volume: row.AdjVo,
  }));
}

// --- correlation ranking: Pearson correlation of daily returns between the
// selected symbol and every other symbol with bars on disk ---

const MIN_CORRELATION_SAMPLE = 30; // fewer overlapping trading days than this and the estimate is too noisy to trust

// Keyed by date rather than array index, since two symbols' bars aren't
// guaranteed to share an identical trading calendar (different listing
// dates, market-specific holidays) — alignment must be done by date.
function dailyReturnsByDate(bars) {
  const map = new Map();
  for (let i = 1; i < bars.length; i++) {
    map.set(bars[i].time, bars[i].close / bars[i - 1].close - 1);
  }
  return map;
}

function pearsonCorrelation(xs, ys) {
  const n = xs.length;
  if (n === 0) return null;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  if (varX === 0 || varY === 0) return null; // a constant return series has undefined correlation
  return cov / Math.sqrt(varX * varY);
}

// Returns null if the base symbol itself has no bars; otherwise a ranking
// (sorted by |correlation| descending) of every other symbol with enough
// overlapping trading days, using full-history daily-return correlation —
// not a rolling window, since this is a one-shot ranking, not a trend.
function computeCorrelations(baseCode) {
  const baseBars = loadBars(baseCode);
  if (!baseBars) return null;
  const baseReturns = dailyReturnsByDate(baseBars);
  const master = loadMaster();
  const files = fs.readdirSync(BARS_DIR);
  const rankings = [];
  for (const file of files) {
    const match = file.match(/^(\d{4})\.json$/);
    if (!match) continue;
    const code = match[1];
    if (code === baseCode) continue;
    const bars = loadBars(code);
    if (!bars) continue;
    const returns = dailyReturnsByDate(bars);
    const xs = [];
    const ys = [];
    for (const [date, baseValue] of baseReturns) {
      if (returns.has(date)) {
        xs.push(baseValue);
        ys.push(returns.get(date));
      }
    }
    if (xs.length < MIN_CORRELATION_SAMPLE) continue;
    const correlation = pearsonCorrelation(xs, ys);
    if (correlation === null) continue;
    const info = master.get(code);
    rankings.push({
      code,
      name: info ? info.CoName : code,
      sector: info ? info.S33Nm : '',
      correlation,
      sampleSize: xs.length,
    });
  }
  rankings.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
  return rankings;
}

// --- screener: per-symbol trend/volatility metrics for swing-trade candidate
// selection. No thresholds are applied here — every symbol with enough
// history gets a full metrics row, and the client filters/sorts locally so
// adjusting a threshold never needs a re-fetch. ---

const SCREENER_SMA_PERIODS = [5, 25, 75, 200];
const SLOPE_REGRESSION_WINDOW = 10; // trailing SMA points used to fit the slope
const SCREENER_MIN_BARS = 210; // SMA200 + slope window, with room to spare for the 60d vol baseline
const VOL_RECENT_WINDOW = 20;
const VOL_BASELINE_WINDOW = 60;

function computeSMASeries(bars, period) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].close;
    if (i >= period) sum -= bars[i - period].close;
    if (i >= period - 1) out.push(sum / period);
  }
  return out;
}

// Least-squares slope of evenly-spaced points (x = 0..n-1) — used on the
// tail of an SMA series so a single noisy day can't flip the sign the way a
// plain two-point difference would.
function linearRegressionSlope(ys) {
  const n = ys.length;
  if (n < 2) return 0;
  const xMean = (n - 1) / 2;
  const yMean = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - xMean;
    num += dx * (ys[i] - yMean);
    den += dx * dx;
  }
  return den === 0 ? 0 : num / den;
}

function stdDevPct(returns) {
  const n = returns.length;
  if (n === 0) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const variance = returns.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
  return Math.sqrt(variance) * 100;
}

function pctChange(bars, daysAgo) {
  const n = bars.length;
  if (n <= daysAgo) return null;
  const from = bars[n - 1 - daysAgo].close;
  const to = bars[n - 1].close;
  return from === 0 ? null : ((to / from) - 1) * 100;
}

function computeScreenerMetrics() {
  const master = loadMaster();
  const files = fs.readdirSync(BARS_DIR);
  const rows = [];
  for (const file of files) {
    const match = file.match(/^(\d{4})\.json$/);
    if (!match) continue;
    const code = match[1];
    const bars = loadBars(code);
    if (!bars || bars.length < SCREENER_MIN_BARS) continue;

    const close = bars[bars.length - 1].close;
    const sma = {};
    for (const period of SCREENER_SMA_PERIODS) {
      const series = computeSMASeries(bars, period);
      const value = series[series.length - 1];
      const tail = series.slice(-SLOPE_REGRESSION_WINDOW);
      const slope = linearRegressionSlope(tail);
      sma[period] = { value, slopePct: value ? (slope / value) * 100 : 0 };
    }

    const orderChain = [close, sma[5].value, sma[25].value, sma[75].value, sma[200].value];
    let orderScore = 0;
    for (let i = 0; i < orderChain.length - 1; i++) {
      if (orderChain[i] > orderChain[i + 1]) orderScore++;
    }

    const returns = [];
    for (let i = 1; i < bars.length; i++) returns.push(bars[i].close / bars[i - 1].close - 1);
    const volRecentPct = stdDevPct(returns.slice(-VOL_RECENT_WINDOW));
    const volBaselinePct = stdDevPct(returns.slice(-VOL_BASELINE_WINDOW));
    const volRatio = volRecentPct !== null && volBaselinePct ? volRecentPct / volBaselinePct : null;

    const info = master.get(code);
    rows.push({
      code,
      name: info ? info.CoName : code,
      sector: info ? info.S33Nm : '',
      market: info ? info.MktNm : '',
      lastClose: close,
      sma,
      perfectOrder: orderScore === 4,
      orderScore,
      chg5d: pctChange(bars, 5),
      chg20d: pctChange(bars, 20),
      volRecentPct,
      volBaselinePct,
      volRatio,
    });
  }
  rows.sort((a, b) => a.code.localeCompare(b.code));
  return rows;
}

// --- positions (建玉) storage: one JSON file per symbol code, user-writable ---

function positionsPath(code) {
  return path.join(POSITIONS_DIR, `${code}.json`);
}

function loadPositions(code) {
  try {
    const raw = JSON.parse(fs.readFileSync(positionsPath(code), 'utf8'));
    return raw.data || [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

function savePositions(code, lots) {
  fs.writeFileSync(positionsPath(code), JSON.stringify({ data: lots }, null, 2));
}

function genLotId() {
  return `l_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// --- dividend-purpose holdings (配当目的の保有): a separate holdings store
// from positions/ above, since portfolio/simulation/stats are all short-term
// trading views while the dividends screen tracks its own code+quantity
// independent of any trading lots. Same per-code file shape as positions/,
// minus the P&L-only fields (buyPrice/buyDate/settled/sellDate/sellPrice)
// that don't apply here. ---

function dividendPositionsPath(code) {
  return path.join(DIVIDEND_POSITIONS_DIR, `${code}.json`);
}

function loadDividendPositions(code) {
  try {
    const raw = JSON.parse(fs.readFileSync(dividendPositionsPath(code), 'utf8'));
    return raw.data || [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

function saveDividendPositions(code, lots) {
  fs.writeFileSync(dividendPositionsPath(code), JSON.stringify({ data: lots }, null, 2));
}

function genDividendPositionId() {
  return `dp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Short, human-readable sequence number shown on the lot card and used as the
// waterfall chart's X-axis label — distinct from the opaque storage `id`.
function nextSeq(lots) {
  let max = 0;
  for (const l of lots) if (typeof l.seq === 'number' && l.seq > max) max = l.seq;
  return max + 1;
}

// --- settings: user-adjustable UI parameters (e.g. the stats screen's SMA
// period / VaR confidence / VaR window), persisted as one flat JSON file so
// they're restored on the next visit instead of resetting to defaults ---

const SETTINGS_PATH = path.join(ROOT_DIR, 'settings.json');
const SETTINGS_SECTION_RE = /^[a-zA-Z0-9_-]+$/;

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

// --- dividends: computed (not user-entered) from bars/<code>_finance_summary.json,
// which jquants_api.py fetches alongside price bars. There is no way to know the
// exact dividend for the current fiscal year, so this is a provisional estimate:
// look at the single most-recently-disclosed report and prefer, in order, the
// confirmed full-year total (DivAnn), then the sum of whatever quarterly actuals
// are known so far (Div1Q/Div2Q/Div3Q/DivFY), then the sum of forecast quarters
// (FDiv1Q/FDiv2Q/FDiv3Q/FDivFY). ---

const DIV_ACTUAL_QUARTER_FIELDS = ['Div1Q', 'Div2Q', 'Div3Q', 'DivFY'];
const DIV_FORECAST_QUARTER_FIELDS = ['FDiv1Q', 'FDiv2Q', 'FDiv3Q', 'FDivFY'];

function loadFinanceSummary(code) {
  const summaryPath = path.join(BARS_DIR, `${code}_finance_summary.json`);
  try {
    const parsed = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    return Array.isArray(parsed.data) ? parsed.data : null;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function toDivNumber(value) {
  const n = Number(value);
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(n) ? n : null;
}

function sumDivFields(record, fields) {
  return fields.reduce((sum, field) => {
    const n = toDivNumber(record[field]);
    return n === null ? sum : sum + n;
  }, 0);
}

function computeDividendForCode(code) {
  const records = loadFinanceSummary(code);
  if (!records || !records.length) return null;

  const today = new Date().toISOString().slice(0, 10);
  const pastOrToday = records.filter((r) => r.DiscDate && r.DiscDate <= today);
  const record = pastOrToday.length
    ? pastOrToday.reduce((latest, r) => (r.DiscDate > latest.DiscDate ? r : latest))
    : records[records.length - 1];

  const divAnn = toDivNumber(record.DivAnn);
  if (divAnn !== null && divAnn > 0) {
    return { perShare: divAnn, source: 'actual_annual', asOf: record.DiscDate };
  }

  const actualSum = sumDivFields(record, DIV_ACTUAL_QUARTER_FIELDS);
  if (actualSum > 0) {
    return { perShare: actualSum, source: 'actual_quarters', asOf: record.DiscDate };
  }

  const forecastSum = sumDivFields(record, DIV_FORECAST_QUARTER_FIELDS);
  if (forecastSum > 0) {
    return { perShare: forecastSum, source: 'forecast_quarters', asOf: record.DiscDate };
  }

  return null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validatePriceFields(body, priceKey, dateKey) {
  const price = Number(body[priceKey]);
  const date = body[dateKey];
  if (!Number.isFinite(price) || price <= 0) return `invalid ${priceKey}`;
  if (typeof date !== 'string' || !DATE_RE.test(date)) return `invalid ${dateKey}`;
  return null;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (pathname === '/api/symbols') {
    if (req.method !== 'GET') return methodNotAllowed(res);
    try {
      sendJson(res, 200, listSymbols());
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  const barsMatch = pathname.match(/^\/api\/bars\/(.+)$/);
  if (barsMatch) {
    if (req.method !== 'GET') return methodNotAllowed(res);
    const code = barsMatch[1];
    if (!CODE_RE.test(code)) {
      sendJson(res, 400, { error: 'invalid code' });
      return;
    }
    try {
      const bars = loadBars(code);
      if (!bars) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      const master = loadMaster();
      const info = master.get(code);
      sendJson(res, 200, {
        code,
        name: info ? info.CoName : code,
        nameEn: info ? info.CoNameEn : '',
        market: info ? info.MktNm : '',
        sector: info ? info.S33Nm : '',
        bars,
      });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  const correlationsMatch = pathname.match(/^\/api\/correlations\/([^/]+)$/);
  if (correlationsMatch) {
    if (req.method !== 'GET') return methodNotAllowed(res);
    const code = correlationsMatch[1];
    if (!CODE_RE.test(code)) {
      sendJson(res, 400, { error: 'invalid code' });
      return;
    }
    try {
      const rankings = computeCorrelations(code);
      if (rankings === null) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      const baseInfo = loadMaster().get(code);
      sendJson(res, 200, { code, sector: baseInfo ? baseInfo.S33Nm : '', rankings });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (pathname === '/api/screener') {
    if (req.method !== 'GET') return methodNotAllowed(res);
    try {
      sendJson(res, 200, { symbols: computeScreenerMetrics() });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (pathname === '/api/settings') {
    if (req.method !== 'GET') return methodNotAllowed(res);
    try {
      sendJson(res, 200, loadSettings());
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  const settingsSectionMatch = pathname.match(/^\/api\/settings\/([^/]+)$/);
  if (settingsSectionMatch) {
    const [, section] = settingsSectionMatch;
    if (!SETTINGS_SECTION_RE.test(section)) {
      sendJson(res, 400, { error: 'invalid section' });
      return;
    }
    if (req.method === 'PUT') {
      readJsonBody(req).then((body) => {
        const settings = loadSettings();
        settings[section] = body;
        saveSettings(settings);
        sendJson(res, 200, { [section]: body });
      }).catch((err) => sendJson(res, err.status || 400, { error: err.message }));
      return;
    }
    return methodNotAllowed(res);
  }

  if (pathname === '/api/dividends') {
    if (req.method !== 'GET') return methodNotAllowed(res);
    try {
      const dividends = {};
      for (const sym of listSymbols()) {
        const div = computeDividendForCode(sym.code);
        if (div) dividends[sym.code] = div;
      }
      sendJson(res, 200, dividends);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (pathname === '/api/dividend-positions') {
    if (req.method !== 'GET') return methodNotAllowed(res);
    try {
      const files = fs.readdirSync(DIVIDEND_POSITIONS_DIR);
      const positions = {};
      for (const file of files) {
        const match = file.match(/^(\d{4})\.json$/);
        if (!match) continue;
        const code = match[1];
        const lots = loadDividendPositions(code);
        if (lots.length) positions[code] = lots;
      }
      sendJson(res, 200, { positions });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  const dividendPositionsCodeMatch = pathname.match(/^\/api\/dividend-positions\/([^/]+)$/);
  if (dividendPositionsCodeMatch) {
    const [, code] = dividendPositionsCodeMatch;
    if (!CODE_RE.test(code)) {
      sendJson(res, 400, { error: 'invalid code' });
      return;
    }
    if (req.method === 'PUT') {
      readJsonBody(req).then((body) => {
        const quantity = Number(body.quantity);
        if (!Number.isFinite(quantity) || quantity <= 0) {
          return sendJson(res, 400, { error: 'invalid quantity' });
        }
        const now = new Date().toISOString();
        const lots = loadDividendPositions(code);
        const lot = lots[0] || { id: genDividendPositionId(), code, createdAt: now };
        lot.quantity = quantity;
        lot.updatedAt = now;
        saveDividendPositions(code, [lot]);
        sendJson(res, 200, { lot });
      }).catch((err) => sendJson(res, err.status || 400, { error: err.message }));
      return;
    }
    if (req.method === 'DELETE') {
      const lots = loadDividendPositions(code);
      if (!lots.length) return sendJson(res, 404, { error: 'not found' });
      saveDividendPositions(code, []);
      sendJson(res, 200, { deleted: true, code });
      return;
    }
    return methodNotAllowed(res);
  }

  if (pathname === '/api/positions') {
    if (req.method !== 'GET') return methodNotAllowed(res);
    try {
      const files = fs.readdirSync(POSITIONS_DIR);
      const positions = {};
      for (const file of files) {
        const match = file.match(/^(\d{4})\.json$/);
        if (!match) continue;
        const code = match[1];
        const lots = loadPositions(code);
        if (lots.length) positions[code] = lots;
      }
      sendJson(res, 200, { positions });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  const positionsItemMatch = pathname.match(/^\/api\/positions\/([^/]+)\/([^/]+)$/);
  if (positionsItemMatch) {
    const [, code, id] = positionsItemMatch;
    if (!CODE_RE.test(code)) {
      sendJson(res, 400, { error: 'invalid code' });
      return;
    }
    if (req.method === 'PATCH') {
      readJsonBody(req).then((body) => {
        const err = validatePriceFields(body, 'sellPrice', 'sellDate');
        if (err) return sendJson(res, 400, { error: err });
        const lots = loadPositions(code);
        const lot = lots.find((l) => l.id === id);
        if (!lot) return sendJson(res, 404, { error: 'not found' });
        lot.settled = true;
        lot.sellPrice = Number(body.sellPrice);
        lot.sellDate = body.sellDate;
        lot.updatedAt = new Date().toISOString();
        savePositions(code, lots);
        sendJson(res, 200, { lot });
      }).catch((err) => sendJson(res, err.status || 400, { error: err.message }));
      return;
    }
    if (req.method === 'DELETE') {
      const lots = loadPositions(code);
      const next = lots.filter((l) => l.id !== id);
      if (next.length === lots.length) return sendJson(res, 404, { error: 'not found' });
      savePositions(code, next);
      sendJson(res, 200, { deleted: true, id });
      return;
    }
    return methodNotAllowed(res);
  }

  const positionsMatch = pathname.match(/^\/api\/positions\/([^/]+)$/);
  if (positionsMatch) {
    const code = positionsMatch[1];
    if (!CODE_RE.test(code)) {
      sendJson(res, 400, { error: 'invalid code' });
      return;
    }
    if (req.method === 'GET') {
      try {
        sendJson(res, 200, { code, lots: loadPositions(code) });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return;
    }
    if (req.method === 'POST') {
      readJsonBody(req).then((body) => {
        const err = validatePriceFields(body, 'buyPrice', 'buyDate');
        if (err) return sendJson(res, 400, { error: err });
        const quantity = Number(body.quantity);
        if (!Number.isFinite(quantity) || quantity <= 0) {
          return sendJson(res, 400, { error: 'invalid quantity' });
        }
        const now = new Date().toISOString();
        const lots = loadPositions(code);
        const lot = {
          id: genLotId(),
          seq: nextSeq(lots),
          code,
          buyDate: body.buyDate,
          buyPrice: Number(body.buyPrice),
          quantity,
          settled: false,
          sellDate: null,
          sellPrice: null,
          createdAt: now,
          updatedAt: now,
        };
        lots.push(lot);
        savePositions(code, lots);
        sendJson(res, 201, { lot });
      }).catch((err) => sendJson(res, err.status || 400, { error: err.message }));
      return;
    }
    return methodNotAllowed(res);
  }

  // Static files, defaulting to index.html.
  if (req.method !== 'GET') return methodNotAllowed(res);
  let relPath = pathname === '/' ? '/index.html' : pathname;
  relPath = path.normalize(relPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, relPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  sendStaticFile(res, filePath);
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
