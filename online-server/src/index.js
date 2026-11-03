// Sala online do Tela Amigos (Cloudflare Worker + Durable Object): o mesmo protocolo da sala do
// Radmin (src/signaling.js), mas sem precisar de VPN. Só passam mensagens pequenas (ofertas WebRTC,
// estados, chat); o vídeo vai direto entre os PCs (ou pelo TURN, se configurado).
// Cada código de sala é um Durable Object: todos que entram com o mesmo código caem no mesmo.
const MAX_MEMBERS = 12;
const GRACE_MS = 20000;            // quem cai tem 20 s para voltar sem os outros perceberem
const IDLE_MS = 30000;             // sem nenhuma mensagem (o app manda ping a cada 5 s): desconecta
const CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
const STUN = [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:stun.l.google.com:19302' }];

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/') return json({ app: 'tela-amigos-online', ok: true });
    const m = url.pathname.match(/^\/sala\/([A-Za-z0-9]{6})$/);
    if (!m) return json({ error: 'não encontrado' }, 404);
    const code = m[1].toUpperCase();
    if (!CODE_RE.test(code)) return json({ error: 'código inválido' }, 400);
    if (req.headers.get('Upgrade') === 'websocket') {
      // só o app (página file://) ou clientes sem Origin; um site aberto no navegador não entra
      const origin = req.headers.get('Origin');
      if (origin && origin !== 'file://' && origin !== 'null') return json({ error: 'proibido' }, 403);
    }
    return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(req);
  },
};

export class Room {
  constructor(state, env) {
    this.env = env;
    this.members = new Map(); // id -> { ws, name, token, grace, seen }
    this.nextId = 1;
    this.ice = null;          // { list, until }
    this.sweeper = null;
  }

  async fetch(req) {
    if (req.headers.get('Upgrade') !== 'websocket') {
      return json({ app: 'tela-amigos', members: this.members.size, names: [...this.members.values()].map((m) => m.name) });
    }
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    this.handle(server);
    if (!this.sweeper) this.sweeper = setInterval(() => this.sweep(), 10000);
    return new Response(null, { status: 101, webSocket: client });
  }

  send(ws, msg) { try { ws.send(JSON.stringify(msg)); } catch {} }

  // STUN sempre; TURN (Cloudflare Realtime) só se as chaves estiverem configuradas
  async iceServers() {
    const now = Date.now();
    if (this.ice && this.ice.until > now) return this.ice.list;
    let list = STUN;
    const { TURN_KEY_ID: id, TURN_KEY_API_TOKEN: token } = this.env;
    if (id && token) {
      try {
        const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${id}/credentials/generate-ice-servers`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ttl: 86400 }),
        });
        if (r.ok) {
          const d = await r.json();
          const got = Array.isArray(d.iceServers) ? d.iceServers : d.iceServers ? [d.iceServers] : [];
          if (got.length) list = [...STUN, ...got.filter((s) => s.username)];
        }
      } catch {}
    }
    this.ice = { list, until: now + 3600000 }; // credenciais valem 24 h; renova a cada hora
    return list;
  }

  handle(ws) {
    let id = null, joining = false;
    let seen = Date.now();
    ws.addEventListener('message', async (ev) => {
      seen = Date.now();
      if (id && this.members.get(id) && this.members.get(id).ws === ws) this.members.get(id).seen = seen;
      if (typeof ev.data !== 'string' || ev.data.length > 64 * 1024) return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;

      if (msg.type === 'ping') { this.send(ws, { type: 'pong' }); return; }
      if (msg.type === 'leave') { ws.leaving = true; try { ws.close(1000, 'saiu'); } catch {} this.onClose(ws, id); return; }

      if (msg.type === 'join' && !id && !joining) {
        joining = true;
        const peersOf = (me) => [...this.members].filter(([pid]) => pid !== me).map(([pid, m]) => ({ id: pid, name: m.name }));
        const ice = await this.iceServers();
        // voltando depois de uma queda: retoma o mesmo lugar (os outros não veem sair/entrar)
        const r = msg.resume;
        const old = r && this.members.get(String(r.id));
        if (old && old.token === r.token) {
          id = String(r.id);
          clearTimeout(old.grace);
          old.grace = null;
          if (old.ws !== ws) { try { old.ws.close(1000, 'substituída'); } catch {} }
          old.ws = ws; old.seen = seen;
          this.send(ws, { type: 'welcome', id, token: old.token, resumed: true, peers: peersOf(id), ice, online: true });
          return;
        }
        if (this.members.size >= MAX_MEMBERS) { this.send(ws, { type: 'error', message: 'Sala cheia' }); try { ws.close(1000, 'cheia'); } catch {} return; }
        id = String(this.nextId++);
        const name = String(msg.name || 'Anônimo').slice(0, 30);
        const token = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');
        this.send(ws, { type: 'welcome', id, token, peers: peersOf(id), ice, online: true });
        for (const [, m] of this.members) this.send(m.ws, { type: 'peer-joined', id, name });
        this.members.set(id, { ws, name, token, grace: null, seen });
        return;
      }
      if (!id) return;

      if (msg.type === 'relay' && msg.data && typeof msg.data === 'object') {
        const out = { type: 'relay', from: id, data: msg.data };
        if (msg.to) {
          const t = this.members.get(String(msg.to));
          if (t) this.send(t.ws, out);
        } else {
          for (const [pid, m] of this.members) if (pid !== id) this.send(m.ws, out);
        }
      }
    });
    ws.addEventListener('close', () => this.onClose(ws, id));
    ws.addEventListener('error', () => this.onClose(ws, id));
  }

  onClose(ws, id) {
    if (!id) return;
    const m = this.members.get(id);
    if (!m || m.ws !== ws || m.grace) return; // já foi substituída por uma reconexão
    if (ws.leaving) return this.remove(id);    // saiu de propósito ("Sair")
    m.grace = setTimeout(() => this.remove(id), GRACE_MS);
  }

  remove(id) {
    const m = this.members.get(id);
    if (!m) return;
    clearTimeout(m.grace);
    this.members.delete(id);
    for (const [, o] of this.members) this.send(o.ws, { type: 'peer-left', id });
    if (!this.members.size && this.sweeper) { clearInterval(this.sweeper); this.sweeper = null; }
  }

  // conexão "fantasma" (PC desligou sem fechar): fecha e dá o tempo de volta
  sweep() {
    const now = Date.now();
    for (const [id, m] of this.members) {
      if (!m.grace && now - (m.seen || 0) > IDLE_MS) {
        try { m.ws.close(1001, 'sem resposta'); } catch {}
        this.onClose(m.ws, id);
      }
    }
  }
}
