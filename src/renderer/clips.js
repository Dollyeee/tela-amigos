// Clipes: guarda os últimos 30 s de uma tela (vídeo + áudio) e salva em MP4.
// Um VideoEncoder por tela com replay ligado (placa de vídeo), keyframe a cada 1 s para o clipe
// poder começar em qualquer segundo. Só ficam na memória os pedaços já codificados (~30 MB).
window.Clips = (() => {
  const KEEP_US = 31_000_000; // 31 s
  const buffers = new Map();  // id -> Replay

  class Replay {
    // opts.compose(): { video, pos } da câmera para desenhar por cima (ou null)
    // opts.audioTrack: áudio já misturado (transmissão + PC inteiro); opts.release() ao parar
    constructor(id, stream, name, opts = {}) {
      this.id = id;
      this.name = name;
      this.opts = opts;
      this.video = [];   // { chunk, meta }
      this.audio = [];   // { chunk, meta }
      this.videoConfig = null;
      this.audioConfig = null;
      this.width = 0; this.height = 0;
      this.frames = 0;
      this.stopped = false;
      this.keyEvery = 60;
      this.bitrate = 10_000_000;
      this.init();
      this.startVideo(stream);
      this.startAudio(stream);
    }

    init() {}

    // câmera do amigo por cima, na posição em que ela está na tela (bordas arredondadas)
    drawCam(g, W, H) {
      const comp = this.opts.compose && this.opts.compose();
      if (!comp || !comp.video || comp.video.readyState < 2 || !comp.video.videoWidth) return;
      const v = comp.video, p = comp.pos;
      const cw = p.w * W, ch = (cw * 9) / 16, x = p.x * W, y = p.y * H;
      // "cover": corta a câmera para caber em 16:9
      const vr = v.videoWidth / v.videoHeight;
      let sw = v.videoWidth, sh = v.videoHeight, sx = 0, sy = 0;
      if (vr > 16 / 9) { sw = v.videoHeight * 16 / 9; sx = (v.videoWidth - sw) / 2; } else { sh = v.videoWidth * 9 / 16; sy = (v.videoHeight - sh) / 2; }
      const r = Math.max(6, cw * 0.04);
      g.save();
      g.beginPath(); g.roundRect(x, y, cw, ch, r); g.clip();
      g.drawImage(v, sx, sy, sw, sh, x, y, cw, ch);
      g.restore();
      g.lineWidth = Math.max(2, W / 640);
      g.strokeStyle = 'rgba(255,255,255,.9)';
      g.beginPath(); g.roundRect(x, y, cw, ch, r); g.stroke();
    }

    // A trilha de uma tela pode trocar com o replay/gravação ligados: a transmissão foi reiniciada
    // (troca de tela, de codec, resolução pela rede) ou a tela do amigo passou da conexão direta para
    // o servidor de vídeo (e de volta). Antes o replay ficava preso na trilha antiga: "Salvar clipe"
    // gravava os 30 s de ANTES da troca e a gravação parava de crescer com o contador andando.
    // opts.source() devolve o MediaStream atual da tela; aqui sai a trilha viva dele (ou null).
    liveTrack(stream, kind) {
      let s = stream;
      try { if (this.opts.source) s = this.opts.source() || null; } catch {}
      const t = s ? (kind === 'audio' ? s.getAudioTracks() : s.getVideoTracks())[0] : null;
      return t && t.readyState === 'live' ? t : null;
    }

    async startVideo(stream) {
      let encoder = null, cfgKey = '';
      const makeEncoder = async (w, h) => {
        if (encoder) { try { await encoder.flush(); encoder.close(); } catch {} }
        // tamanho par (exigência do H.264) e no máximo 1080p para o clipe
        const s = Math.min(1, 1920 / w, 1080 / h);
        this.width = Math.max(2, Math.round(w * s) & ~1);
        this.height = Math.max(2, Math.round(h * s) & ~1);
        encoder = new VideoEncoder({
          output: (chunk, meta) => this.pushVideo(chunk, meta),
          error: (e) => console.warn('clipe (vídeo)', e),
        });
        encoder.configure({
          codec: 'avc1.640028', width: this.width, height: this.height, bitrate: this.bitrate, framerate: 60,
          hardwareAcceleration: 'prefer-hardware', latencyMode: 'realtime', avc: { format: 'avc' },
        });
        this.video.length = 0; // pedaços antigos (outro tamanho) não servem mais
      };
      // Emenda dos horários: cada trilha tem o relógio dela, e o clipe precisa de um só, sempre
      // crescente. A 1ª trilha passa como vem (off = 0); as seguintes continuam de onde a anterior
      // parou, mais o tempo real que ficou sem imagem.
      let lastTs = -1, lastAt = 0, lastKeyTs = -1, sinceKey = 0;
      try {
        while (!this.stopped) {
          const src = this.liveTrack(stream, 'video');
          if (!src) { await new Promise((r) => setTimeout(r, 300)); continue; } // sem imagem agora: espera voltar
          const track = src.clone();
          this.vTrack = track;
          const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
          this.vReader = reader;
          // a trilha da tela trocou: solta esta leitura (a antiga pode nunca mais mandar nada nem "acabar")
          const watch = setInterval(() => { if (this.stopped || this.liveTrack(stream, 'video') !== src) reader.cancel().catch(() => {}); }, 300);
          let off = null;
          try {
            for (;;) {
              const { value: frame, done } = await reader.read();
              if (done || this.stopped) { frame && frame.close(); break; }
              if (off == null) off = lastTs < 0 ? 0 : lastTs + Math.max(1000, Math.round((performance.now() - lastAt) * 1000)) - frame.timestamp;
              const ts = frame.timestamp + off;
              if (ts <= lastTs) { frame.close(); continue; } // (nunca para trás)
              const key = `${frame.displayWidth}x${frame.displayHeight}`;
              // gravação: o tamanho fica fixo (o arquivo não pode mudar de resolução no meio)
              if (key !== cfgKey && !(this.fixedSize && encoder)) { cfgKey = key; await makeEncoder(frame.displayWidth, frame.displayHeight); lastKeyTs = -1; }
              if (encoder.encodeQueueSize > 6) { frame.close(); continue; } // placa ocupada: pula um quadro
              let f = frame;
              const withCam = !!(this.opts.compose && this.opts.compose());
              if (withCam || frame.displayWidth !== this.width || frame.displayHeight !== this.height) {
                // desenha num canvas: reduz para o tamanho do clipe e/ou põe a câmera por cima
                const c = this.canvas || (this.canvas = new OffscreenCanvas(this.width, this.height));
                // (a altura também: 2560x1440 -> 2560x1080 mudava só a altura e a imagem saía achatada)
                if (c.width !== this.width || c.height !== this.height) { c.width = this.width; c.height = this.height; }
                const g = c.getContext('2d');
                g.drawImage(frame, 0, 0, this.width, this.height);
                if (withCam) this.drawCam(g, this.width, this.height);
                f = new VideoFrame(c, { timestamp: ts });
                frame.close();
              } else if (off !== 0) {
                f = new VideoFrame(frame, { timestamp: ts }); // mesma imagem, horário emendado
                frame.close();
              }
              // keyframe a cada ~1 s (clipe) ou ~2 s (gravação). Por quadros E por tempo: com a tela
              // quase parada chegam 1-2 quadros por segundo, e contando só quadros o keyframe demorava
              // mais que os 31 s guardados (o replay ficava vazio: "ainda não há imagem suficiente").
              const wantKey = lastKeyTs < 0 || sinceKey >= this.keyEvery || ts - lastKeyTs >= (this.keyEvery / 60) * 1e6;
              encoder.encode(f, { keyFrame: wantKey });
              if (wantKey) { lastKeyTs = ts; sinceKey = 0; }
              sinceKey++;
              this.frames++;
              lastTs = ts; lastAt = performance.now();
              f.close();
            }
          } finally {
            clearInterval(watch);
            try { track.stop(); } catch {}
          }
          if (!this.stopped) await new Promise((r) => setTimeout(r, 100)); // (nunca um laço sem pausa)
        }
      } catch (e) { console.warn('clipe', e); }
      // flush antes de fechar: close() joga fora o que ainda está na fila (fim da gravação)
      if (encoder) { try { await encoder.flush(); } catch {} try { encoder.close(); } catch {} }
    }

    // (at = quando o pedaço chegou; é por ele que o som é alinhado com a imagem ao montar o clipe)
    pushVideo(chunk, meta) {
      if (meta && meta.decoderConfig) this.videoConfig = meta.decoderConfig;
      this.video.push({ chunk, meta, at: performance.now() });
      // corta o começo, sempre começando num keyframe
      const last = chunk.timestamp;
      while (this.video.length > 1 && last - this.video[0].chunk.timestamp > KEEP_US) this.video.shift();
      while (this.video.length && this.video[0].chunk.type !== 'key') this.video.shift();
    }

    pushAudio(chunk, meta) {
      if (meta && meta.decoderConfig) this.audioConfig = meta.decoderConfig;
      this.audio.push({ chunk, meta, at: performance.now() });
      const last = chunk.timestamp;
      while (this.audio.length > 1 && last - this.audio[0].chunk.timestamp > KEEP_US) this.audio.shift();
    }

    // Som: opts.audioTrack (a mistura som do PC + tela, que já acompanha a tela sozinha) ou o som da
    // própria tela, seguindo a trilha atual como no vídeo.
    async startAudio(stream) {
      const fixed = this.opts.audioTrack || null;
      const current = () => (fixed ? (fixed.readyState === 'live' ? fixed : null) : this.liveTrack(stream, 'audio'));
      this.hasAudio = !!(current() && typeof AudioEncoder !== 'undefined');
      if (!this.hasAudio) return;
      let encoder = null;
      // Emenda dos horários depois de uma troca de trilha: os pedaços da 1ª passam como saem (sem
      // cópia); os das seguintes continuam de onde a anterior parou, mais o tempo real sem som.
      let shift = 0, gapPending = false, lastEnd = -1, lastAt = 0;
      const out = (chunk, meta) => {
        if (gapPending) {
          gapPending = false;
          shift = lastEnd + Math.max(0, Math.round((performance.now() - lastAt) * 1000)) - chunk.timestamp;
        }
        let c = chunk;
        if (shift) {
          const buf = new Uint8Array(chunk.byteLength);
          chunk.copyTo(buf);
          c = new EncodedAudioChunk({ type: chunk.type, timestamp: chunk.timestamp + shift, duration: chunk.duration || undefined, data: buf });
        }
        lastEnd = c.timestamp + (c.duration || 20000);
        lastAt = performance.now();
        this.pushAudio(c, meta);
      };
      try {
        while (!this.stopped) {
          const src = current();
          if (!src) {
            if (fixed) break; // a mistura acabou
            await new Promise((r) => setTimeout(r, 300));
            continue;
          }
          const track = src.clone();
          this.aTrack = track;
          const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
          this.aReader = reader;
          const watch = fixed ? null : setInterval(() => { if (this.stopped || current() !== src) reader.cancel().catch(() => {}); }, 300);
          if (lastEnd >= 0) gapPending = true;
          try {
            for (;;) {
              const { value: data, done } = await reader.read();
              if (done || this.stopped) { data && data.close(); break; }
              if (!encoder) {
                this.sampleRate = data.sampleRate;
                this.channels = Math.min(2, data.numberOfChannels);
                encoder = new AudioEncoder({ output: out, error: (e) => console.warn('clipe (áudio)', e) });
                encoder.configure({ codec: 'opus', sampleRate: this.sampleRate, numberOfChannels: this.channels, bitrate: 160_000 });
              }
              // outra trilha com outro formato (mono x estéreo): o encoder já configurado não aceita
              if (data.sampleRate === this.sampleRate && Math.min(2, data.numberOfChannels) === this.channels) encoder.encode(data);
              data.close();
            }
          } finally {
            if (watch) clearInterval(watch);
            try { track.stop(); } catch {}
          }
          if (!this.stopped) await new Promise((r) => setTimeout(r, 100)); // (nunca um laço sem pausa)
        }
      } catch (e) { console.warn('clipe (áudio)', e); }
      if (encoder) { try { await encoder.flush(); } catch {} try { encoder.close(); } catch {} }
    }

    // monta o MP4 com o que está guardado agora
    toMp4() {
      const vids = this.video.slice();
      if (!vids.length || !this.videoConfig) return null;
      const start = vids[0].chunk.timestamp;
      // O som começa junto com o 1º quadro do clipe, pelo momento em que cada pedaço chegou. Os
      // horários de vídeo e de som vêm de relógios diferentes: comparar um com o outro nunca cortava
      // nada, sobrava até 1 s de som antes da imagem e o som saía esse tanto atrasado no clipe.
      const auds = this.audio.filter((a) => a.at >= vids[0].at);
      const muxer = new Mp4Muxer.Muxer({
        target: new Mp4Muxer.ArrayBufferTarget(),
        video: { codec: 'avc', width: this.width, height: this.height, frameRate: 60 },
        audio: auds.length && this.audioConfig
          ? { codec: 'opus', numberOfChannels: this.channels, sampleRate: this.sampleRate } : undefined,
        fastStart: 'in-memory',
        firstTimestampBehavior: 'offset',
      });
      vids.forEach((v, i) => muxer.addVideoChunk(v.chunk, i === 0 ? { decoderConfig: this.videoConfig } : undefined));
      if (auds.length && this.audioConfig) {
        auds.forEach((a, i) => muxer.addAudioChunk(a.chunk, i === 0 ? { decoderConfig: this.audioConfig } : undefined));
      }
      muxer.finalize();
      const seconds = (vids[vids.length - 1].chunk.timestamp - start) / 1e6;
      return { buffer: muxer.target.buffer, seconds };
    }

    stop() {
      this.stopped = true;
      try { this.opts.release && this.opts.release(); } catch {}
      try { this.vReader && this.vReader.cancel().catch(() => {}); } catch {}
      try { this.aReader && this.aReader.cancel().catch(() => {}); } catch {}
      try { this.vTrack && this.vTrack.stop(); } catch {}
      try { this.aTrack && this.aTrack.stop(); } catch {}
    }
  }

  // Gravação longa: mesma codificação do replay, mas cada pedaço vai direto para um arquivo
  // MP4 fragmentado no disco (o arquivo continua aproveitável mesmo se o app fechar no meio).
  const recordings = new Map(); // id -> Recording
  class Recording extends Replay {
    init() {
      this.fixedSize = true;
      this.keyEvery = 120;        // keyframe a cada ~2 s (arquivo menor)
      this.bitrate = 12_000_000;  // ~5 GB por hora em 1080p60
      this.pending = [];          // pedaços que chegaram antes de o arquivo estar pronto
      this.muxer = null;
      this.startedAt = Date.now();
      this.bytes = 0;
      this.ready = window.native.recOpen(this.name).then((h) => { this.handle = h; }, (e) => {
        // não deu para criar o arquivo (pasta bloqueada, disco cheio...): para em vez de acumular na memória
        this.failed = e; this.pending = []; this.stop();
      });
      // o áudio tem até 3 s para aparecer; senão grava só o vídeo
      this.audioDeadline = performance.now() + 3000;
    }
    pushVideo(chunk, meta) {
      if (meta && meta.decoderConfig) this.videoConfig = meta.decoderConfig;
      this.feed('v', chunk, meta);
    }
    pushAudio(chunk, meta) {
      if (meta && meta.decoderConfig) this.audioConfig = meta.decoderConfig;
      this.feed('a', chunk, meta);
    }
    feed(kind, chunk, meta) {
      if (this.closed || this.failed) return;
      if (!this.muxer) {
        this.pending.push({ kind, chunk, meta });
        const audioOk = !this.hasAudio || this.audioConfig || performance.now() > this.audioDeadline;
        if (!this.videoConfig || !audioOk || !this.handle) return;
        this.makeMuxer();
        const list = this.pending; this.pending = [];
        // o vídeo precisa começar num keyframe; o áudio de antes dele é descartado
        const firstKey = list.find((x) => x.kind === 'v' && x.chunk.type === 'key');
        if (!firstKey) return;
        const t0 = firstKey.chunk.timestamp;
        for (const x of list) if (x.chunk.timestamp >= t0) this.add(x.kind, x.chunk, x.meta);
        return;
      }
      this.add(kind, chunk, meta);
    }
    makeMuxer() {
      const withAudio = !!(this.hasAudio && this.audioConfig);
      this.withAudio = withAudio;
      this.muxer = new Mp4Muxer.Muxer({
        target: new Mp4Muxer.StreamTarget({
          onData: (data, position) => { this.bytes = Math.max(this.bytes, position + data.byteLength); window.native.recWrite(this.handle, data, position); },
          chunked: true, chunkSize: 4 * 1024 * 1024,
        }),
        video: { codec: 'avc', width: this.width, height: this.height, frameRate: 60 },
        audio: withAudio ? { codec: 'opus', numberOfChannels: this.channels, sampleRate: this.sampleRate } : undefined,
        fastStart: 'fragmented',
        firstTimestampBehavior: 'offset',
      });
      this.sentVideoCfg = false; this.sentAudioCfg = false;
    }
    add(kind, chunk, meta) {
      try {
        if (kind === 'v') {
          if (!this.sentVideoCfg && chunk.type !== 'key') return;
          this.muxer.addVideoChunk(chunk, this.sentVideoCfg ? undefined : { decoderConfig: this.videoConfig });
          this.sentVideoCfg = true;
        } else if (this.withAudio && this.sentVideoCfg) {
          this.muxer.addAudioChunk(chunk, this.sentAudioCfg ? undefined : { decoderConfig: this.audioConfig });
          this.sentAudioCfg = true;
        }
      } catch (e) { console.warn('gravação', e); }
    }
    async finish() {
      this.stop();
      await new Promise((r) => setTimeout(r, 300)); // últimos pedaços dos encoders
      this.closed = true;
      try { if (this.muxer) this.muxer.finalize(); } catch (e) { console.warn('gravação (finalizar)', e); }
      await this.ready.catch(() => {});
      return this.handle ? window.native.recClose(this.handle, !this.muxer) : null;
    }
  }

  function startRecording(id, stream, name, opts) {
    if (recordings.has(id) || !stream || !stream.getVideoTracks().length) { opts && opts.release && opts.release(); return false; }
    recordings.set(id, new Recording(id, stream, name, opts));
    return true;
  }
  async function stopRecording(id) {
    const r = recordings.get(id);
    if (!r) return null;
    recordings.delete(id);
    const file = await r.finish();
    return file ? { file, seconds: (Date.now() - r.startedAt) / 1000, bytes: r.bytes } : null;
  }
  const recInfo = (id) => { const r = recordings.get(id); return r ? { seconds: (Date.now() - r.startedAt) / 1000, bytes: r.bytes } : null; };
  // espera o arquivo abrir: devolve o erro, se não abriu
  async function recReady(id) { const r = recordings.get(id); if (!r) return null; await r.ready; return r.failed || null; }
  const recByHandle = (h) => { for (const [id, r] of recordings) if (r.handle === h) return id; return null; };

  function toggle(id, stream, name, opts) {
    if (buffers.has(id)) {
      buffers.get(id).stop(); buffers.delete(id);
      try { opts && opts.release && opts.release(); } catch {} // o áudio pedido agora não vai ser usado
      return false;
    }
    if (!stream || !stream.getVideoTracks().length) { opts && opts.release && opts.release(); return false; }
    buffers.set(id, new Replay(id, stream, name, opts));
    return true;
  }

  // monta o MP4 dos últimos 30 s (sem salvar)
  function build(id) {
    const r = buffers.get(id);
    return r ? r.toMp4() : null;
  }

  async function save(id) {
    const r = buffers.get(id);
    const mp4 = build(id);
    if (!r || !mp4) return null;
    const file = await window.native.saveClip(r.name, mp4.buffer);
    return { file, seconds: mp4.seconds };
  }

  function stop(id) { if (buffers.has(id)) { buffers.get(id).stop(); buffers.delete(id); } }

  return {
    toggle, build, save, stop, isOn: (id) => buffers.has(id), ids: () => [...buffers.keys()],
    startRecording, stopRecording, isRecording: (id) => recordings.has(id), recInfo, recordingIds: () => [...recordings.keys()],
    recReady, recByHandle,
  };
})();
