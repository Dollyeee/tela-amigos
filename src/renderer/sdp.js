// Ajustes no SDP para qualidade alta:
//  - Opus estéreo com bitrate de música (o padrão é mono ~32 kbps, feito para voz)
//  - Bitrate inicial alto no vídeo (o WebRTC começa baixo e demora a subir)
window.Sdp = (() => {
  // Só no nativo:
  //  minKbps = piso da estimativa de banda do WebRTC nesta conexão. Importa muito: o WebRTC só solta
  //    os pacotes no ritmo da estimativa dele, então o bitrate da placa fica sempre abaixo dela
  //    (netctl.js); o piso é o bitrate disponível na hora em que a tela volta a se mexer (ver
  //    rateOpts no app.js).
  //  maxKbps = teto combinado (fica acima de qualquer bitrate que a placa possa usar).
  // O começo (x-google-start-bitrate) só é aplicado pelo WebRTC quando o número MUDA em relação à
  // negociação anterior: aí ele reinicia a estimativa nesse valor e sonda a rede. Não dá para usar
  // isso como "medir de novo" no meio da transmissão: medido, uma das sondagens seguintes costuma
  // sair baixa e ele aceita (a estimativa cai para 85% do que está sendo enviado).
  function munge(sdp, { videoKbps, native, maxKbps, minKbps }) {
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

    // Modo nativo: o encoder da placa fica abaixo da estimativa de banda do WebRTC (ver
    // adaptNativeBitrate); aqui vão o começo, o piso e o teto dela.
    const cap = window.__testCapKbps; // teste: simula uma rede limitada
    const videoParams = native
      ? [
          `x-google-start-bitrate=${Math.round(videoKbps)}`,
          `x-google-min-bitrate=${Math.round(minKbps || Math.min(videoKbps * 0.3, 4000))}`,
          `x-google-max-bitrate=${Math.round(cap || Math.max(videoKbps * 1.3, maxKbps || 0))}`,
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

  // codec que derrubou o app NESTE PC ao transmitir (ex.: H.265 na RX 7600: o Chromium aborta):
  // nunca mais é usado para enviar aqui (receber continua normal)
  const sendBad = (name) => localStorage.getItem(`codecBad:${name}`) === '1';
  const usable = (c) => !((/h265/i.test(c.mimeType) && sendBad('H265')) || (/av1/i.test(c.mimeType) && sendBad('AV1')));
  function codecPreferences(preferred) {
    const caps0 = RTCRtpReceiver.getCapabilities('video');
    if (!caps0) return null;
    const caps = { codecs: caps0.codecs.filter(usable) };
    if ((preferred === 'H265' && sendBad('H265')) || (preferred === 'AV1' && sendBad('AV1'))) preferred = 'auto';
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

  // Só H.265 (mais os auxiliares): modo nativo direto com o HEVC do helper
  function h265OnlyPreferences() {
    const caps = RTCRtpReceiver.getCapabilities('video');
    if (!caps) return null;
    if (sendBad('H265')) return null;
    const h265 = caps.codecs.filter((c) => /h265/i.test(c.mimeType));
    const extras = caps.codecs.filter((c) => /rtx|red|ulpfec|flexfec/i.test(c.mimeType));
    return h265.length ? [...h265, ...extras] : null;
  }
  // Só AV1: modo nativo direto com o AV1 do helper (placas RTX 40 / RX 7000 / Arc)
  function av1OnlyPreferences() {
    const caps = RTCRtpReceiver.getCapabilities('video');
    if (!caps) return null;
    if (sendBad('AV1')) return null;
    const av1 = caps.codecs.filter((c) => /av1/i.test(c.mimeType) && !/profile=1/.test(c.sdpFmtpLine || ''));
    const extras = caps.codecs.filter((c) => /rtx|red|ulpfec|flexfec/i.test(c.mimeType));
    return av1.length ? [...av1, ...extras] : null;
  }
  // decodifico AV1 pela placa de vídeo? (por software, 1080p60 pesa demais com jogo aberto)
  let av1Hw = false;
  const av1Ready = window.VideoDecoder
    ? VideoDecoder.isConfigSupported({ codec: 'av01.0.09M.08', codedWidth: 1920, codedHeight: 1080, hardwareAcceleration: 'prefer-hardware' })
      .then((r) => { av1Hw = !!(r && r.supported); }).catch(() => {})
    : Promise.resolve();
  const hasAV1Hw = () => av1Hw && !!(RTCRtpReceiver.getCapabilities('video') || { codecs: [] }).codecs.some((c) => /av1/i.test(c.mimeType));
  const hasH265 = () => !!(RTCRtpReceiver.getCapabilities('video') || { codecs: [] }).codecs.some((c) => /h265/i.test(c.mimeType));

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

  return { sendBad, munge, codecPreferences, h264OnlyPreferences, h265OnlyPreferences, av1OnlyPreferences, hasH265, hasAV1Hw, av1Ready };
})();
