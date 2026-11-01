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
- **Telas lisas enquanto joga**: com jogo pesado aberto, o app ganha prioridade alta na placa de vídeo e as telas dos amigos ganham ~0,15 s de buffer para não engasgar. Dica: limitar o FPS do jogo (ex.: 3 abaixo da taxa do monitor) deixa a placa com folga e ajuda muito.
- **Registro de problemas**: tudo fica em `%APPDATA%\Tela Amigos\logs`; se a tela do app cair, ela recarrega sozinha.
- **Ajustes** durante a transmissão: qualidade muda na hora; resolução/FPS/captura sem parar.
- Layouts **Grade** e **Foco** (miniaturas embaixo). Duplo clique foca/desfoca; **Esc** sai da tela cheia e do foco;
  arraste pela alça ⋮⋮ para reorganizar; picture-in-picture.
- **Volume**: rodinha do mouse sobre a tela; lembrado por amigo; as telas abrem mutadas.
- **Ocultar** a tela de alguém para de receber o vídeo/áudio dela.
- **Áudio**: "Todo o som do PC, exceto Discord" ou "Só: <app>". O som deste app nunca é reenviado.
- Sala resistente a quedas: reconecta sozinha sem derrubar as telas.
- **Câmera** estilo streamer: com tela + câmera, a câmera fica no canto da imagem.
- **Sobreposição**: janelinha da tela de um amigo sempre por cima do jogo; "Travar" deixa o mouse atravessar.
- **Chat**, **reações** com emoji e **mãozinha**: segure o botão direito sobre a tela de alguém e mova;
  clique esquerdo (ou clique rápido com o direito) "aperta"; Shift desenha um rastro. Quem transmite vê a mãozinha
  no próprio monitor, sem aparecer na transmissão.
- A **câmera** de cada amigo pode ser arrastada e redimensionada (rodinha) na tela dele; fica salvo por amigo.
- **Clipes**: ligue o replay numa tela e salve os últimos 30 s em MP4 (Vídeos\Tela Amigos).
- Qualidade de cada tela (bolinha verde/amarela/vermelha), **modo leve** automático quando o PC está no limite,
  prévia escondida automaticamente ao jogar em tela cheia, notificações, ícone na bandeja.
- Atalhos globais: **Ctrl+Shift+S** transmitir/parar · **M** mutar todos · **O** destravar sobreposição · **C** salvar clipe.
- **Enviar diagnóstico**: gera um .txt na Área de Trabalho com tudo o que ajuda a achar problemas.
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
