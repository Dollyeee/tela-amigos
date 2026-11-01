// Recebe o PCM do AudioHelper (via processo principal) e transforma num MediaStreamTrack
// que vai junto com a tela. Esse áudio NÃO é tocado localmente.
window.HelperAudio = (() => {
  const WORKLET = `
  class PcmPlayer extends AudioWorkletProcessor {
    constructor() {
      super();
      this.cap = 48000;                // 1 s de buffer circular
      this.L = new Float32Array(this.cap);
      this.R = new Float32Array(this.cap);
      this.w = 0; this.r = 0; this.n = 0;
      this.primed = false;
      this.port.onmessage = (e) => {
        const s = new Int16Array(e.data);
        const frames = s.length >> 1;
        for (let i = 0; i < frames; i++) {
          this.L[this.w] = s[2 * i] / 32768;
          this.R[this.w] = s[2 * i + 1] / 32768;
          this.w = (this.w + 1) % this.cap;
        }
        this.n += frames;
        // Mais de 150 ms acumulado -> descarta até 50 ms (mantém a latência baixa)
        if (this.n > 7200) {
          const drop = this.n - 2400;
          this.r = (this.r + drop) % this.cap;
          this.n -= drop;
        }
      };
    }
    process(_inputs, outputs) {
      const l = outputs[0][0], r = outputs[0][1] || outputs[0][0];
      if (!this.primed) {
        if (this.n >= 1440) this.primed = true; // espera 30 ms antes de tocar
        else { l.fill(0); r.fill(0); return true; }
      }
      for (let i = 0; i < l.length; i++) {
        if (this.n > 0) {
          l[i] = this.L[this.r]; r[i] = this.R[this.r];
          this.r = (this.r + 1) % this.cap; this.n--;
        } else { l[i] = 0; r[i] = 0; this.primed = false; }
      }
      return true;
    }
  }
  registerProcessor('pcm-player', PcmPlayer);`;

  let ctx = null;
  let node = null;

  async function start(mode, pid) {
    await stop();
    ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    node = new AudioWorkletNode(ctx, 'pcm-player', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
    });
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 2;
    node.connect(dest);

    window.Helper.onPcm((ab) => {
      if (node) node.port.postMessage(ab, [ab]);
    });

    const res = await window.Helper.audioStart(mode, pid);
    if (res.type === 'error') {
      await stop();
      throw new Error(res.message);
    }
    return dest.stream.getAudioTracks()[0];
  }

  async function stop() {
    if (!ctx) return;
    try { await window.Helper.audioStop(); } catch {}
    try { node.disconnect(); } catch {}
    try { await ctx.close(); } catch {}
    ctx = null;
    node = null;
  }

  return { start, stop, WORKLET };
})();

// Áudio dos clipes: som do PC inteiro (menos este app, vem do AudioHelper) misturado com o som
// da transmissão do amigo. Cada clipe ganha a sua mistura; a captura do PC é uma só.
window.ClipAudio = (() => {
  let ctx = null, sysNode = null, users = 0, starting = null, stopping = null;

  // ctx/sysNode só ficam visíveis quando o início terminou (e somem se falhar)
  async function ensure() {
    if (starting) return starting;
    if (stopping) await stopping; // desligando: espera terminar antes de ligar de novo
    if (starting) return starting; // outro pedido começou enquanto esperava
    if (ctx) return;
    starting = (async () => {
      const c = new AudioContext({ sampleRate: 48000, latencyHint: 'playback' });
      try {
        const url = URL.createObjectURL(new Blob([window.HelperAudio.WORKLET], { type: 'text/javascript' }));
        await c.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        const node = new AudioWorkletNode(c, 'pcm-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
        window.Helper.onSys((ab) => { if (sysNode) sysNode.port.postMessage(ab, [ab]); });
        ctx = c; sysNode = node;
        const res = await window.Helper.sysStart();
        if (res.type === 'error') console.warn('áudio do PC para clipes:', res.message);
      } catch (e) {
        ctx = null; sysNode = null;
        try { await c.close(); } catch {}
        throw e;
      }
    })();
    try { await starting; } finally { starting = null; }
  }

  async function mixFor(stream) {
    await ensure();
    users++;
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 2;
    sysNode.connect(dest);
    const at = stream && stream.getAudioTracks()[0];
    const src = at ? ctx.createMediaStreamSource(new MediaStream([at])) : null;
    if (src) src.connect(dest);
    let released = false;
    return {
      track: dest.stream.getAudioTracks()[0],
      release() {
        if (released) return;
        released = true;
        try { sysNode && sysNode.disconnect(dest); } catch {}
        try { src && src.disconnect(); } catch {}
        if (--users <= 0) shutdown();
      },
    };
  }

  function shutdown() {
    users = 0;
    const c = ctx;
    ctx = null; sysNode = null; // um novo pedido já cria outro (depois de este terminar)
    stopping = (async () => {
      try { await window.Helper.sysStop(); } catch {} // para a captura com calma
      try { if (c) await c.close(); } catch {}
    })().finally(() => { stopping = null; });
  }

  return { mixFor };
})();

// Som das telas dos amigos. O <video> só vai até 100%; aqui o áudio passa por Web Audio:
//   fonte -> nivelador (sobe quem está baixo, nunca abaixa) -> volume (até 300%) -> limitador
// O limitador segura os picos para o som aumentado não estourar/distorcer.
window.TileAudio = (() => {
  const TARGET_DB = -20;  // volume "normal" desejado (RMS)
  const MAX_BOOST = 4;    // nivelador: no máximo 4x (+12 dB)
  let ctx = null;
  const all = new Set();
  function context() {
    if (!ctx) ctx = new AudioContext({ latencyHint: 'interactive' });
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  class TileAudio {
    constructor() {
      this.volume = 1;
      this.muted = true;
      this.stream = null;
      this.track = null;
      this.nodes = null;
      this.level = null;  // volume médio medido (dB), só quando tem som
      this.boost = 1;     // ganho atual do nivelador
      this.failed = false;
      all.add(this);
    }

    setStream(stream) { this.stream = stream; this.check(); }

    // a trilha de áudio do amigo pode trocar (ele parou/voltou a transmitir)
    check() {
      const t = (this.stream && this.stream.getAudioTracks()[0]) || null;
      if (t !== this.track) { this.track = t; this.rebuild(); }
    }

    rebuild() {
      this.teardown();
      if (!this.track || this.failed) return;
      try {
        const c = context();
        const src = c.createMediaStreamSource(new MediaStream([this.track]));
        const analyser = c.createAnalyser();
        analyser.fftSize = 2048;
        const agc = c.createGain();
        agc.gain.value = this.boost;
        const user = c.createGain();
        user.gain.value = this.muted ? 0 : this.volume;
        const limiter = c.createDynamicsCompressor();
        limiter.threshold.value = -3;
        limiter.knee.value = 3;
        limiter.ratio.value = 20;
        limiter.attack.value = 0.002;
        limiter.release.value = 0.15;
        src.connect(analyser);
        src.connect(agc);
        agc.connect(user);
        user.connect(limiter);
        limiter.connect(c.destination);
        this.nodes = { src, analyser, agc, user, limiter, buf: new Float32Array(analyser.fftSize) };
      } catch (e) {
        console.warn('áudio da tela (Web Audio indisponível, usando o volume normal)', e);
        this.failed = true;
        this.nodes = null;
      }
    }

    set(volume, muted) {
      this.volume = volume;
      this.muted = muted;
      if (this.nodes) this.nodes.user.gain.setTargetAtTime(muted ? 0 : volume, context().currentTime, 0.03);
    }

    // a cada 250 ms: mede o volume e ajusta o nivelador devagar (sem "bombear")
    tick(leveler) {
      this.check();
      const n = this.nodes;
      if (!n) return;
      let target = 1;
      if (leveler) {
        n.analyser.getFloatTimeDomainData(n.buf);
        let sum = 0;
        for (let i = 0; i < n.buf.length; i++) sum += n.buf[i] * n.buf[i];
        const db = 10 * Math.log10(sum / n.buf.length + 1e-12);
        if (db > -55) this.level = this.level == null ? db : this.level * 0.92 + db * 0.08; // só conta quando tem som
        if (this.level != null) target = Math.max(1, Math.min(MAX_BOOST, Math.pow(10, (TARGET_DB - this.level) / 20)));
        else target = this.boost;
      }
      if (Math.abs(target - this.boost) > 0.01) {
        this.boost = target;
        n.agc.gain.setTargetAtTime(target, context().currentTime, 1.2);
      }
    }

    teardown() {
      if (!this.nodes) return;
      try { this.nodes.src.disconnect(); } catch {}
      try { this.nodes.limiter.disconnect(); } catch {}
      this.nodes = null;
    }

    destroy() { this.teardown(); all.delete(this); }
  }

  setInterval(() => {
    const leveler = localStorage.getItem('leveler') !== '0';
    for (const a of all) a.tick(leveler);
  }, 250);

  return TileAudio;
})();
