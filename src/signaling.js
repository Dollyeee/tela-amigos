// Servidor da sala: só troca mensagens pequenas (ofertas WebRTC, estados). O vídeo vai direto
// entre os PCs. Roda num processo próprio em segundo plano (room-server.js), então a sala
// continua aberta mesmo se quem hospeda fechar/reiniciar o app.
const http = require('http');
const { WebSocketServer } = require('ws');

const MAX_MEMBERS = 12;

// Só VPNs de jogo (Radmin 26.x, Hamachi 25.x, Tailscale 100.64/10), rede local e o próprio PC.
function allowedAddress(addr) {
  const a = String(addr || '').replace(/^::ffff:/, '');
  if (a === '::1' || a.startsWith('127.')) return true;
  const p = a.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !(n >= 0 && n <= 255))) return false;
  return p[0] === 26 || p[0] === 25 || p[0] === 10 ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31);
}

function isLocal(addr) {
  const a = String(addr || '').replace(/^::ffff:/, '');
  return a === '::1' || a.startsWith('127.');
}

function createSignalingServer(port, { onShutdown } = {}) {
  const members = new Map(); // id -> { ws, name }
  let nextId = 1;
  const startedAt = Date.now();

  const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };

  const server = http.createServer((req, res) => {
    const addr = req.socket.remoteAddress;
    // o app de quem hospeda consulta / fecha a sala por aqui (só do próprio PC)
    if (req.url === '/shutdown' && isLocal(addr)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      for (const [, m] of members) send(m.ws, { type: 'room-closed' });
      setTimeout(() => { close(); if (onShutdown) onShutdown(); }, 200);
      return;
    }
    if (!allowedAddress(addr)) { res.writeHead(403); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      app: 'tela-amigos',
      members: members.size,
      names: [...members.values()].map((m) => m.name),
      uptime: Math.round((Date.now() - startedAt) / 1000),
    }));
  });

  const wss = new WebSocketServer({
    server,
    maxPayload: 64 * 1024,
    verifyClient: (info) => allowedAddress(info.req.socket.remoteAddress),
  });

  wss.on('connection', (ws) => {
    let id = null;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', () => {});

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;

        if (msg.type === 'ping') { send(ws, { type: 'pong' }); return; }

        if (msg.type === 'join' && !id) {
          if (members.size >= MAX_MEMBERS) { send(ws, { type: 'error', message: 'Sala cheia' }); ws.close(); return; }
          id = String(nextId++);
          const name = String(msg.name || 'Anônimo').slice(0, 30);
          send(ws, { type: 'welcome', id, peers: [...members].map(([pid, m]) => ({ id: pid, name: m.name })) });
          for (const [, m] of members) send(m.ws, { type: 'peer-joined', id, name });
          members.set(id, { ws, name });
          return;
        }
        if (!id) return;

        if (msg.type === 'relay' && msg.data && typeof msg.data === 'object') {
          const out = { type: 'relay', from: id, data: msg.data };
          if (msg.to) {
            const t = members.get(String(msg.to));
            if (t) send(t.ws, out);
          } else {
            for (const [pid, m] of members) if (pid !== id) send(m.ws, out);
          }
        }
      } catch {
        // mensagem inválida: ignora (nunca derruba o servidor)
      }
    });

    ws.on('close', () => {
      if (!id) return;
      members.delete(id);
      for (const [, m] of members) send(m.ws, { type: 'peer-left', id });
    });
  });

  const ping = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 15000);

  function close() {
    clearInterval(ping);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    server.close();
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve({
      close,
      info: () => ({ members: members.size, names: [...members.values()].map((m) => m.name) }),
    }));
  });
}

module.exports = { createSignalingServer, allowedAddress };
