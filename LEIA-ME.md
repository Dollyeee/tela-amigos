# Tela Amigos

Compartilhamento de tela entre amigos em 1080p60, direto de PC para PC.

## Instalar (amigos)
Baixe o `TelaAmigos-Setup-x.y.z.exe` da última versão em
https://github.com/Dollyeee/tela-amigos/releases/latest e abra. Instala só para o seu usuário (sem admin).
Depois disso o app **se atualiza sozinho**.

> O instalador não tem assinatura digital paga, então o Windows pode mostrar "O Windows protegeu o computador":
> clique em **Mais informações → Executar assim mesmo** (só na instalação).

## Usar
1. Todos na mesma rede do **Radmin VPN** (no Radmin, a conexão com cada um deve aparecer como *direta*, não *relay*).
2. Uma pessoa clica em **Hospedar sala** e manda o IP mostrado no topo (o `26.x.x.x`).
3. Os outros clicam em **Entrar** com esse IP.
4. Na primeira vez, o Windows pergunta sobre o firewall para quem hospeda: marque **redes públicas e privadas**.

## Recursos
- Captura **nativa**: Windows Graphics Capture + H.264 na placa de vídeo (NVIDIA/AMD/Intel), 60 fps em ritmo fixo, taxa constante (até 80 Mbps).
- Layouts **Grade** (G) e **Foco** (F) com miniaturas; arraste pela barra do nome para reorganizar; duplo clique foca; tela cheia e picture-in-picture.
- **Ocultar** a tela de alguém para de receber o vídeo/áudio dela.
- Áudio: "Todo o som do PC, exceto Discord" ou "Só: <app>". O som deste app (telas dos amigos) nunca é reenviado.
- **Estatísticas** (S): FPS de captura/envio/recebimento, bitrate, ping, buffer, travadas, perdas.

## Desenvolver
```
npm install
npm start                 # roda o app (sem atualização automática)
npm run build             # gera dist/TelaAmigos-Setup-x.y.z.exe localmente
npm run release           # sobe a versão, compila e publica no GitHub -> amigos atualizam sozinhos
```
Requer Node.js, .NET 10 SDK e `gh` logado.

- `src/main.js` – processo principal (janela, servidor da sala, ponte com o helper, atualização)
- `src/renderer/` – interface, WebRTC, `native-video.js` (injeta o H.264 nativo no WebRTC)
- `audio-helper/` – `VideoStreamer.cs` (captura + encoder) e `Program.cs` (áudio por processo)
