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
