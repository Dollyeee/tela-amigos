// Novidades de cada versão, a mais nova primeiro. É o que a tela "Novidades" mostra (ver news.js): ela abre
// sozinha uma vez depois de cada atualização e fica no rodapé da tela de entrada para quem quiser rever.
//
// A CADA VERSÃO PUBLICADA: pôr uma entrada nova no topo, com o número que a versão vai ter (o `npm run release`
// confere e não publica sem ela). Escrever para os amigos, em linguagem simples: o que mudou para quem usa,
// não o que mudou no código.
//   v      número da versão (igual ao do package.json depois do release)
//   title  a novidade principal, numa frase curta
//   text   (opcional) um parágrafo de apresentação
//   themes (opcional) true mostra a galeria de temas, com clique para trocar
//   items  (opcional) lista de frases; **assim** fica em negrito
const CHANGELOG = [
  {
    v: '1.0.65',
    title: 'Conserto: servidor de vídeo quando a conexão direta não fecha',
    items: [
      'Na 1.0.64, com "Servidor de vídeo quando precisar" ligado, quem tem a rede fechada para conexões diretas transmitia e parte da sala não via nada (a conexão ficava "conectando" para sempre). Agora, se alguém que assiste está há mais de 8 segundos sem conexão direta com você, sua tela vai pelo servidor.',
      'Também vai pelo servidor quando o seu PC não dá conta de codificar a tela uma vez para cada amigo (jogo pesado na captura adaptativa): pelo servidor ela é codificada uma vez só.',
    ],
  },
  {
    v: '1.0.64',
    title: 'Transmissão mais esperta e barra das telas mais simples',
    items: [
      '**Barra de cada tela mais simples:** ficam à vista só volume, caneta, salvar clipe, focar e tela cheia (o de focar ganhou um desenho próprio, antes era igual ao de tela cheia). O resto está no "⋯", organizado em grupos.',
      '**Versão leve na "Nativa direta":** quem vê a sua tela em miniatura, ou está com a rede fraca, recebe uma versão mais leve (960x540, 30 fps). Os outros continuam no máximo: um amigo com rede ruim não puxa mais a qualidade de todo mundo para baixo.',
      '**Servidor de vídeo só quando precisa:** com a opção ligada (sala online), a tela vai direto para os amigos e só passa pelo servidor quando o seu upload não dá conta de mandar para todos, ou quando a conexão direta com alguém cai. O limite grátis do mês dura bem mais.',
      '**Tema em tudo:** a janelinha da sobreposição, a de escolher a área da tela e o gráfico do histórico agora seguem o tema escolhido.',
    ],
  },
  {
    v: '1.0.63',
    title: 'Os temas ganharam vida',
    text: 'Agora cada tema reage ao que acontece na sala: quando alguém entra, começa a transmitir ou manda mensagem. E alguns têm detalhes que se mexem sozinhos. Escolha um tema aqui embaixo e entre numa sala para ver.',
    themes: true,
    items: [
      '**Fliperama:** as estrelas piscam, o bonequinho de quem chega pula e aparece "JOGADOR 2 ENTROU!" no alto; as mensagens surgem letra por letra.',
      '**Toca-fitas:** as bobinas giram na fita de quem está ao vivo e o ponteiro acompanha o som da tela.',
      '**Sessão:** as luzes da sala apagam quando alguém começa a transmitir, e as lâmpadas do "Compartilhar tela" correm.',
      '**Varanda:** as folhas balançam com a brisa, os festões do toldo balançam quando o mouse passa e, à noite, aparecem vaga-lumes.',
      'Nos outros: o **Neon** pisca o letreiro quando alguém entra, o **Terminal** digita as mensagens, o **Caderno** circula o "ao vivo!", a **Planta** desenha as medidas da tela nova, a **Arena** vira o placar, e a **Galeria** e o **Clássico** fazem tudo de um jeito mais discreto.',
      'Tudo para sozinho quando você está jogando em tela cheia, no modo leve ou com a janela minimizada. Quem desligou as animações do Windows não vê nada se mexendo.',
      '**Consertos:** no Varanda (dia e noite), transmitindo no modo Grade ou sozinho, o "Parar" caía em cima do "Trocar tela" e a Câmera e as Estatísticas sumiam. No Clássico, a barra de cima ficava espremida, com os botões quebrando em duas linhas; agora, quando falta espaço, os botões de apoio viram só o ícone.',
    ],
  },
  {
    v: '1.0.62',
    title: 'Cada tema se instala do seu jeito',
    text: 'Agora, quando você troca de tema, ele se instala com uma animação no estilo dele: o toldo da Varanda desce, o Neon acende piscando, as cortinas da Sessão abrem, o Fliperama carrega em blocos… Clique num tema aqui embaixo para ver.',
    themes: true,
    items: [
      'Cada um tem a sua: o Clássico abre num círculo, o Arena passa uma faixa vermelha, a Galeria monta a exposição, o Caderno vira a página, a Planta é desenhada pelo plotter, o Terminal digita a instalação e o Toca-fitas troca a fita.',
      'Leva menos de 2 segundos, e as telas dos amigos continuam passando durante a animação.',
      'Quem desligou as animações do Windows vê a troca na hora, como antes.',
    ],
  },
  {
    v: '1.0.61',
    title: 'Temas: escolha a cara do app',
    text: 'São dez visuais novos, além do Clássico. Clique em um para experimentar agora: muda só para você e dá para trocar quando quiser.',
    themes: true,
    items: [
      'Cada tema tem os próprios **emotes**, **mãozinha** e **riscos da caneta**.',
      'Cada um usa o seu: ninguém vê o tema do outro.',
      'Para trocar depois: **Opções → Aparência → Tema**, ou "Tema" no rodapé da tela de entrada.',
      '**Novo: esta tela de novidades.** Ela aparece uma vez depois de cada atualização, contando o que mudou.',
      '**Fliperama mais legível:** a letra de pixel deixava o "c" igual ao "o" ("Tuca" virava "Tuoa"). Agora botões, rótulos e avisos usam a letra dos títulos, e os nomes saem com o acento certo.',
      'Outros consertos nos temas: botão "Parar" fora do lugar ao trocar do Fliperama para outro tema; tela de entrada do Toca-fitas cortada com a janela pequena.',
    ],
  },
];

// (no app é uma lista global; o script de release e o teste leem o mesmo arquivo pelo Node)
if (typeof module !== 'undefined' && module.exports) module.exports = CHANGELOG;
else window.CHANGELOG = CHANGELOG;
