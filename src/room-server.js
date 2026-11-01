// Processo da sala em segundo plano (Tela Amigos.exe rodando como Node, sem janela).
// Continua rodando quando o app é fechado/reiniciado; para com "Fechar sala" no app
// (GET http://127.0.0.1:<porta>/shutdown) ou ao desligar o PC.
//
// Também responde à "procura de salas" (UDP 47801): quem abre o lobby manda um broadcast
// pela rede do Radmin e esta sala responde com o nome de quem hospeda e quem está nela.
const dgram = require('dgram');
const { createSignalingServer, allowedAddress } = require('./signaling');

const port = Number(process.argv[2]) || 47800;
const hostName = String(process.argv[3] || 'Sala').slice(0, 30);
const DISCOVERY_PORT = port + 1;

createSignalingServer(port, { onShutdown: () => process.exit(0) })
  .then((room) => {
    const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    udp.on('error', () => {}); // procura de salas é opcional: a sala funciona sem ela
    udp.on('message', (msg, rinfo) => {
      if (msg.toString() !== 'TELA_AMIGOS_DISCOVER' || !allowedAddress(rinfo.address)) return;
      const info = room.info();
      const reply = Buffer.from(JSON.stringify({ app: 'tela-amigos', port, hostName, members: info.members, names: info.names }));
      udp.send(reply, rinfo.port, rinfo.address);
    });
    udp.bind(DISCOVERY_PORT, '0.0.0.0');
  })
  .catch(() => process.exit(1)); // porta ocupada: já existe uma sala rodando
