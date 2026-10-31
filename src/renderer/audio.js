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

    window.native.onAudioPcm((buf) => {
      if (!node) return;
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      node.port.postMessage(ab, [ab]);
    });

    const res = await window.native.audioStart(mode, pid);
    if (res.type === 'error') {
      await stop();
      throw new Error(res.message);
    }
    return dest.stream.getAudioTracks()[0];
  }

  async function stop() {
    if (!ctx) return;
    try { await window.native.audioStop(); } catch {}
    try { node.disconnect(); } catch {}
    try { await ctx.close(); } catch {}
    ctx = null;
    node = null;
  }

  return { start, stop };
})();
