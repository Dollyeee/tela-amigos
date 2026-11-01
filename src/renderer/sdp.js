// Ajustes no SDP para qualidade alta:
//  - Opus estéreo com bitrate de música (o padrão é mono ~32 kbps, feito para voz)
//  - Bitrate inicial alto no vídeo (o WebRTC começa baixo e demora a subir)
window.Sdp = (() => {
  function munge(sdp, { videoKbps, native }) {
    const lines = sdp.split('\r\n');
    const opus = new Set();
    const video = new Set();
    for (const l of lines) {
      let m = l.match(/^a=rtpmap:(\d+) opus\/48000/i);
      if (m) opus.add(m[1]);
      m = l.match(/^a=rtpmap:(\d+) (H264|H265|VP8|VP9|AV1)\/90000/i);
      if (m) video.add(m[1]);
    }
    const hasFmtp = new Set(lines.map((l) => (l.match(/^a=fmtp:(\d+) /) || [])[1]).filter(Boolean));

    // Modo nativo: o nosso encoder SEGUE a estimativa de banda do WebRTC (ver adaptNativeBitrate);
    // aqui só damos um começo razoável e o teto escolhido pelo usuário.
    const cap = window.__testCapKbps; // teste: simula uma rede limitada
    const videoParams = native
      ? [
          `x-google-start-bitrate=${Math.round(videoKbps)}`,
          `x-google-min-bitrate=${Math.round(Math.min(videoKbps * 0.3, 4000))}`,
          `x-google-max-bitrate=${Math.round(cap || videoKbps * 1.3)}`,
        ]
      : [
          // a estimativa de banda pelo Radmin é conservadora demais (caía para ~4 Mbps com
          // 100 Mbps disponíveis): começa no bitrate escolhido e nunca desce de 40% dele
          `x-google-start-bitrate=${Math.round(videoKbps)}`,
          // piso: no máximo 4 Mbps (um piso alto forçava envio acima do que a rede aguentava
          // e o atraso ia a segundos)
          `x-google-min-bitrate=${Math.round(Math.min(videoKbps * 0.4, 4000))}`,
          `x-google-max-bitrate=${Math.round(videoKbps * 1.25)}`,
        ];
    const opusParams = ['stereo=1', 'sprop-stereo=1', 'maxaveragebitrate=256000', 'useinbandfec=1'];

    const merge = (existing, add) => {
      const keys = new Set(add.map((p) => p.split('=')[0]));
      const kept = existing.split(';').filter((p) => p && !keys.has(p.split('=')[0]));
      return [...kept, ...add].join(';');
    };

    const out = [];
    for (const l of lines) {
      const f = l.match(/^a=fmtp:(\d+) (.*)$/);
      if (f && opus.has(f[1])) { out.push(`a=fmtp:${f[1]} ${merge(f[2], opusParams)}`); continue; }
      if (f && video.has(f[1])) { out.push(`a=fmtp:${f[1]} ${merge(f[2], videoParams)}`); continue; }
      out.push(l);
      // codecs sem linha fmtp (ex.: VP8): cria uma logo após o rtpmap
      const r = l.match(/^a=rtpmap:(\d+) /);
      if (r && !hasFmtp.has(r[1])) {
        if (video.has(r[1])) out.push(`a=fmtp:${r[1]} ${videoParams.join(';')}`);
        if (opus.has(r[1])) out.push(`a=fmtp:${r[1]} ${opusParams.join(';')}`);
      }
    }
    return out.join('\r\n');
  }

  function codecPreferences(preferred) {
    const caps = RTCRtpReceiver.getCapabilities('video');
    if (!caps) return null;
    // Automático: H.265 primeiro (mesma imagem com ~30-40% menos bits; o Chromium só lista H.265
    // quando a placa codifica/decodifica), depois H.264; quem não tiver H.265 negocia H.264
    if (preferred === 'auto') {
      const is = (c, re) => re.test(c.mimeType);
      const h265 = caps.codecs.filter((c) => is(c, /h265/i));
      const h264 = caps.codecs.filter((c) => is(c, /h264/i));
      const rest = caps.codecs.filter((c) => !is(c, /h26[45]/i));
      return h265.length || h264.length ? [...h265, ...h264, ...rest] : null;
    }
    const want = `video/${preferred}`.toLowerCase();
    const first = caps.codecs.filter((c) => c.mimeType.toLowerCase() === want);
    if (!first.length) return null;
    return [...first, ...caps.codecs.filter((c) => c.mimeType.toLowerCase() !== want)];
  }

  // Só H.264 com packetization-mode=1 (permite fragmentar quadros grandes), baseline primeiro,
  // mais os auxiliares (rtx/red/ulpfec). Usado no modo de vídeo nativo.
  function h264OnlyPreferences() {
    const caps = RTCRtpReceiver.getCapabilities('video');
    if (!caps) return null;
    const isH264 = (c) => /h264/i.test(c.mimeType);
    const pm1 = (c) => /packetization-mode=1/.test(c.sdpFmtpLine || '');
    const h264 = caps.codecs.filter((c) => isH264(c) && pm1(c));
    h264.sort((a, b) => /42e01f/i.test(b.sdpFmtpLine) - /42e01f/i.test(a.sdpFmtpLine));
    const extras = caps.codecs.filter((c) => /rtx|red|ulpfec|flexfec/i.test(c.mimeType));
    return h264.length ? [...h264, ...extras] : null;
  }

  return { munge, codecPreferences, h264OnlyPreferences };
})();
