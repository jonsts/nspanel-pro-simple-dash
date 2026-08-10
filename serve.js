#!/usr/bin/env node
// Dev server replacing Docker: serves static files, handles config API, proxies /api/ to HA.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const HA_URL = (process.env.HA_URL || 'http://homeassistant.local:8123').replace(/\/$/, '');
const DATA_DIR = path.join(__dirname, 'data');
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

fs.mkdirSync(DATA_DIR, { recursive: true });

function dataFile(name) { return path.join(DATA_DIR, name); }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function body(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', d => buf += d);
    req.on('end', () => resolve(buf));
  });
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
}

async function handleConfigApi(req, res) {
  const url = new URL(req.url, `http://localhost`);
  const p = url.searchParams.get('path') || '';
  const method = req.method;

  res.setHeader('Content-Type', 'application/json');
  setCors(res);

  const globalFile = dataFile('global_config.json');
  const roomsFile = dataFile('room_configs.json');

  if (!fs.existsSync(globalFile)) fs.writeFileSync(globalFile, JSON.stringify({ haUrl: '', haToken: '' }));
  if (!fs.existsSync(roomsFile)) fs.writeFileSync(roomsFile, JSON.stringify([]));

  if (p === 'global') {
    if (method === 'GET') {
      res.end(fs.readFileSync(globalFile, 'utf8'));
    } else if (method === 'POST') {
      const data = JSON.parse(await body(req));
      fs.writeFileSync(globalFile, JSON.stringify(data, null, 2));
      res.end(JSON.stringify({ success: true }));
    }
  } else if (p === 'rooms') {
    if (method === 'GET') {
      res.end(fs.readFileSync(roomsFile, 'utf8'));
    } else if (method === 'POST') {
      const data = JSON.parse(await body(req));
      fs.writeFileSync(roomsFile, JSON.stringify(data, null, 2));
      res.end(JSON.stringify({ success: true }));
    }
  } else if (p === 'room') {
    const roomName = url.searchParams.get('name') || '';
    let rooms = readJson(roomsFile, []);
    if (method === 'GET') {
      const room = rooms.find(r => r.roomName === roomName);
      res.end(JSON.stringify(room || { error: 'Room not found' }));
    } else if (method === 'POST') {
      const newRoom = JSON.parse(await body(req));
      const idx = rooms.findIndex(r => r.roomName === roomName);
      if (idx >= 0) rooms[idx] = newRoom; else rooms.push(newRoom);
      fs.writeFileSync(roomsFile, JSON.stringify(rooms, null, 2));
      res.end(JSON.stringify({ success: true }));
    } else if (method === 'DELETE') {
      rooms = rooms.filter(r => r.roomName !== roomName);
      fs.writeFileSync(roomsFile, JSON.stringify(rooms, null, 2));
      res.end(JSON.stringify({ success: true }));
    }
  } else if (p === 'active_room') {
    const deviceId = url.searchParams.get('device') || 'default';
    const activeFile = dataFile(`active_room_${deviceId}.txt`);
    if (method === 'GET') {
      const roomName = fs.existsSync(activeFile) ? fs.readFileSync(activeFile, 'utf8').trim() : null;
      res.end(JSON.stringify({ roomName }));
    } else if (method === 'POST') {
      const data = JSON.parse(await body(req));
      fs.writeFileSync(activeFile, data.roomName);
      res.end(JSON.stringify({ success: true }));
    }
  } else if (p === 'voice_messages') {
    const vmFile = dataFile('voice_messages.json');
    if (!fs.existsSync(vmFile)) fs.writeFileSync(vmFile, JSON.stringify([]));
    if (method === 'GET') {
      res.end(fs.readFileSync(vmFile, 'utf8'));
    } else if (method === 'POST') {
      const data = JSON.parse(await body(req));
      fs.writeFileSync(vmFile, JSON.stringify(data, null, 2));
      res.end(JSON.stringify({ success: true }));
    }
  } else {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not found' }));
  }
}

function proxyToHA(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const targetUrl = HA_URL + req.url;
  const parsed = new URL(targetUrl);
  const lib = parsed.protocol === 'https:' ? https : http;

  const headers = { ...req.headers, host: parsed.host };
  delete headers['content-length']; // let Node recalculate

  const proxyReq = lib.request(
    { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + (parsed.search || ''), method: req.method, headers },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', (e) => {
    console.error('HA proxy error:', e.message);
    res.statusCode = 502;
    res.end(JSON.stringify({ error: 'Could not reach Home Assistant', detail: e.message }));
  });

  req.pipe(proxyReq);
}

function serveStatic(req, res) {
  const urlPath = req.url.split('?')[0];
  const filePath = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);

  if (!filePath.startsWith(ROOT)) {
    res.statusCode = 403;
    res.end();
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];

  try {
    if (req.method === 'OPTIONS') { setCors(res); res.statusCode = 204; res.end(); return; }
    if (urlPath === '/config-api.php') { await handleConfigApi(req, res); return; }
    if (urlPath.startsWith('/api/')) { proxyToHA(req, res); return; }
    serveStatic(req, res);
  } catch (e) {
    console.error(e);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => {
  console.log(`NSPanel dash running at http://localhost:${PORT}`);
  console.log(`Proxying /api/ to ${HA_URL}`);
  console.log(`Config data stored in ./data/`);
});
