// Servidor de sinalização embutido: roda no PC de quem clica em "Hospedar".
// Só troca mensagens pequenas (ofertas WebRTC, estados). O vídeo vai direto entre os PCs.
const http = require('http');
const { WebSocketServer } = require('ws');

function createSignalingServer(port) {
  const members = new Map(); // id -> { ws, name }
  let nextId = 1;

  const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Tela Amigos - servidor de sala');
  });
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    let id = null;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === 'join' && !id) {
        id = String(nextId++);
        const name = String(msg.name || 'Anônimo').slice(0, 30);
        send(ws, { type: 'welcome', id, peers: [...members].map(([pid, m]) => ({ id: pid, name: m.name })) });
        for (const [, m] of members) send(m.ws, { type: 'peer-joined', id, name });
        members.set(id, { ws, name });
        return;
      }
      if (!id) return;

      if (msg.type === 'relay') {
        const out = { type: 'relay', from: id, data: msg.data };
        if (msg.to) {
          const t = members.get(String(msg.to));
          if (t) send(t.ws, out);
        } else {
          for (const [pid, m] of members) if (pid !== id) send(m.ws, out);
        }
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

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      resolve({
        close() {
          clearInterval(ping);
          for (const ws of wss.clients) ws.terminate();
          wss.close();
          server.close();
        },
      });
    });
  });
}

module.exports = { createSignalingServer };
