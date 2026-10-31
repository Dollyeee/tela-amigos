// Ponte entre o app e o AudioHelper.exe (captura de áudio por processo do Windows).
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

function helperPath() {
  const candidates = [
    path.join(process.resourcesPath || '', 'AudioHelper.exe'),
    path.join(app.getAppPath(), 'helper-bin', 'AudioHelper.exe'),
    path.join(__dirname, '..', 'helper-bin', 'AudioHelper.exe'),
  ];
  return candidates.find((p) => p && fs.existsSync(p));
}

class AudioBridge {
  constructor({ onPcm, onVideo, onEvent }) {
    this.onPcm = onPcm;
    this.onVideo = onVideo;
    this.onEvent = onEvent;
    this.proc = null;
    this.buf = Buffer.alloc(0);
    this.waiters = []; // {type, resolve}
  }

  available() { return !!helperPath(); }

  ensure() {
    if (this.proc) return;
    const exe = helperPath();
    if (!exe) throw new Error('AudioHelper.exe não encontrado');
    this.proc = spawn(exe, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    this.proc.stdout.on('data', (d) => this.parse(d));
    this.proc.on('exit', () => {
      this.proc = null;
      this.buf = Buffer.alloc(0);
      this.onEvent({ type: 'stopped' });
    });
  }

  parse(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 5) {
      const len = this.buf.readUInt32LE(1);
      if (this.buf.length < 5 + len) break;
      const type = this.buf[0];
      const payload = this.buf.subarray(5, 5 + len);
      this.buf = this.buf.subarray(5 + len);
      if (type === 2) {
        this.onPcm(payload);
      } else if (type === 3) {
        this.onVideo(payload);
      } else if (type === 1) {
        let msg;
        try { msg = JSON.parse(payload.toString('utf8')); } catch { continue; }
        const i = this.waiters.findIndex((w) => w.type === msg.type || msg.type === 'error');
        if (i >= 0) this.waiters.splice(i, 1)[0].resolve(msg);
        this.onEvent(msg);
      }
    }
  }

  request(cmd, expect) {
    this.ensure();
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ type: 'error', message: 'Sem resposta do AudioHelper' }), 10000);
      this.waiters.push({ type: expect, resolve: (m) => { clearTimeout(timer); resolve(m); } });
      this.proc.stdin.write(JSON.stringify({ ...cmd, selfPid: process.pid }) + '\n');
    });
  }

  send(cmd) {
    if (this.proc) this.proc.stdin.write(JSON.stringify(cmd) + '\n');
  }

  videoStart(opts) { return this.request({ cmd: 'video-start', ...opts }, 'video-started'); }
  async videoStop() {
    if (!this.proc) return { type: 'video-stopped' };
    return this.request({ cmd: 'video-stop' }, 'video-stopped');
  }
  videoKey() { this.send({ cmd: 'video-key' }); }
  videoBitrate(kbps) { this.send({ cmd: 'video-bitrate', kbps }); }

  list() { return this.request({ cmd: 'list' }, 'list'); }
  start(mode, pid) { return this.request({ cmd: 'start', mode, pid }, 'started'); }
  async stop() {
    if (!this.proc) return { type: 'stopped' };
    return this.request({ cmd: 'stop' }, 'stopped');
  }
  // NUNCA encerrar à força com a captura de áudio ligada: matar o helper no meio de uma captura
  // "process loopback" derruba o serviço de áudio do Windows (som e microfone somem).
  // Pede para parar e fecha o stdin: o helper encerra sozinho.
  kill() {
    if (!this.proc) return;
    try {
      this.proc.stdin.write(JSON.stringify({ cmd: 'video-stop' }) + '\n');
      this.proc.stdin.write(JSON.stringify({ cmd: 'stop' }) + '\n');
      this.proc.stdin.end();
    } catch {}
  }
}

module.exports = { AudioBridge };
