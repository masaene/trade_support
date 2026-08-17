const http = require('http');
const os = require('os');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.url !== '/' || req.method !== 'GET') {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>Node.js Sample App</title>
  <style>
    body { font-family: sans-serif; margin: 4rem auto; max-width: 640px; padding: 0 1rem; }
    h1 { color: #2c7a2c; }
    dl { display: grid; grid-template-columns: auto 1fr; gap: 0.25rem 1rem; }
    dt { font-weight: bold; }
  </style>
</head>
<body>
  <h1>Hello from Node.js</h1>
  <p>このページはsystemdで常時起動しているNode.jsサンプルアプリです。</p>
  <dl>
    <dt>Hostname</dt><dd>${os.hostname()}</dd>
    <dt>Node.js Version</dt><dd>${process.version}</dd>
    <dt>Uptime</dt><dd>${Math.floor(process.uptime())} 秒</dd>
    <dt>Server Time</dt><dd>${new Date().toISOString()}</dd>
  </dl>
</body>
</html>
`;

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
