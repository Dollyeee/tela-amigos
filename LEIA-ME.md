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

**Sem Radmin (sala online):** uma pessoa clica em **Criar sala online** e manda o código de 6 letras/números
(aparece no topo da sala, clique para copiar). Os outros digitam o código no campo de entrar. O vídeo vai
direto entre os PCs pela internet; só as mensagens de conexão passam pelo servidor.

## Recursos
- **Captura nativa 60 fps** (H.264 na placa de vídeo) que se adapta à rede;
  "Nativa direta" para rede perfeita; "Chromium" para compatibilidade.
  No Windows 11 captura com Windows Graphics Capture; no Windows 10 com DXGI Desktop Duplication,
  porque lá o WGC desenha uma **borda amarela** ao redor da tela transmitida que não dá para tirar
  (`TELA_CAPTURE=wgc` ou `=dxgi` força um dos dois).
- **Codec automático**: usa **H.265 (HEVC)** quando quem envia e quem recebe têm placa com suporte (mesma imagem com ~30-40% menos Mb/s); senão H.264. Dá para fixar em "Compartilhar".
- **Bitrate automático**: ao conectar com cada amigo, o app mede sozinho o seu envio até ele (~3 s) e ajusta o orçamento de upload e o teto daquele amigo (o controle "Qualidade" vira o máximo). O resultado aparece em Ajustes. O "Testar conexão" continua lá para uma medição completa (ida e volta).
- **H.265 também na "Nativa direta"** quando todos decodificam; se entrar alguém sem suporte, a transmissão volta sozinha para H.264.
- **Fim das travadas de ~3 s na "Nativa direta"** (v1.0.58): os quadros da placa viajam dentro de uma trilha "vazia" do Chromium. Essa trilha gerava um quadro-chave próprio ~3,5 vezes por segundo, e a cada um deles o Chromium jogava fora o que ainda esperava para sair: o quadro da placa sumia pela metade, sem perda de pacote aparente, e quem assistia ficava com a imagem parada até pedir um quadro completo (era a causa do "0 fps esperando imagem" com a rede boa). Agora a trilha vazia fica quase parada (não gera mais esses quadros-chave) e, quando o Chromium gera um mesmo assim, ele não leva nenhum quadro da placa. Vale também para a "Nativa direta" pelo servidor de vídeo. `node scripts/direct-test.js [H264|HEVC|AV1]` confere isso com a captura e o encoder de verdade (duas cópias escondidas, sem áudio): cruza quadro a quadro o que saiu com o que o receptor montou.
- **Menos banda com a tela calma**: o encoder da placa ganhou um piso de qualidade (QP 16; 18 no H.265). Sem ele, com a imagem quase parada, a taxa constante gastava 1,5 a 3 Mb/s refinando além do que se vê; agora a tela calma usa uma fração disso (medido: quadro típico de ~2,7 KB para ~0,3 KB em H.264), sem diferença visível. Em movimento nada muda. Sobra upload para o jogo de quem transmite e o limite mensal do servidor de vídeo rende mais.
- **Bitrate da "Nativa direta" por caminho**: cada amigo é avaliado sozinho, com o ping normal *dele*. Só corta com evidência de que a ida até ele está cheia (perda alta, ou duas "testemunhas" juntas: atraso, perda, a estimativa de banda do WebRTC, o amigo avisando que recebe menos do que você manda). Um pico de ping de um amigo não derruba mais a transmissão de todos; atraso que não melhora cortando (é da volta do caminho ou de outro tráfego dele) é ignorado. Depois de um corte, volta rápido até perto de onde estava. `node scripts/netctl-test.js` roda o controle numa rede simulada.
- **Mais quadros com jogo pesado**: quando o encoder da placa atrasa, o app espera ele liberar e manda o quadro na hora (antes descartava e esperava o próximo intervalo: de 30 quadros/s saíam 19). A captura pede prioridade alta na placa e, no Windows 11 24H2+, só captura os quadros que vai usar (em monitor de 144/240 Hz copiava todos).
- **H.265/AV1 pelo servidor de vídeo**: o app usa uma conexão para publicar e outra para puxar (numa só, quem transmitia e assistia ao mesmo tempo dava erro de codec). Com todos na versão nova, a "Nativa direta" pelo servidor usa H.265/AV1: mesma imagem com ~35% menos GB.
- **Limite do mês do servidor de vídeo**: o uso aparece ao lado da opção; ao atingir o limite a sala avisa e todos seguem pela conexão direta (antes só as sessões novas eram recusadas).
- **HDR → SDR automático**: quem joga com HDR ligado aparece com as cores certas para quem assiste.
- **Telas lisas enquanto joga**: com jogo pesado aberto, o app ganha prioridade alta na placa de vídeo e as telas dos amigos ganham ~0,15 s de buffer para não engasgar. Dica: limitar o FPS do jogo (ex.: 3 abaixo da taxa do monitor) deixa a placa com folga e ajuda muito.
- **Sala sobrevive à atualização**: o instalador fecha tudo que roda da pasta do app; se a sua sala estava aberta, ela reabre sozinha quando o app volta (os amigos reconectam sozinhos).
- **Zoom**: Ctrl + rodinha aproxima a tela de um amigo no ponto do mouse (até 600%); arraste para mover; ✕ ou Ctrl+0 volta.
- **Atraso por amigo**: botão de relógio na tela dele: *Automático* (mínimo, +0,15 s com jogo pesado), *Atraso mínimo* (jogar junto) ou *Imagem lisa* (+0,35 s, para rede instável). Fica salvo por amigo.
- **2ª tela**: transmitindo, clique em **+ 2ª tela** e escolha outra tela ou janela (30 fps). Ela aparece no canto da sua tela principal; cada amigo arrasta, troca com a principal (⇄ ou duplo clique) ou esconde (✕), e só recebe enquanto ela está à vista.
- **Resolução por amigo**: botão de resolução na tela dele: *Automático* (original; cai para 720p sozinho se o seu PC apertar), *Original*, 1080p, 720p ou 480p. Quem transmite reduz só para você (na *Nativa direta* o vídeo é o mesmo para todos).
- **Som de uma saída** (Sonar/Voicemeeter): em *Áudio*, as opções *Saída: ...* mandam todo o som de uma saída do PC, ex. o canal de jogo (*SteelSeries Sonar - Gaming*, *Voicemeeter Input*). Deixe o Tela Amigos e o Discord em outro canal, senão os amigos ouvem eco (o app avisa).
- **Resolução inteligente** (prioridade *Movimento*): quando a rede até um amigo não dá banda para a resolução atual (ex.: 1080p60 em 5 Mb/s, que fica todo quadriculado), a transmissão desce um degrau (1080p → 720p → 540p) só para ele e volta sozinha quando a rede melhora. Na *Nativa direta* vale para todos e a captura reinicia no novo tamanho (aviso na tela).
- **Foto da tela**: botão de câmera (ou tecla P na tela em foco) salva a imagem na resolução que está chegando em Imagens\Tela Amigos e copia para colar no Discord.
- **Histórico da qualidade**: botão de gráfico na tela do amigo mostra os últimos 10 min (fps, Mb/s, ping, travadas e a causa de cada momento ao passar o mouse). Também vai no diagnóstico.
- **Bandeja**: o ícone ganha uma bolinha vermelha quando você está ao vivo e verde quando um amigo está; o menu mostra quem está na sala e clicar num amigo ao vivo abre a tela dele.
- **AV1 na Nativa direta**: se você e todos os amigos tiverem placa que decodifica AV1 (RTX 30/40, RX 6000/7000, Intel Arc) e a sua codificar (RTX 40, RX 7000, Arc), a Nativa direta usa AV1 (mais qualidade pelo mesmo Mb/s); senão H.265 ou H.264.
- **Diagnóstico do amigo com um clique**: passe o mouse no nome dele na lista e clique em 🩺; o diagnóstico dele chega na sua Área de Trabalho.
- **Abrir com o Windows** e **Entrar sozinho na última sala** (Opções): o app abre só na bandeja e entra na sala de antes (quem hospeda reabre a própria).
- **Registro de problemas**: tudo fica em `%APPDATA%\Tela Amigos\logs`; se a tela do app cair, ela recarrega sozinha.
- **Ajustes** durante a transmissão: qualidade muda na hora; resolução/FPS/captura sem parar.
- Layouts **Grade** e **Foco** (miniaturas embaixo). Duplo clique foca/desfoca; **Esc** sai da tela cheia e do foco;
  arraste pela alça ⋮⋮ para reorganizar; picture-in-picture.
- **Volume**: rodinha do mouse sobre a tela; vai até **300%** (acima de 100% fica laranja; duplo clique no controle volta a 100%); lembrado por amigo; as telas abrem mutadas.
- **Nivelar volume das telas** (Opções, ligado por padrão): aumenta sozinho quem está baixo (até 4x), sem abaixar ninguém; um limitador evita estourar.
- **Ocultar** a tela de alguém para de receber o vídeo/áudio dela.
- **Áudio**: "Todo o som do PC, exceto Discord" ou "Só: <app>". O som deste app nunca é reenviado.
- Sala resistente a quedas: reconecta sozinha sem derrubar as telas.
- **Câmera** estilo streamer: com tela + câmera, a câmera fica no canto da imagem.
- **Sobreposição**: janelinha da tela de um amigo sempre por cima do jogo; "Travar" deixa o mouse atravessar.
- **Chat**, **reações** com emoji e **mãozinha**: segure o botão direito sobre a tela de alguém e mova;
  clique esquerdo (ou clique rápido com o direito) "aperta"; Shift desenha um rastro. Quem transmite vê a mãozinha,
  os desenhos e os emotes no próprio monitor, sem aparecer na transmissão (cada um com sua opção em Opções).
- A **câmera** de cada amigo pode ser arrastada e redimensionada (rodinha) na tela dele; fica salvo por amigo.
- **Clipes**: ligue o replay numa tela e salve os últimos 30 s em MP4 (Vídeos\Tela Amigos).
- **Gravação longa**: botão de câmera de vídeo na tela grava sem limite de tempo (com a câmera do amigo e o
  mesmo áudio dos clipes). Clique de novo para parar; o arquivo fica em Vídeos\Tela Amigos e continua
  aproveitável mesmo se o app fechar no meio.
- **Status nas telas**: fps e ping no canto de cada tela e, quando piora, de quem é o problema
  ("rede", "PC do Fulano" ou "seu PC").
- **Testar conexão**: mede ping e velocidade com cada amigo pelo Radmin e sugere a qualidade (botão "Usar sugestão").
- **Escolher área**: no "Compartilhar", depois de escolher uma tela, transmita só um pedaço dela (mapa do jogo,
  metade de um ultrawide...). Só na captura nativa.
- **Mixer**: em Ajustes, durante a transmissão, o volume de cada app no som que os amigos ouvem (fica salvo).
- **Assistir junto**: botão ⏯ na tela de um amigo pede play/pausa no vídeo dele (ele precisa ligar
  "Amigos controlam play/pausa" nas Opções). "Todo mundo pronto?" faz cada um confirmar e conta 3, 2, 1;
  no "já" o vídeo de quem está em foco começa sozinho.
- **Caneta**: botão de lápis numa tela; arraste com o botão esquerdo para desenhar. Os traços ficam ~8 s para
  todos (e no monitor de quem transmite) e depois somem; "Apagar" tira os seus na hora; Esc desliga.
- Qualidade de cada tela (bolinha verde/amarela/vermelha), **modo leve** automático quando o PC está no limite,
  prévia escondida automaticamente ao jogar em tela cheia, notificações, ícone na bandeja.
- Atalhos globais: **Ctrl+Shift+S** transmitir/parar · **M** mutar todos · **O** destravar sobreposição · **C** salvar clipe.
- **Enviar diagnóstico**: gera um .txt na Área de Trabalho com tudo o que ajuda a achar problemas.
- **Estatísticas** (S): FPS, bitrate, ping, buffer, travadas, perdas, rota, encoder.
- **Rota por amigo** (menu de resolução na tela dele → "Conexão"): *Automática* troca sozinha para a internet direta quando o Radmin trava (ping alto/perdas por ~30 s) e volta se não conectar em 15 s; *Pelo Radmin/VPN* ou *Internet direta* fixam. Fica salvo por amigo.
- **Freio na "Nativa direta"**: quando o ping começa a subir (fila se formando no caminho) o bitrate cai na hora e volta devagar; quedas seguidas do mesmo amigo não disparam uma enxurrada de quadros-chave para todos.
- **Transmitir pelo servidor (beta, sala online)**: você manda uma cópia só e o servidor repassa para cada amigo.
  Na *Nativa direta* vai a imagem da placa de vídeo (H.264/H.265/AV1, uma qualidade, como o Discord): o bitrate
  segue a sua conexão até o servidor e o amigo mais fraco. Na *Nativa adaptativa* o Chromium manda 3 qualidades
  e cada amigo recebe a que a rede dele aguenta (o app baixa para a média por um tempo quando há perda).
- **Quadros-chave raros** (a cada 30 s, ou na hora quando alguém entra/perde a imagem): antes a imagem "respirava"
  a cada 4 s.
- **Reconexão automática com o servidor de vídeo**: se a conexão com o servidor cair ou travar, quem transmite volta a mandar direto na hora (sem tela preta) e em ~1,5 s tudo é refeito numa conexão nova. Se nada chegar do servidor por 6 s, quem assiste passa a receber direto sozinho. Caiu 3 vezes em 3 minutos: fica 5 minutos só na conexão direta.
- **Tela do amigo travada em 0 fps se arruma sozinha**: se ele está mandando imagem e nada aparece aqui, o app pede um quadro completo (3 s), refaz o caminho do vídeo (9 s) e, se ainda não voltou, refaz a conexão só com esse amigo (20 s), o mesmo que sair e entrar na sala. Tela parada de verdade (nada mudando) não conta.
- **Captura travada com jogo aberto**: se a captura de quem transmite ficar em 0 fps com um jogo aberto (placa de vídeo reiniciou, jogo em tela cheia exclusiva), o app reinicia a captura sozinho em 6 s; se travar de novo, passa para a captura do Chromium e sugere colocar o jogo em "Tela cheia sem bordas". Se a captura começar e não mandar nenhuma imagem em 10 s (só o som), faz o mesmo.

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
- `online-server/` – sala online (Cloudflare Worker + Durable Object; mesmo protocolo de `signaling.js`).
  Publicar: `cd online-server && npx wrangler login && npx wrangler deploy`; depois pôr a URL `wss://...`
  em `ONLINE_SERVER_DEFAULT` (`src/renderer/app.js`). TURN opcional: `npx wrangler secret put TURN_KEY_ID`
  e `TURN_KEY_API_TOKEN` (chave TURN do Cloudflare Realtime).
  Servidor de vídeo (opção "Transmitir pelo servidor (beta)"): criar um app de SFU em Cloudflare Realtime e
  `npx wrangler secret put SFU_APP_ID` / `SFU_APP_TOKEN`. O servidor da sala soma os GB do mês e recusa
  novas sessões acima de `SFU_MONTHLY_GB` (padrão 900, abaixo dos 1.000 GB grátis).
