// Clipes: guarda os últimos 30 s de uma tela (vídeo + áudio) e salva em MP4.
// Um VideoEncoder por tela com replay ligado (placa de vídeo), keyframe a cada 1 s para o clipe
// poder começar em qualquer segundo. Só ficam na memória os pedaços já codificados (~30 MB).
window.Clips = (() => {
  const KEEP_US = 31_000_000; // 31 s
  const buffers = new Map();  // id -> Replay

  class Replay {
    constructor(id, stream, name) {
      this.id = id;
      this.name = name;
      this.video = [];   // { chunk, meta }
      this.audio = [];   // { chunk, meta }
      this.videoConfig = null;
      this.audioConfig = null;
      this.width = 0; this.height = 0;
      this.frames = 0;
      this.stopped = false;
      this.startVideo(stream);
      this.startAudio(stream);
    }

    async startVideo(stream) {
      const track = stream.getVideoTracks()[0];
      if (!track) return;
      this.vTrack = track.clone();
      const reader = new MediaStreamTrackProcessor({ track: this.vTrack }).readable.getReader();
      this.vReader = reader;
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
          codec: 'avc1.640028', width: this.width, height: this.height, bitrate: 10_000_000, framerate: 60,
          hardwareAcceleration: 'prefer-hardware', latencyMode: 'realtime', avc: { format: 'avc' },
        });
        this.video.length = 0; // pedaços antigos (outro tamanho) não servem mais
      };
      try {
        for (;;) {
          const { value: frame, done } = await reader.read();
          if (done || this.stopped) { frame && frame.close(); break; }
          const key = `${frame.displayWidth}x${frame.displayHeight}`;
          if (key !== cfgKey) { cfgKey = key; await makeEncoder(frame.displayWidth, frame.displayHeight); }
          if (encoder.encodeQueueSize > 6) { frame.close(); continue; } // placa ocupada: pula um quadro
          let f = frame;
          if (frame.displayWidth !== this.width || frame.displayHeight !== this.height) {
            // reduz para o tamanho do clipe
            const c = this.canvas || (this.canvas = new OffscreenCanvas(this.width, this.height));
            if (c.width !== this.width) { c.width = this.width; c.height = this.height; }
            c.getContext('2d').drawImage(frame, 0, 0, this.width, this.height);
            f = new VideoFrame(c, { timestamp: frame.timestamp });
            frame.close();
          }
          encoder.encode(f, { keyFrame: this.frames % 60 === 0 }); // keyframe ~1 s
          this.frames++;
          f.close();
        }
      } catch (e) { console.warn('clipe', e); }
      try { encoder && encoder.close(); } catch {}
    }

    pushVideo(chunk, meta) {
      if (meta && meta.decoderConfig) this.videoConfig = meta.decoderConfig;
      this.video.push({ chunk, meta });
      // corta o começo, sempre começando num keyframe
      const last = chunk.timestamp;
      while (this.video.length > 1 && last - this.video[0].chunk.timestamp > KEEP_US) this.video.shift();
      while (this.video.length && this.video[0].chunk.type !== 'key') this.video.shift();
    }

    async startAudio(stream) {
      const track = stream.getAudioTracks()[0];
      if (!track || typeof AudioEncoder === 'undefined') return;
      this.aTrack = track.clone();
      const reader = new MediaStreamTrackProcessor({ track: this.aTrack }).readable.getReader();
      this.aReader = reader;
      let encoder = null;
      try {
        for (;;) {
          const { value: data, done } = await reader.read();
          if (done || this.stopped) { data && data.close(); break; }
          if (!encoder) {
            this.sampleRate = data.sampleRate;
            this.channels = Math.min(2, data.numberOfChannels);
            encoder = new AudioEncoder({
              output: (chunk, meta) => {
                if (meta && meta.decoderConfig) this.audioConfig = meta.decoderConfig;
                this.audio.push({ chunk, meta });
                const last = chunk.timestamp;
                while (this.audio.length > 1 && last - this.audio[0].chunk.timestamp > KEEP_US) this.audio.shift();
              },
              error: (e) => console.warn('clipe (áudio)', e),
            });
            encoder.configure({ codec: 'opus', sampleRate: this.sampleRate, numberOfChannels: this.channels, bitrate: 160_000 });
          }
          encoder.encode(data);
          data.close();
        }
      } catch (e) { console.warn('clipe (áudio)', e); }
      try { encoder && encoder.close(); } catch {}
    }

    // monta o MP4 com o que está guardado agora
    toMp4() {
      const vids = this.video.slice();
      if (!vids.length || !this.videoConfig) return null;
      const start = vids[0].chunk.timestamp;
      const auds = this.audio.filter((a) => a.chunk.timestamp >= start);
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
      try { this.vReader && this.vReader.cancel(); } catch {}
      try { this.aReader && this.aReader.cancel(); } catch {}
      try { this.vTrack && this.vTrack.stop(); } catch {}
      try { this.aTrack && this.aTrack.stop(); } catch {}
    }
  }

  function toggle(id, stream, name) {
    if (buffers.has(id)) { buffers.get(id).stop(); buffers.delete(id); return false; }
    if (!stream || !stream.getVideoTracks().length) return false;
    buffers.set(id, new Replay(id, stream, name));
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

  return { toggle, build, save, stop, isOn: (id) => buffers.has(id), ids: () => [...buffers.keys()] };
})();
