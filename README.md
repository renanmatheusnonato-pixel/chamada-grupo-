# 🎥 Chamada em Grupo

Aplicativo desktop (Windows/Mac/Linux) estilo Discord, com identidade visual própria:

- **Perfil completo**: foto, banner, nome, status e "sobre mim" — clique em qualquer pessoa para ver o cartão de perfil (sem senha; um código de acesso permite usar a conta em outro PC)
- **Cargos por grupo**: o dono (ou quem tiver a permissão) cria cargos com nome, cor e permissões — enviar mensagens, entrar na voz, ver convite, apagar mensagens, expulsar, editar o grupo, gerenciar cargos — e atribui aos membros pelo cartão de perfil. Lista de membros agrupada por cargo e nomes coloridos, como no Discord
- **Amigos** — adicione pelo nome, veja quem está online / em chamada
- **Mensagens diretas** e **grupos** com chat persistente (histórico fica no servidor)
- **Grupos** com código de convite, ícone, dono, lista de membros e canal de voz
- **Chamadas** de voz/vídeo em malha (até 8 por canal) com **toque** para quem recebe e área de chamada **compacta** — você navega pelo app enquanto fala, como no Discord ("Voz conectada" no canto)
- **Compartilhamento de tela** com seletor de telas/janelas e opção de enviar o áudio do computador
- **Soundboard**: 13 efeitos prontos + seus MP3/WAV — todo mundo na chamada ouve
- **Efeitos de voz** em tempo real (grave, agudo, monstro, robô, alien, eco, caverna, rádio)
- **Gravação da chamada** (vídeo em grade + áudio mixado) em `.webm`
- **Tema escuro (preto) ou claro**, ou automático pelo sistema — botão ☀️/🌙 no painel do usuário
- **Emojis de alta qualidade** (Twemoji) em todo o app + seletor de emojis no chat; mensagens só com emoji aparecem grandes
- Notificações e badges de não lidas; atalhos `1`–`9` (sons), `0` (parar), `M` (mudo), `C` (câmera); globais `Ctrl+Alt+1..9 / 0 / M`

## Personalizar a identidade

Edite [`app/renderer/branding.js`](app/renderer/branding.js): nome, logo (emoji), cores de destaque e servidor padrão. Nada mais precisa mudar. Para o ícone do instalador, coloque um `build/icon.ico` (256×256) em `app/` antes de rodar `npm run dist`.

Os emojis usam o [Twemoji](https://github.com/jdecked/twemoji) (gráficos © Twitter/X e colaboradores, licença CC-BY 4.0), carregados do CDN jsDelivr; sem internet o app volta aos emojis do sistema. Os ícones dos botões são SVG próprios em `app/renderer/js/icons.js`.

## Estrutura

```
chamada-grupo/
├── server/   # Node.js + WebSocket: contas, amigos, grupos, chat, presença, sinalização WebRTC (dados em data.json)
└── app/      # Electron (vira .exe). A mesma interface também roda no navegador via servidor.
```

## Rodando localmente

Requer [Node.js 18+](https://nodejs.org).

```bash
cd server && npm install && npm start      # http://localhost:3000
```
```bash
cd app && npm install && npm start
```

> Se o `npm install` do `app/` avisar sobre scripts bloqueados (npm 11+), rode `npm approve-scripts electron` e `npm rebuild electron`.

Na primeira abertura, escolha um nome. Para testar com duas pessoas no mesmo PC, abra o app e também `http://localhost:3000` no navegador com outro nome.

## Publicando o servidor (para usar pela internet)

O servidor é leve: guarda contas/mensagens e apenas "apresenta" os participantes — o áudio/vídeo vai direto entre os PCs.

**Render** (grátis)
1. Suba a pasta num repositório GitHub.
2. [render.com](https://render.com) → *New → Web Service* → *Root Directory* `server`, *Build* `npm install`, *Start* `npm start`.
3. Adicione um **Disk** (ex.: 1 GB montado em `/data`) e a variável `DATA_FILE=/data/data.json` para o histórico sobreviver a reinícios.
4. Copie a URL (ex.: `https://chamada-xyz.onrender.com`) e coloque `wss://chamada-xyz.onrender.com` em `branding.js` (`defaultServer`) ou em ⚙️ Configurações → Servidor.

Quem não quiser instalar entra pelo navegador em `https://chamada-xyz.onrender.com`.

### TURN

Redes restritas podem bloquear a conexão direta. O app já traz o TURN público do Open Relay; para algo mais confiável, use uma conta grátis em [metered.ca](https://www.metered.ca/tools/openrelay/) ou um [coturn](https://github.com/coturn/coturn) próprio e preencha em ⚙️ Configurações.

## Gerando o instalador (.exe)

```bash
cd app && npm run icon        # gera build/icon.png e icon.ico a partir do logo do branding.js
cd app && npm run dist        # sai em app/dist/Chamada em Grupo-Setup-1.0.0.exe
```

Antes de distribuir, coloque o endereço público do seu servidor em `branding.js` → `defaultServer` (ex.: `wss://chamada-xyz.onrender.com`) e gere o instalador de novo — assim quem instalar já entra conectado, sem configurar nada.

> **Windows sem Modo Desenvolvedor:** o electron-builder pode falhar com "Cannot create symbolic link" ao extrair o pacote `winCodeSign`. Solução: extraia o `.7z` que ficou em `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\` com `7za x -xr!darwin` para a pasta `winCodeSign-2.6.0` (no mesmo lugar) e rode `npm run dist` de novo. Ou ative o Modo Desenvolvedor do Windows.

> O instalador não é assinado digitalmente (certificado custa ~US$ 200/ano). Na primeira execução o Windows mostra o aviso do SmartScreen: clique em **Mais informações → Executar assim mesmo**.

O deploy do servidor também pode ser feito com o Blueprint [`render.yaml`](render.yaml) (Render → New → Blueprint → escolher o repositório).

## Como funciona (para desenvolvedores)

- `server/server.js` — protocolo JSON sobre WebSocket; cada grupo tem `roles`, `memberRoles` e `everyone` (permissões base). Toda ação sensível é validada no servidor (`requireGroup(user, groupId, perm)`). Fotos/banners são salvos como data URL redimensionada (256×256 / 960×340).
- `server/server.js` — protocolo JSON sobre WebSocket: requisições (`reqId` → `res`) e eventos (`presence`, `message`, `voice-state`, `ring`, `signal`…). Canais: `g:<grupo>` e `dm:<idA>:<idB>`.
- `app/renderer/js/app.js` — estado + renderização da interface (trilho, barra lateral, chat, área de chamada, painel de voz, modais).
- `app/renderer/js/voice.js` — `VoiceSession`: conexões WebRTC em malha (quem entra faz a oferta), câmera/tela via `replaceTrack`, gravação.
- `app/renderer/js/audio.js` — grafo Web Audio: microfone → efeito → barramento (+ soundboard) → faixa enviada na chamada.
- `app/main.js` — janela Electron, seletor de tela próprio (`setDisplayMediaRequestHandler`), salvar arquivo, atalhos globais.
