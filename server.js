const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT_DIR = __dirname;
const BARS_DIR = path.join(ROOT_DIR, 'bars');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const POSITIONS_DIR = path.join(ROOT_DIR, 'positions');
const CODE_RE = /^\d{4}$/;
const MAX_BODY_BYTES = 64 * 1024;

fs.mkdirSync(POSITIONS_DIR, { recursive: true });

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
        const lot = {
          id: genLotId(),
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
        const lots = loadPositions(code);
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
