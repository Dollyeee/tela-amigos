# Tela Amigos

Compartilhamento de tela entre amigos em 1080p60, direto de PC para PC.

## Instalar (amigos)
Baixe o `TelaAmigos-Setup-x.y.z.exe` da última versão em
https://github.com/Dollyeee/tela-amigos/releases/latest e abra. Instala só para o seu usuário (sem admin).
Depois disso o app **se atualiza sozinho** (ou clique em "Procurar atualização", no canto inferior esquerdo).

> O instalador não tem assinatura digital paga, então o Windows pode mostrar "O Windows protegeu o computador":
> clique em **Mais informações → Executar assim mesmo** (só na instalação).

## Usar
1. Todos na mesma rede do **Radmin VPN** (ou Hamachi/Tailscale/rede local).
2. Uma pessoa clica em **Hospedar sala**. A sala fica aberta em segundo plano: dá para fechar/reiniciar
   o app sem derrubar ninguém. **Fechar sala** encerra para todos.
3. Os outros veem a sala em **Salas abertas** e clicam em **Entrar** (ou digitam o IP `26.x.x.x`).
4. Na primeira vez, o Windows pergunta sobre o firewall para quem hospeda: marque **redes públicas e privadas**.

## Recursos
- **Captura nativa 60 fps** (Windows Graphics Capture + H.264 na placa de vídeo) que se adapta à rede;
  "Nativa direta" para rede perfeita; "Chromium" para compatibilidade.
- **HDR → SDR automático**: quem joga com HDR ligado aparece com as cores certas para quem assiste.
- **Ajustes** durante a transmissão: qualidade muda na hora; resolução/FPS/captura sem parar.
- Layouts **Grade** e **Foco** (miniaturas embaixo). Duplo clique foca/desfoca; **Esc** sai da tela cheia e do foco;
  arraste pela alça ⋮⋮ para reorganizar; picture-in-picture.
- **Volume**: rodinha do mouse sobre a tela; lembrado por amigo; as telas abrem mutadas.
- **Ocultar** a tela de alguém para de receber o vídeo/áudio dela.
- **Áudio**: "Todo o som do PC, exceto Discord" ou "Só: <app>". O som deste app nunca é reenviado.
- Sala resistente a quedas: reconecta sozinha sem derrubar as telas.
- **Estatísticas** (S): FPS, bitrate, ping, buffer, travadas, perdas, rota, encoder.

## Desenvolver
```
npm install
npm start                 # roda o app (sem atualização automática)
npm run build             # gera dist/TelaAmigos-Setup-x.y.z.exe localmente
npm run release           # sobe a versão, compila e publica no GitHub -> amigos atualizam sozinhos
```
Requer Node.js, .NET 10 SDK e `gh` logado.

- `src/main.js` – processo principal (janela, sala em segundo plano, procura de salas, atualização)
- `src/room-server.js`, `src/signaling.js` – servidor da sala (processo próprio, sobrevive ao app)
- `src/helper-host.js` – processo que roda o AudioHelper e fala direto com a interface
- `src/renderer/` – interface, WebRTC, `native-video.js` (vídeo nativo no WebRTC)
- `audio-helper/` – `VideoStreamer.cs` (captura + encoder), `HdrToneMapper.cs`, `Program.cs` (áudio por app)
