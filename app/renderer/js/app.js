// Aplicação: perfil, amigos, grupos, chat persistente, chamadas de voz/vídeo (painel compacto), soundboard e efeitos.
(function () {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const api = window.electronAPI || null;
  const isElectron = !!api;
  const B = window.BRANDING || {};

  // ---------------- Marca ----------------
  document.documentElement.style.setProperty('--accent', B.accent || '#7c5cff');
  document.documentElement.style.setProperty('--accent-2', B.accent2 || '#ff5c8a');
  document.documentElement.style.setProperty('--accent-soft', (B.accent || '#7c5cff') + '2e');
  if (B.online) document.documentElement.style.setProperty('--online', B.online);
  document.title = B.name || 'Chamada em Grupo';
  $('#welcomeTitle').textContent = B.name || 'Chamada em Grupo';
  $('#welcomeTagline').textContent = B.tagline || '';
  $('#welcomeLogo').innerHTML = Emoji.imgHtml(B.logo || '🎥');

  // ---------------- Tema ----------------
  const mediaDark = window.matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    const pref = settings.theme || 'dark';
    document.documentElement.dataset.theme = pref === 'system' ? (mediaDark.matches ? 'dark' : 'light') : pref;
    if (S.me) renderUserPanel();
  }
  function setTheme(pref) { settings.theme = pref; saveSettings(); applyTheme(); }
  mediaDark.addEventListener('change', () => { if (settings.theme === 'system') applyTheme(); });

  // ---------------- Configurações ----------------
  const defaults = {
    theme: 'dark',
    name: '', token: '',
    server: isElectron ? (B.defaultServer || 'ws://localhost:3000') : (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host,
    turnUrl: 'turn:openrelay.metered.ca:80,turn:openrelay.metered.ca:443,turn:openrelay.metered.ca:443?transport=tcp',
    turnUser: 'openrelayproject', turnPass: 'openrelayproject',
    sfxVolume: 0.8, monitorVolume: 0.6, micId: '', camId: '', notifications: true,
  };
  const settings = Settings.load(defaults);
  const saveSettings = () => Settings.save(settings);
  document.documentElement.dataset.theme = settings.theme === 'system' ? (mediaDark.matches ? 'dark' : 'light') : (settings.theme || 'dark');
  function rtcConfig() {
    const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
    const urls = (settings.turnUrl || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (urls.length) iceServers.push({ urls, username: settings.turnUser, credential: settings.turnPass });
    return { iceServers };
  }

  // ---------------- Estado ----------------
  const S = {
    api: null, me: null, connected: false,
    groups: new Map(), friends: new Map(), users: new Map(),     // users: cache de quem já vimos (id -> {id,name,color,online,inVoice})
    voiceStates: new Map(),                                      // channel -> [users]
    view: { kind: 'friends' },                                   // {kind:'friends'} | {kind:'dm', userId} | {kind:'group', groupId}
    messages: new Map(), hasMore: new Map(), unread: new Map(),
    voice: null, engine: null, micStream: null, camStream: null, preMuted: false,
    sounds: [], expanded: false, rings: new Map(), ringAudio: null, perms: {},
  };
  window.__cg = S;

  // ---------------- Utilidades ----------------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const linkify = (s) => Emoji.html(esc(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>'));
  const em = (s) => Emoji.html(esc(s));
  const initial = (n) => (n || '?').trim().charAt(0).toUpperCase();
  const avatarHtml = (u, cls = '', status = true) => `<span class="avatar ${cls} ${u?.avatar ? 'has-img' : ''}" style="--c:${u?.color || '#666'}" data-user="${u?.id || ''}">${u?.avatar ? `<img src="${u.avatar}" alt="">` : esc(initial(u?.name))}${status ? `<i class="st ${u?.inVoice ? 'call' : u?.online ? 'on' : ''}"></i>` : ''}</span>`;
  // Cargos: cargo mais alto de um membro no grupo (para cor do nome)
  const rolesOf = (g, userId) => (g?.memberRoles?.[userId] || []).map((id) => g.roles.find((r) => r.id === id)).filter(Boolean).sort((a, b) => b.position - a.position);
  const roleColor = (g, userId) => rolesOf(g, userId)[0]?.color || null;
  const myPerms = (g) => g?.myPerms || {};
  const fmtTime = (ms) => { const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), p = (n) => String(n).padStart(2, '0'); return h ? `${h}:${p(m % 60)}:${p(s % 60)}` : `${p(m)}:${p(s % 60)}`; };
  const timeOf = (ts) => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const dayOf = (ts) => { const d = new Date(ts), t = new Date(); const y = new Date(); y.setDate(t.getDate() - 1); if (d.toDateString() === t.toDateString()) return 'Hoje'; if (d.toDateString() === y.toDateString()) return 'Ontem'; return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' }); };
  const dmChannel = (a, b) => 'dm:' + [a, b].sort().join(':');
  const channelOf = (view) => view.kind === 'dm' ? dmChannel(S.me.id, view.userId) : view.kind === 'group' ? 'g:' + view.groupId : null;
  const userOf = (id) => id === S.me?.id ? S.me : S.users.get(id) || { id, name: 'Usuário', color: '#666' };
  function rememberUser(u) { if (!u) return; const prev = S.users.get(u.id) || {}; S.users.set(u.id, { ...prev, ...u }); if (S.friends.has(u.id)) S.friends.set(u.id, S.users.get(u.id)); }
  function channelLabel(channel) {
    if (channel.startsWith('g:')) { const g = S.groups.get(channel.slice(2)); return g ? `${g.icon} ${g.name}` : 'Grupo'; }
    const other = channel.slice(3).split(':').find((id) => id !== S.me.id);
    return '@' + userOf(other).name;
  }
  const viewOfChannel = (ch) => ch.startsWith('g:') ? { kind: 'group', groupId: ch.slice(2) } : { kind: 'dm', userId: ch.slice(3).split(':').find((id) => id !== S.me.id) };
  function toast(text, type = '', ms = 4000) {
    const el = document.createElement('div');
    el.className = 'toast ' + type; el.textContent = text;
    Emoji.apply(el); $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  // ---------------- Boas-vindas ----------------
  function showWelcome(msg) {
    $('#welcome').classList.remove('hidden'); $('#app').classList.add('hidden');
    $('#welcomeName').value = settings.name || '';
    $('#welcomeServer').value = settings.server;
    $('#welcomeToken').value = '';
    const st = $('#welcomeStatus'); st.textContent = msg || ''; st.className = 'status' + (msg ? ' error' : '');
    setTimeout(() => $('#welcomeName').focus(), 50);
  }
  $('#welcomeBtn').onclick = () => {
    const name = $('#welcomeName').value.trim(), server = $('#welcomeServer').value.trim(), token = $('#welcomeToken').value.trim();
    const st = $('#welcomeStatus'); st.className = 'status';
    if (!/^wss?:\/\//.test(server)) { st.textContent = 'O servidor deve começar com ws:// ou wss://'; st.classList.add('error'); return; }
    if (!token && name.length < 2) { st.textContent = 'Escolha um nome com pelo menos 2 letras.'; st.classList.add('error'); return; }
    Object.assign(settings, { name, server, token: token || '' }); saveSettings();
    st.textContent = 'Conectando…';
    connect();
  };
  $('#welcomeName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#welcomeBtn').click(); });

  // ---------------- Conexão ----------------
  let authFailed = false;
  function connect() {
    if (S.api) S.api.close();
    authFailed = false;
    const a = new Api(settings.server);
    S.api = a;
    a.addEventListener('open', async () => {
      try {
        const data = await a.call('auth', { token: settings.token || undefined, name: settings.name || undefined });
        onAuth(data);
      } catch (e) {
        authFailed = true; a.close();
        settings.token = ''; saveSettings();
        showWelcome(e.message);
      }
    });
    a.addEventListener('close', () => { S.connected = false; if (!authFailed) { renderHeader(); renderUserPanel(); } if (S.voice) { hangUp(true); toast('Conexão com o servidor perdida. A chamada foi encerrada.', 'error'); } });
    a.addEventListener('reconnecting', (e) => { if (!S.me) { const st = $('#welcomeStatus'); st.textContent = `Servidor indisponível — tentando de novo (${e.detail.attempt})…`; st.className = 'status error'; } });
    a.addEventListener('kicked', (e) => { a.close(); toast(e.detail.reason, 'error', 8000); });
    a.addEventListener('presence', (e) => { rememberUser(e.detail.user); for (const g of S.groups.values()) { const m = g.members.find((x) => x.id === e.detail.user.id); if (m) Object.assign(m, e.detail.user); } renderAll(); });
    a.addEventListener('message', (e) => onMessage(e.detail.channel, e.detail.message));
    a.addEventListener('group-updated', (e) => { setGroup(e.detail.group); renderAll(); });
    a.addEventListener('friend-added', (e) => { rememberUser(e.detail.friend); S.friends.set(e.detail.friend.id, S.users.get(e.detail.friend.id)); toast(`${e.detail.friend.name} te adicionou como amigo.`, 'ok'); renderAll(); });
    a.addEventListener('friend-removed', (e) => { S.friends.delete(e.detail.userId); renderAll(); });
    a.addEventListener('message-deleted', (e) => { const l = S.messages.get(e.detail.channel); if (l) S.messages.set(e.detail.channel, l.filter((m) => m.id !== e.detail.messageId)); if (channelOf(S.view) === e.detail.channel) renderContent(); });
    a.addEventListener('group-removed', (e) => { S.groups.delete(e.detail.groupId); S.messages.delete('g:' + e.detail.groupId); toast(`Você foi removido do grupo "${e.detail.name}".`, 'error', 7000); if (S.view.kind === 'group' && S.view.groupId === e.detail.groupId) openView({ kind: 'friends' }); else renderAll(); });
    a.addEventListener('voice-state', (e) => { e.detail.users.forEach(rememberUser); S.voiceStates.set(e.detail.channel, e.detail.users); renderAll(); });
    a.addEventListener('ring', (e) => onRing(e.detail));
    a.addEventListener('ring-cancel', (e) => removeRing(e.detail.channel));
    a.addEventListener('call-declined', (e) => toast(`${e.detail.by.name} recusou a chamada.`));
    for (const t of ['voice-peer-joined', 'voice-peer-left', 'signal', 'voice-meta']) a.addEventListener(t, (e) => S.voice?.onServer(e.detail));
    a.connect();
  }

  function setGroup(g) { g.members.forEach(rememberUser); S.groups.set(g.id, g); if (S.view.kind === 'group' && S.view.groupId === g.id && !g.members.some((m) => m.id === S.me.id)) S.view = { kind: 'friends' }; }

  function onAuth(data) {
    S.me = data.user; S.connected = true; S.perms = data.perms || S.perms;
    watchWebVersion(data.webVersion);
    settings.token = data.token; settings.name = data.user.name; saveSettings();
    S.groups.clear(); data.groups.forEach(setGroup);
    S.friends.clear(); data.friends.forEach((f) => { rememberUser(f); S.friends.set(f.id, S.users.get(f.id)); });
    S.voiceStates = new Map(Object.entries(data.voice || {}));
    for (const list of S.voiceStates.values()) list.forEach(rememberUser);
    $('#welcome').classList.add('hidden'); $('#app').classList.remove('hidden');
    if (isElectron) $('#globalHotkeyHint').classList.remove('hidden');
    openView(S.view);
  }

  // No navegador, avisa quando o servidor recebe uma versão nova (no app instalado quem cuida disso é o auto-update)
  function watchWebVersion(version) {
    if (isElectron || !version || S.webVersion === version) return;
    if (!S.webVersion) { S.webVersion = version; return; }
    S.webVersion = version;
    const el = document.createElement('div');
    el.className = 'toast ok update-toast';
    el.innerHTML = `<b>Nova versão disponível</b><br>Recarregue para usar a versão atualizada. <button class="primary small">Recarregar</button>`;
    el.querySelector('button').onclick = () => location.reload();
    el.style.pointerEvents = 'auto';
    $('#toasts').appendChild(el);
  }

  // ---------------- Navegação ----------------
  function openView(view) {
    closeEmojiPicker(); closeProfile();
    S.view = view;
    S.expanded = false;
    const ch = channelOf(view);
    if (ch) { S.unread.delete(ch); if (!S.messages.has(ch)) loadHistory(ch); }
    renderAll();
    if (ch) { scrollChatToEnd(); setTimeout(() => $('#composerInput').focus(), 30); }
  }

  function renderAll() { if (!S.me) return; renderRail(); renderSidebar(); renderHeader(); renderContent(); renderCallArea(); renderVoicePanel(); renderUserPanel(); renderMembers(); updateTitle(); Emoji.apply($('#app')); }

  function updateTitle() {
    const total = [...S.unread.values()].reduce((a, b) => a + b, 0);
    document.title = (total ? `(${total}) ` : '') + (B.name || 'Chamada em Grupo');
  }

  function renderRail() {
    const homeUnread = [...S.unread.entries()].filter(([ch]) => ch.startsWith('dm:')).reduce((a, [, n]) => a + n, 0);
    let html = `<button class="rail-btn home ${S.view.kind !== 'group' ? 'active' : ''}" data-home title="Mensagens diretas">${em(B.logo || '💬')}${homeUnread ? `<span class="badge">${homeUnread}</span>` : ''}</button><div class="rail-sep"></div>`;
    for (const g of S.groups.values()) {
      const n = S.unread.get('g:' + g.id) || 0;
      const inVoice = (S.voiceStates.get('g:' + g.id) || []).length > 0;
      html += `<button class="rail-btn ${S.view.kind === 'group' && S.view.groupId === g.id ? 'active' : ''} ${inVoice ? 'in-voice' : ''}" data-group="${g.id}" title="${esc(g.name)}">${em(g.icon)}${n ? `<span class="badge">${n}</span>` : ''}</button>`;
    }
    html += `<button class="rail-btn add" data-add title="Criar ou entrar em um grupo">${ICON.plus}</button>`;
    $('#rail').innerHTML = html;
    $('#rail [data-home]').onclick = () => openView({ kind: 'friends' });
    $$('#rail [data-group]').forEach((b) => { b.onclick = () => openView({ kind: 'group', groupId: b.dataset.group }); });
    $('#rail [data-add]').onclick = openGroupModal;
  }

  function renderSidebar() {
    const el = $('#sidebar');
    if (S.view.kind !== 'group') {
      let html = `<div class="sidebar-head">Mensagens diretas</div>
        <button class="item big ${S.view.kind === 'friends' ? 'active' : ''}" data-friends><span class="ico">${ICON.users}</span><span class="name">Amigos</span></button>
        <div class="section-title">Conversas <button data-addfriend title="Adicionar amigo">${ICON.plus}</button></div>`;
      const friends = [...S.friends.values()].sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
      if (!friends.length) html += `<p class="empty-note">Adicione amigos pelo nome de usuário para conversar e ligar.</p>`;
      for (const f of friends) {
        const ch = dmChannel(S.me.id, f.id);
        const n = S.unread.get(ch) || 0;
        const inCall = (S.voiceStates.get(ch) || []).length > 0;
        html += `<button class="item ${S.view.kind === 'dm' && S.view.userId === f.id ? 'active' : ''}" data-dm="${f.id}">${avatarHtml(f, 'sm')}<span class="name">${esc(f.name)}<span class="sub ${inCall ? 'call' : ''}">${inCall ? 'Em uma chamada' : f.inVoice ? 'Em outra chamada' : f.online ? 'Online' : 'Offline'}</span></span>${n ? `<span class="badge">${n}</span>` : ''}</button>`;
      }
      el.innerHTML = html;
      $('#sidebar [data-friends]').onclick = () => openView({ kind: 'friends' });
      $('#sidebar [data-addfriend]').onclick = openAddFriendModal;
      $$('#sidebar [data-dm]').forEach((b) => { b.onclick = () => openView({ kind: 'dm', userId: b.dataset.dm }); });
      return;
    }
    const g = S.groups.get(S.view.groupId);
    if (!g) { el.innerHTML = ''; return; }
    const ch = 'g:' + g.id;
    const inVoice = S.voiceStates.get(ch) || [];
    const isHere = S.voice?.channel === ch;
    let html = `<div class="sidebar-head"><span>${em(g.icon)} ${esc(g.name)}</span><button class="icon-btn" data-gmenu title="Opções do grupo">${ICON.chevron}</button></div>
      <div class="section-title">Canais de texto</div>
      <button class="item channel active"><span class="ico">${ICON.hash}</span><span class="name">geral</span></button>
      <div class="section-title">Canais de voz</div>
      <button class="item channel ${inVoice.length ? 'voice-active' : ''}" data-voice><span class="ico">${ICON.sound}</span><span class="name">Voz${isHere ? '<span class="sub call">Você está aqui</span>' : inVoice.length ? `<span class="sub">${inVoice.length} na chamada · clique para entrar</span>` : '<span class="sub">Clique para entrar</span>'}</span></button>`;
    if (inVoice.length) html += `<div class="voice-users">${inVoice.map((u) => `<div class="voice-user">${avatarHtml(u, 'sm', false)}<span>${esc(u.name)}</span></div>`).join('')}</div>`;
    if (g.invite) html += `<div class="section-title">Convite</div><p class="empty-note">Código: <code>${esc(g.invite)}</code> <button class="ghost small" data-copyinvite>${ICON.copy} Copiar</button></p>`;
    el.innerHTML = html;
    $('#sidebar [data-voice]').onclick = () => joinVoice(ch);
    $('#sidebar [data-gmenu]').onclick = (e) => openGroupMenu(g, e.currentTarget);
    const ci = $('#sidebar [data-copyinvite]'); if (ci) ci.onclick = () => { navigator.clipboard.writeText(g.invite).then(() => toast('Código copiado!', 'ok')); };
  }

  function renderHeader() {
    const h = $('#mainHeader');
    const conn = `<span class="conn ${S.connected ? 'ok' : 'bad'}" title="${S.connected ? 'Conectado' : 'Reconectando…'}"></span>`;
    if (S.view.kind === 'friends') { h.innerHTML = `<h2><span class="h-ico">${ICON.users}</span> Amigos</h2><span class="spacer"></span>${conn}`; return; }
    if (S.view.kind === 'dm') {
      const u = userOf(S.view.userId);
      const ch = dmChannel(S.me.id, u.id);
      const inCall = (S.voiceStates.get(ch) || []).length > 0;
      h.innerHTML = `${avatarHtml(u, 'sm')}<h2>${esc(u.name)} <span class="status-text">${inCall ? 'Em uma chamada' : u.online ? 'Online' : 'Offline'}</span></h2><span class="spacer"></span>
        ${S.voice?.channel === ch ? '' : `<button class="icon-btn" data-call title="Ligar">${ICON.phone}</button><button class="icon-btn" data-vcall title="Chamada de vídeo">${ICON.video}</button>`}${conn}`;
      const c = h.querySelector('[data-call]'); if (c) c.onclick = () => joinVoice(ch);
      const v = h.querySelector('[data-vcall]'); if (v) v.onclick = () => joinVoice(ch, true);
      return;
    }
    const g = S.groups.get(S.view.groupId);
    h.innerHTML = `<h2><span class="hash">${ICON.hash}</span> geral <span class="status-text">· ${esc(g?.name || '')}</span></h2><span class="spacer"></span>${conn}`;
  }

  // ---------------- Amigos ----------------
  function renderFriendsView() {
    const friends = [...S.friends.values()].sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
    const online = friends.filter((f) => f.online);
    let html = `<div class="friends-view">
      <div class="add-row"><h3>Adicionar amigo</h3><p class="hint">Digite o nome de usuário exato da pessoa (ela precisa já ter criado o perfil no app).</p>
        <div class="row"><input id="addFriendInput" type="text" placeholder="nome de usuário" class="ghost" style="flex:1"><button class="primary" id="addFriendBtn">Adicionar</button></div></div>
      <h3>Online — ${online.length}</h3>`;
    if (!online.length) html += `<p class="hint">Nenhum amigo online agora.</p>`;
    html += online.map(friendRow).join('');
    html += `<h3>Todos — ${friends.length}</h3>` + (friends.length ? friends.map(friendRow).join('') : '<p class="hint">Sua lista está vazia.</p>') + '</div>';
    $('#content').innerHTML = html;
    $('#addFriendBtn').onclick = () => addFriend($('#addFriendInput').value);
    $('#addFriendInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') addFriend(e.target.value); });
    $$('#content [data-msg]').forEach((b) => { b.onclick = () => openView({ kind: 'dm', userId: b.dataset.msg }); });
    $$('#content [data-callf]').forEach((b) => { b.onclick = () => { openView({ kind: 'dm', userId: b.dataset.callf }); joinVoice(dmChannel(S.me.id, b.dataset.callf)); }; });
    $$('#content [data-rmf]').forEach((b) => { b.onclick = async () => { if (!confirm(`Remover ${userOf(b.dataset.rmf).name} dos amigos?`)) return; await S.api.call('remove-friend', { userId: b.dataset.rmf }); S.friends.delete(b.dataset.rmf); renderAll(); }; });
  }
  const friendRow = (f) => `<div class="friend-row">${avatarHtml(f)}<div class="who"><strong>${esc(f.name)}</strong><span>${f.inVoice ? 'Em uma chamada' : f.online ? 'Online' : 'Offline'}</span></div>
    <div class="actions"><button class="icon-btn" data-msg="${f.id}" title="Mensagem">${ICON.chat}</button><button class="icon-btn" data-callf="${f.id}" title="Ligar">${ICON.phone}</button><button class="icon-btn" data-rmf="${f.id}" title="Remover amigo">${ICON.x}</button></div></div>`;
  async function addFriend(name) {
    name = (name || '').trim(); if (!name) return;
    try { const { friend } = await S.api.call('add-friend', { name }); rememberUser(friend); S.friends.set(friend.id, S.users.get(friend.id)); toast(`${friend.name} adicionado!`, 'ok'); renderAll(); }
    catch (e) { toast(e.message, 'error', 6000); }
  }
  function openAddFriendModal() {
    openModal(`<header><h2>Adicionar amigo</h2><button class="icon-btn" data-close>${ICON.x}</button></header><div class="modal-body">
      <label class="field"><span>Nome de usuário</span><input id="mAddName" type="text" placeholder="exatamente como aparece no app"></label>
      <div class="actions"><button class="primary" id="mAddBtn">Adicionar</button></div></div>`);
    $('#mAddBtn').onclick = async () => { const n = $('#mAddName').value; closeModal(); await addFriend(n); };
    $('#mAddName').focus();
    $('#mAddName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#mAddBtn').click(); });
  }

  // ---------------- Chat ----------------
  async function loadHistory(channel, before) {
    try {
      const { messages, hasMore } = await S.api.call('history', { channel, before });
      const prev = S.messages.get(channel) || [];
      S.messages.set(channel, before ? [...messages, ...prev] : messages);
      S.hasMore.set(channel, hasMore);
      if (channelOf(S.view) === channel) { renderContent(); if (!before) scrollChatToEnd(); }
    } catch (e) { console.warn(e); }
  }

  function onMessage(channel, message) {
    const list = S.messages.get(channel);
    if (list) list.push(message); else S.messages.set(channel, [message]);
    const current = channelOf(S.view) === channel;
    const mine = message.from === S.me.id;
    if (current) {
      const c = $('#content'); const atEnd = c.scrollHeight - c.scrollTop - c.clientHeight < 80;
      renderContent(); if (atEnd || mine) scrollChatToEnd();
    }
    if (!mine && !message.system && (!current || !document.hasFocus())) {
      if (!current) S.unread.set(channel, (S.unread.get(channel) || 0) + 1);
      notify(userOf(message.from).name + (channel.startsWith('g:') ? ' · ' + channelLabel(channel) : ''), message.text);
      renderRail(); renderSidebar(); updateTitle();
    }
  }

  function renderChat(channel) {
    const list = S.messages.get(channel) || [];
    let html = '';
    if (S.view.kind === 'dm') { const u = userOf(S.view.userId); html += `<div class="chat-intro">${avatarHtml(u, 'lg', false)}<h3>${esc(u.name)}</h3><p>Este é o começo da sua conversa com <strong>${esc(u.name)}</strong>.</p></div>`; }
    else { const g = S.groups.get(S.view.groupId); html += `<div class="chat-intro"><h3>Bem-vindo a ${em(g?.icon)} ${esc(g?.name)}</h3><p>Este é o começo do grupo.${g?.invite ? ` Convide amigos com o código <code>${esc(g.invite)}</code>.` : ''}</p></div>`; }
    const g = S.view.kind === 'group' ? S.groups.get(S.view.groupId) : null;
    const canDelOthers = !!myPerms(g).deleteMessages;
    if (S.hasMore.get(channel)) html += `<button class="ghost small load-more" data-more>Carregar mensagens anteriores</button>`;
    let lastDay = '', lastFrom = null, lastTs = 0;
    html += '<div class="messages">';
    for (const m of list) {
      const day = dayOf(m.ts);
      if (day !== lastDay) { html += `<div class="day-sep">${day}</div>`; lastDay = day; lastFrom = null; }
      if (m.system) { html += `<div class="msg system">${em(m.text)}</div>`; lastFrom = null; continue; }
      const u = userOf(m.from);
      const first = m.from !== lastFrom || m.ts - lastTs > 7 * 60000;
      const del = (m.from === S.me.id || canDelOthers) ? `<button class="msg-del icon-btn" data-del="${m.id}" title="Apagar mensagem">${ICON.trash}</button>` : '';
      html += first
        ? `<div class="msg first">${avatarHtml(u, '', false)}<div class="body"><div class="head" style="--c:${roleColor(g, u.id) || u.color}"><strong data-user="${u.id}">${esc(u.name)}</strong><time>${day === 'Hoje' ? timeOf(m.ts) : new Date(m.ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</time></div><div class="text ${Emoji.onlyEmoji(m.text) ? 'only-emoji' : ''}">${linkify(m.text)}</div></div>${del}</div>`
        : `<div class="msg"><div class="gutter">${timeOf(m.ts)}</div><div class="body"><div class="text ${Emoji.onlyEmoji(m.text) ? 'only-emoji' : ''}">${linkify(m.text)}</div></div>${del}</div>`;
      lastFrom = m.from; lastTs = m.ts;
    }
    html += '</div>';
    $('#content').innerHTML = html;
    const more = $('#content [data-more]'); if (more) more.onclick = () => loadHistory(channel, list[0]?.ts);
    $$('#content [data-del]').forEach((b) => { b.onclick = async () => { if (!confirm('Apagar esta mensagem?')) return; try { await S.api.call('delete-message', { channel, messageId: b.dataset.del }); } catch (e) { toast(e.message, 'error'); } }; });
  }
  function scrollChatToEnd() { const c = $('#content'); c.scrollTop = c.scrollHeight; }

  function renderContent() {
    const ch = channelOf(S.view);
    $('#composer').classList.toggle('hidden', !ch || S.expanded);
    $('#content').classList.toggle('hidden', S.expanded);
    if (!ch) { renderFriendsView(); return; }
    $('#composerInput').placeholder = `Conversar em ${channelLabel(ch)}`;
    renderChat(ch);
  }

  const composer = $('#composerInput');
  composer.addEventListener('input', () => { composer.style.height = 'auto'; composer.style.height = Math.min(180, composer.scrollHeight) + 'px'; });
  composer.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
  $('#composerSend').onclick = sendMessage;
  $('#composerSend').innerHTML = ICON.send;
  $('#composerEmoji').innerHTML = ICON.smile;
  $('#composerEmoji').onclick = (e) => toggleEmojiPicker(e.currentTarget);

  let pickerBuilt = false;
  function buildEmojiPicker() {
    if (pickerBuilt) return; pickerBuilt = true;
    const p = $('#emojiPicker');
    p.innerHTML = `<div class="ep-tabs">${Emoji.CATEGORIES.map((c, i) => `<button type="button" data-cat="${i}" class="${i === 0 ? 'active' : ''}" title="${c.name}">${Emoji.imgHtml(c.icon)}</button>`).join('')}</div>
      <div class="ep-body" id="epBody"></div>`;
    const body = $('#epBody');
    const show = (i) => {
      const c = Emoji.CATEGORIES[i];
      body.innerHTML = `<div class="ep-title">${c.name}</div><div class="ep-grid">${c.list.map((e) => `<button type="button" data-e="${e}" title="${e}">${Emoji.imgHtml(e)}</button>`).join('')}</div>`;
      $$('#emojiPicker .ep-tabs button').forEach((b) => b.classList.toggle('active', +b.dataset.cat === i));
    };
    $$('#emojiPicker .ep-tabs button').forEach((b) => { b.onclick = () => show(+b.dataset.cat); });
    body.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-e]'); if (!b) return;
      insertAtCursor(composer, b.dataset.e);
    });
    show(0);
  }
  function insertAtCursor(ta, text) {
    const start = ta.selectionStart ?? ta.value.length, end = ta.selectionEnd ?? ta.value.length;
    ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
    ta.selectionStart = ta.selectionEnd = start + text.length;
    ta.focus(); ta.dispatchEvent(new Event('input'));
  }
  function toggleEmojiPicker(anchor) {
    const p = $('#emojiPicker');
    if (!p.classList.contains('hidden')) return closeEmojiPicker();
    buildEmojiPicker();
    p.classList.remove('hidden');
    const r = anchor.getBoundingClientRect();
    p.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
    p.style.bottom = (window.innerHeight - r.top + 8) + 'px';
    setTimeout(() => document.addEventListener('mousedown', outsideEmoji), 0);
  }
  function outsideEmoji(e) { if ($('#emojiPicker').contains(e.target) || e.target.closest('#composerEmoji')) return; closeEmojiPicker(); }
  function closeEmojiPicker() { $('#emojiPicker').classList.add('hidden'); document.removeEventListener('mousedown', outsideEmoji); }
  async function sendMessage() {
    const ch = channelOf(S.view); const text = composer.value.trim();
    if (!ch || !text) return;
    composer.value = ''; composer.style.height = 'auto';
    try { await S.api.call('message', { channel: ch, text }); } catch (e) { toast(e.message, 'error'); composer.value = text; }
  }

  function notify(title, body) {
    if (!settings.notifications || document.hasFocus() || typeof Notification === 'undefined') return;
    try {
      if (Notification.permission === 'granted') new Notification(title, { body: String(body).slice(0, 120), silent: true });
      else if (Notification.permission === 'default') Notification.requestPermission();
    } catch {}
  }

  // ---------------- Grupos ----------------
  const EMOJIS = ['🎮', '🎧', '🔥', '⚽', '🎬', '📚', '💼', '🍕', '🚀', '🎵', '🏠', '🐱', '👾', '🧩', '🌙', '🎯'];
  const emojiPicker = (id, cur) => `<div class="emoji-pick" id="${id}">${EMOJIS.map((e) => `<button type="button" data-e="${e}" class="${e === cur ? 'sel' : ''}">${Emoji.imgHtml(e)}</button>`).join('')}</div>`;
  const bindEmojiPicker = (id, onPick) => $$(`#${id} button`).forEach((b) => { b.onclick = () => { onPick(b.dataset.e); $$(`#${id} button`).forEach((x) => x.classList.toggle('sel', x === b)); }; });

  function openGroupModal() {
    let icon = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
    openModal(`<header><h2>Grupos</h2><button class="icon-btn" data-close>${ICON.x}</button></header><div class="modal-body">
      <h3 style="margin:0;font-size:.95rem">Criar um grupo</h3>
      <label class="field"><span>Nome</span><input id="mGName" type="text" maxlength="40" placeholder="ex.: Turma da sexta"></label>
      <div class="field"><span>Ícone</span>${emojiPicker('mGEmojis', icon)}</div>
      <div class="actions"><button class="primary" id="mGCreate">Criar grupo</button></div>
      <hr style="border:none;border-top:1px solid var(--border);margin:6px 0">
      <h3 style="margin:0;font-size:.95rem">Entrar com um convite</h3>
      <div class="row"><input id="mGCode" type="text" placeholder="CÓDIGO" style="text-transform:uppercase;flex:1"><button class="ghost" id="mGJoin">Entrar</button></div></div>`);
    bindEmojiPicker('mGEmojis', (e) => { icon = e; });
    $('#mGCreate').onclick = async () => {
      try { const { group } = await S.api.call('create-group', { name: $('#mGName').value, icon }); setGroup(group); closeModal(); openView({ kind: 'group', groupId: group.id }); toast(`Grupo criado! Código de convite: ${group.invite}`, 'ok', 7000); }
      catch (e) { toast(e.message, 'error'); }
    };
    $('#mGJoin').onclick = async () => {
      try { const { group } = await S.api.call('join-group', { code: $('#mGCode').value }); setGroup(group); closeModal(); openView({ kind: 'group', groupId: group.id }); }
      catch (e) { toast(e.message, 'error'); }
    };
    $('#mGName').focus();
  }

  function openGroupMenu(g, anchor) {
    closeMenu();
    const r = anchor.getBoundingClientRect();
    const m = document.createElement('div');
    m.className = 'menu'; m.id = 'ctxMenu';
    m.style.left = r.left + 'px'; m.style.top = r.bottom + 6 + 'px';
    const P = myPerms(g);
    m.innerHTML = `${P.invite ? `<button data-inv>${ICON.link} Convidar pessoas</button>` : ''}${P.manageRoles ? `<button data-roles>${ICON.crown} Cargos e permissões</button>` : ''}${P.manageGroup ? `<button data-ren>${ICON.edit} Renomear / ícone</button><button data-regen>${ICON.link} Gerar novo código de convite</button>` : ''}<button data-leave class="danger">${ICON.logout} Sair do grupo</button>`;
    document.body.appendChild(m);
    const rolesBtn = m.querySelector('[data-roles]'); if (rolesBtn) rolesBtn.onclick = () => { closeMenu(); openRolesModal(g.id); };
    const regen = m.querySelector('[data-regen]'); if (regen) regen.onclick = async () => { closeMenu(); if (!confirm('O código antigo deixa de funcionar. Gerar um novo?')) return; try { const { group } = await S.api.call('regen-invite', { groupId: g.id }); setGroup(group); renderAll(); toast('Novo código: ' + group.invite, 'ok', 6000); } catch (e) { toast(e.message, 'error'); } };
    const inv = m.querySelector('[data-inv]'); if (inv) inv.onclick = () => {
      closeMenu();
      openModal(`<header><h2>Convidar para ${esc(g.name)}</h2><button class="icon-btn" data-close>${ICON.x}</button></header><div class="modal-body"><p class="hint">Peça para a pessoa clicar em <b>+</b> no app e digitar este código:</p><div class="invite-code"><span>${esc(g.invite)}</span><button class="primary small" data-copy>Copiar</button></div></div>`);
      $('#modal [data-copy]').onclick = () => navigator.clipboard.writeText(g.invite).then(() => toast('Código copiado!', 'ok'));
    };
    const ren = m.querySelector('[data-ren]'); if (ren) ren.onclick = () => {
      closeMenu(); let icon = g.icon;
      openModal(`<header><h2>Editar grupo</h2><button class="icon-btn" data-close>${ICON.x}</button></header><div class="modal-body"><label class="field"><span>Nome</span><input id="mRName" type="text" value="${esc(g.name)}" maxlength="40"></label>
        <div class="field"><span>Ícone</span>${emojiPicker('mREmojis', icon)}</div><div class="actions"><button class="primary" id="mRSave">Salvar</button></div></div>`);
      bindEmojiPicker('mREmojis', (e) => { icon = e; });
      $('#mRSave').onclick = async () => { try { const { group } = await S.api.call('rename-group', { groupId: g.id, name: $('#mRName').value, icon }); setGroup(group); closeModal(); renderAll(); } catch (e) { toast(e.message, 'error'); } };
    };
    m.querySelector('[data-leave]').onclick = async () => {
      closeMenu();
      if (!confirm(`Sair do grupo "${g.name}"?`)) return;
      try { if (S.voice?.channel === 'g:' + g.id) await hangUp(); await S.api.call('leave-group', { groupId: g.id }); S.groups.delete(g.id); S.messages.delete('g:' + g.id); openView({ kind: 'friends' }); }
      catch (e) { toast(e.message, 'error'); }
    };
    setTimeout(() => document.addEventListener('click', closeMenu, { once: true }), 0);
  }
  function closeMenu() { $('#ctxMenu')?.remove(); }

  function renderMembers() {
    const el = $('#members');
    if (S.view.kind !== 'group') { el.classList.add('hidden'); return; }
    const g = S.groups.get(S.view.groupId); if (!g) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const members = g.members.map((m) => ({ ...m, ...(S.users.get(m.id) || {}), ...(m.id === S.me.id ? { ...S.me, online: true, inVoice: S.voice?.channel || null } : {}) }));
    const row = (m) => { const top = rolesOf(g, m.id)[0]; return `<div class="member ${m.online ? '' : 'off'}" data-user="${m.id}">${avatarHtml(m)}<span class="name" style="${top ? `color:${top.color}` : ''}">${esc(m.name)}${m.id === S.me.id ? ' (você)' : ''}${m.status ? `<small>${em(m.status)}</small>` : ''}</span>${m.id === g.ownerId ? `<span class="crown" title="Dono do grupo">${ICON.crown}</span>` : ''}</div>`; };
    // Seções: um bloco por cargo (do mais alto para o mais baixo) com quem está online, depois "Membros" e "Offline"
    const on = members.filter((m) => m.online), off = members.filter((m) => !m.online);
    const used = new Set(); let html = '';
    for (const r of [...g.roles].sort((a, b) => b.position - a.position)) {
      const list = on.filter((m) => !used.has(m.id) && rolesOf(g, m.id)[0]?.id === r.id);
      if (!list.length) continue;
      list.forEach((m) => used.add(m.id));
      html += `<div class="section-title" style="color:${r.color}">${esc(r.name)} — ${list.length}</div>${list.map(row).join('')}`;
    }
    const rest = on.filter((m) => !used.has(m.id));
    if (rest.length) html += `<div class="section-title">Membros — ${rest.length}</div>${rest.map(row).join('')}`;
    if (off.length) html += `<div class="section-title">Offline — ${off.length}</div>${off.map(row).join('')}`;
    el.innerHTML = html;
  }

  // ---------------- Voz / chamada ----------------
  async function ensureEngine() {
    if (S.engine) return S.engine;
    S.engine = await new AudioEngine().init();
    S.engine.setSfxVolume(settings.sfxVolume); S.engine.setMonitorVolume(settings.monitorVolume);
    $('#sfxVol').value = settings.sfxVolume; $('#sfxVolLabel').textContent = Math.round(settings.sfxVolume * 100) + '%';
    $('#monVol').value = settings.monitorVolume; $('#monVolLabel').textContent = Math.round(settings.monitorVolume * 100) + '%';
    loadSounds().then(renderSoundboard);
    renderEffects();
    return S.engine;
  }
  async function ensureMic() {
    if (S.micStream && S.micStream.active) return S.micStream;
    const base = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    const tries = [settings.micId ? { audio: { ...base, deviceId: { exact: settings.micId } } } : null, { audio: base }].filter(Boolean);
    let err = null;
    for (const c of tries) { try { S.micStream = await navigator.mediaDevices.getUserMedia(c); err = null; break; } catch (e) { err = e; console.warn('mic:', e.name, e.message); } }
    if (S.micStream) S.engine.setMicStream(S.micStream);
    else toast('Microfone indisponível (' + micErrorText(err) + '). Use ⚙️ → Testar microfone.', 'error', 8000);
    return S.micStream;
  }
  function micErrorText(e) {
    const m = {
      NotAllowedError: 'acesso negado pelo Windows ou pelo app',
      NotFoundError: 'nenhum microfone encontrado',
      NotReadableError: 'outro programa está usando o microfone',
      OverconstrainedError: 'o microfone escolhido nas configurações não existe mais',
      AbortError: 'o Windows interrompeu o acesso',
    };
    return e ? (m[e.name] || e.name) : 'motivo desconhecido';
  }

  // Teste: abre o microfone escolhido e mostra o volume em tempo real
  async function testMic(box, deviceId) {
    box.innerHTML = '<p class="hint">Abrindo o microfone…</p>';
    let stream;
    const base = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { ...base, deviceId: { exact: deviceId } } : base }); }
    catch (e) {
      box.innerHTML = `<p class="warn">Falhou: ${esc(micErrorText(e))} <small>(${esc(e.name)})</small></p>`
        + `<p class="hint">Verifique em Configurações do Windows → Privacidade → Microfone se "Permitir que aplicativos da área de trabalho acessem seu microfone" está ligado, e feche programas que possam estar usando o microfone.</p>`;
      return;
    }
    const label = stream.getAudioTracks()[0]?.label || 'microfone';
    box.innerHTML = `<p class="hint">Conectado em <b>${esc(label)}</b> — fale para ver a barra mexer:</p><div class="mic-meter"><i></i></div>`;
    const bar = box.querySelector('.mic-meter i');
    const ctx = new AudioContext();
    const an = ctx.createAnalyser(); an.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(an);
    const data = new Uint8Array(an.frequencyBinCount);
    const tick = () => {
      if (!box.isConnected) { stream.getTracks().forEach((t) => t.stop()); ctx.close(); return; }
      an.getByteTimeDomainData(data);
      let peak = 0; for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
      bar.style.width = Math.min(100, (peak / 64) * 100) + '%';
      requestAnimationFrame(tick);
    };
    tick();
  }

  async function ensureCamera() {
    if (S.camStream?.getVideoTracks()[0]?.readyState === 'live') return S.camStream.getVideoTracks()[0];
    const video = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
    const tries = [settings.camId ? { video: { ...video, deviceId: { exact: settings.camId } } } : null, { video }].filter(Boolean);
    for (const c of tries) { try { S.camStream = await navigator.mediaDevices.getUserMedia(c); return S.camStream.getVideoTracks()[0]; } catch (e) { console.warn('cam:', e.name); } }
    toast('Nenhuma câmera disponível.', 'error');
    return null;
  }

  async function joinVoice(channel, withVideo = false) {
    if (S.voice?.channel === channel) { openView(viewOfChannel(channel)); return; }
    removeRing(channel);
    try {
      if (S.voice) await hangUp(true);
      await ensureEngine();
      await ensureMic();
      const v = new VoiceSession({ api: S.api, engine: S.engine, me: S.me, channel, rtcConfig });
      S.voice = v;
      v.addEventListener('update', renderVoiceUI);
      v.addEventListener('error', (e) => toast(e.detail, 'error', 6000));
      if (S.preMuted) v.setMuted(true);
      await v.join();
      if (withVideo) { const t = await ensureCamera(); if (t) await v.setCamera(t); }
      if (channelOf(S.view) !== channel) openView(viewOfChannel(channel)); else renderAll();
    } catch (e) {
      toast(e.message, 'error', 6000);
      if (S.voice) { S.voice.leave().catch(() => {}); S.voice = null; }
      renderAll();
    }
  }
  async function hangUp() {
    const v = S.voice; if (!v) return;
    S.voice = null;
    await v.leave();
    S.camStream?.getTracks().forEach((t) => t.stop()); S.camStream = null;
    S.expanded = false;
    closePopover();
    renderAll();
  }
  function renderVoiceUI() { renderCallArea(); renderVoicePanel(); renderUserPanel(); }

  let callTimer = null;
  function renderCallArea() {
    const area = $('#callArea');
    const ch = channelOf(S.view);
    clearInterval(callTimer);
    if (!ch) { area.classList.add('hidden'); area.innerHTML = ''; return; }
    const v = S.voice;
    if (!v || v.channel !== ch) {
      const users = S.voiceStates.get(ch) || [];
      if (!users.length) { area.classList.add('hidden'); area.classList.remove('expanded'); area.innerHTML = ''; return; }
      area.classList.remove('hidden', 'expanded');
      area.innerHTML = `<div class="call-invite"><div class="avatars">${users.map((u) => avatarHtml(u, 'sm', false)).join('')}</div><span>${users.map((u) => esc(u.name)).join(', ')} ${users.length > 1 ? 'estão' : 'está'} em chamada</span><button class="primary small" data-join>${ICON.phone} Entrar</button></div>`;
      area.querySelector('[data-join]').onclick = () => joinVoice(ch);
      return;
    }
    area.classList.remove('hidden');
    area.classList.toggle('expanded', S.expanded);
    const tiles = v.getTiles();
    area.style.setProperty('--cols', tiles.length <= 1 ? 1 : tiles.length <= 4 ? 2 : tiles.length <= 9 ? 3 : 4);
    if (!area.querySelector('.tiles')) area.innerHTML = `<div class="tiles"></div><div class="call-controls"></div>`;
    const tilesEl = area.querySelector('.tiles');
    // Reaproveita os elementos <video> (mantêm o srcObject): só cria/remove os tiles necessários
    const seen = new Set();
    for (const t of tiles) {
      seen.add(t.id);
      let el = tilesEl.querySelector(`.tile[data-id="${t.id}"]`);
      if (!el) {
        el = document.createElement('div'); el.className = 'tile'; el.dataset.id = t.id;
        el.appendChild(t.video);
        el.insertAdjacentHTML('beforeend', `${avatarHtml({ id: t.id, name: t.name, color: t.color, avatar: t.avatar }, '', false)}<div class="label"><span class="nm"></span><span class="bd"></span></div><span class="conn"></span><button class="tile-full icon-btn" title="Tela cheia (duplo clique)">${ICON.expand}</button>`);
        el.querySelector('.tile-full').onclick = (e) => { e.stopPropagation(); toggleTileFullscreen(el); };
        el.ondblclick = () => toggleTileFullscreen(el);
        tilesEl.appendChild(el);
      }
      el.classList.toggle('local', t.isLocal); el.classList.toggle('has-video', t.hasVideo); el.classList.toggle('sharing', t.sharing);
      el.querySelector('.nm').textContent = t.isLocal ? 'Você' : t.name;
      el.querySelector('.bd').innerHTML = (t.muted ? ICON.micOff : '') + (t.sharing ? ICON.screen : '');
      el.querySelector('.conn').innerHTML = t.conn === 'connected' || t.isLocal ? '' : t.conn === 'failed' ? ICON.alert : ICON.clock;
    }
    for (const el of [...tilesEl.querySelectorAll('.tile')]) if (!seen.has(el.dataset.id)) el.remove();

    const c = area.querySelector('.call-controls');
    c.innerHTML = `<span class="timer" id="callTimer">${fmtTime(Date.now() - v.startedAt)}</span>
      <button class="icon-btn ${v.muted ? 'off' : ''}" data-mic title="Microfone (M)">${v.muted ? ICON.micOff : ICON.mic}</button>
      <button class="icon-btn ${v.camOff ? '' : 'on'}" data-cam title="Câmera (C)">${v.camOff ? ICON.camOff : ICON.cam}</button>
      <button class="icon-btn ${v.sharing ? 'on' : ''}" data-share title="Compartilhar tela">${ICON.screen}</button>
      <button class="icon-btn" data-sfx title="Sons e efeitos de voz">${ICON.music}</button>
      <button class="icon-btn ${v.recording ? 'off' : ''}" data-rec title="${v.recording ? 'Parar gravação' : 'Gravar chamada'}">${v.recording ? ICON.stop : ICON.record}</button>
      <button class="icon-btn" data-expand title="${S.expanded ? 'Reduzir' : 'Expandir vídeo'}">${S.expanded ? ICON.shrink : ICON.expand}</button>
      <button class="icon-btn danger" data-hang title="Desligar">${ICON.phoneOff}</button>
      ${v.recording ? `<span class="rec-dot">● REC <span id="recTimer"></span></span>` : ''}`;
    c.querySelector('[data-mic]').onclick = toggleMic;
    c.querySelector('[data-cam]').onclick = toggleCam;
    c.querySelector('[data-share]').onclick = toggleShare;
    c.querySelector('[data-sfx]').onclick = (e) => togglePopover(e.currentTarget);
    c.querySelector('[data-rec]').onclick = toggleRecording;
    c.querySelector('[data-expand]').onclick = () => { S.expanded = !S.expanded; renderContent(); renderCallArea(); if (!S.expanded) scrollChatToEnd(); };
    c.querySelector('[data-hang]').onclick = () => hangUp();
    callTimer = setInterval(() => {
      const t = $('#callTimer'); if (t) t.textContent = fmtTime(Date.now() - v.startedAt);
      const r = $('#recTimer'); if (r && v.recording) r.textContent = fmtTime(Date.now() - v.recStartedAt);
    }, 1000);
  }

  // Tela cheia de um participante/transmissão (Fullscreen API nativa; Esc sai)
  function toggleTileFullscreen(el) {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (el.classList.contains('has-video')) el.requestFullscreen().catch((e) => toast('Não foi possível abrir em tela cheia: ' + e.message, 'error'));
    else toast('Essa pessoa não está com câmera nem compartilhando a tela.');
  }
  document.addEventListener('fullscreenchange', () => {
    document.body.classList.toggle('has-fullscreen', !!document.fullscreenElement);
    for (const b of $$('.tile-full')) b.innerHTML = b.closest('.tile') === document.fullscreenElement ? ICON.shrink : ICON.expand;
  });

  function renderVoicePanel() {
    const p = $('#voicePanel'); const v = S.voice;
    if (!v) { p.classList.add('hidden'); return; }
    p.classList.remove('hidden');
    p.innerHTML = `<div class="vp-head"><div class="vp-title" data-go><strong><i class="live-dot"></i> Voz conectada ${v.recording ? '<span class="rec-dot">● REC</span>' : ''}</strong><span>${esc(channelLabel(v.channel))} · ${v.peers.size + 1} na chamada</span></div><button class="icon-btn danger" data-hang title="Desligar">${ICON.phoneOff}</button></div>
      <div class="vp-actions"><button class="icon-btn ${v.camOff ? '' : 'on'}" data-cam title="Câmera">${v.camOff ? ICON.camOff : ICON.cam}</button><button class="icon-btn ${v.sharing ? 'on' : ''}" data-share title="Compartilhar tela">${ICON.screen}</button><button class="icon-btn" data-sfx title="Sons e efeitos">${ICON.music}</button><button class="icon-btn ${v.recording ? 'off' : ''}" data-rec title="${v.recording ? 'Parar gravação' : 'Gravar'}">${v.recording ? ICON.stop : ICON.record}</button></div>`;
    p.querySelector('[data-go]').onclick = () => openView(viewOfChannel(v.channel));
    p.querySelector('[data-hang]').onclick = () => hangUp();
    p.querySelector('[data-cam]').onclick = toggleCam;
    p.querySelector('[data-share]').onclick = toggleShare;
    p.querySelector('[data-sfx]').onclick = (e) => togglePopover(e.currentTarget);
    p.querySelector('[data-rec]').onclick = toggleRecording;
  }

  function renderUserPanel() {
    const u = $('#userPanel'); if (!S.me) return;
    const muted = S.voice ? S.voice.muted : S.preMuted;
    u.innerHTML = `<div class="me" data-editprofile title="Editar perfil">${avatarHtml({ ...S.me, online: true, inVoice: !!S.voice })}<div class="who"><strong>${esc(S.me.name)}</strong><span class="${S.voice ? 'call' : ''}">${S.voice ? 'Em uma chamada' : S.me.status ? em(S.me.status) : S.connected ? 'Online' : 'Reconectando…'}</span></div></div>
      <button class="icon-btn ${muted ? 'off' : ''}" data-mic title="Microfone">${muted ? ICON.micOff : ICON.mic}</button><button class="icon-btn" data-theme title="Alternar tema">${document.documentElement.dataset.theme === 'light' ? ICON.moon : ICON.sun}</button><button class="icon-btn" data-settings title="Configurações">${ICON.settings}</button>`;
    u.querySelector('[data-mic]').onclick = toggleMic;
    u.querySelector('[data-settings]').onclick = openSettings;
    u.querySelector('[data-theme]').onclick = () => setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
    u.querySelector('[data-editprofile]').onclick = openEditProfile;
  }

  // ---------------- Perfil: cartão ----------------
  async function openProfile(userId, anchor) {
    closeProfile();
    let u = userOf(userId);
    if (userId !== S.me.id && !S.users.has(userId)) { try { const r = await S.api.call('get-user', { userId }); rememberUser(r.user); u = r.user; } catch {} }
    if (userId === S.me.id) u = { ...S.me, online: true };
    const g = S.view.kind === 'group' ? S.groups.get(S.view.groupId) : null;
    const isMe = userId === S.me.id;
    const P = myPerms(g);
    const roles = g ? rolesOf(g, userId) : [];
    const canAssign = g && P.manageRoles && g.roles.length;
    const card = document.createElement('div');
    card.className = 'profile-card'; card.id = 'profileCard';
    card.innerHTML = `
      <div class="pc-banner" style="background:${u.banner ? '' : `linear-gradient(135deg, ${u.color}, var(--accent-2))`}">${u.banner ? `<img src="${u.banner}" alt="">` : ''}</div>
      <div class="pc-avatar">${avatarHtml(u, 'lg')}</div>
      <div class="pc-body">
        <div class="pc-name">${esc(u.name)}${g && g.ownerId === userId ? `<span class="crown" title="Dono do grupo">${ICON.crown}</span>` : ''}</div>
        <div class="pc-sub">${u.inVoice ? 'Em uma chamada' : u.online ? 'Online' : 'Offline'}${u.status ? ` · ${em(u.status)}` : ''}</div>
        ${u.bio ? `<div class="pc-section"><h4>Sobre mim</h4><p>${em(u.bio)}</p></div>` : ''}
        ${g ? `<div class="pc-section"><h4>Cargos${canAssign ? ' <button class="ghost small" data-assign>Editar</button>' : ''}</h4><div class="role-chips">${roles.length ? roles.map((r) => `<span class="role-chip" style="--rc:${r.color}"><i></i>${esc(r.name)}</span>`).join('') : '<span class="hint">Sem cargos</span>'}</div>
          <div class="assign hidden" data-assignbox>${[...g.roles].sort((a, b) => b.position - a.position).map((r) => `<label><input type="checkbox" value="${r.id}" ${roles.some((x) => x.id === r.id) ? 'checked' : ''}> <i class="dot" style="background:${r.color}"></i>${esc(r.name)}</label>`).join('')}</div></div>` : ''}
        <div class="pc-actions">
          ${isMe ? `<button class="primary small" data-edit>${ICON.edit} Editar perfil</button>` : `<button class="primary small" data-msg>${ICON.chat} Mensagem</button><button class="ghost small" data-call>${ICON.phone} Ligar</button>${S.friends.has(userId) ? '' : `<button class="ghost small" data-addf>${ICON.userPlus} Adicionar</button>`}`}
          ${g && !isMe && P.kick && g.ownerId !== userId ? `<button class="ghost small danger-text" data-kick>${ICON.logout} Expulsar</button>` : ''}
          ${g && !isMe && g.ownerId === S.me.id ? `<button class="ghost small" data-owner title="Transferir a posse do grupo">${ICON.crown} Tornar dono</button>` : ''}
        </div>
      </div>`;
    document.body.appendChild(card);
    Emoji.apply(card);
    // posição: ao lado do elemento clicado, sem sair da tela
    const r = anchor.getBoundingClientRect(); const W = 320, H = card.offsetHeight || 380;
    let left = r.right + 10; if (left + W > window.innerWidth - 8) left = r.left - W - 10; if (left < 8) left = Math.min(r.left, window.innerWidth - W - 8);
    let top = Math.min(r.top, window.innerHeight - H - 8); if (top < 8) top = 8;
    card.style.left = left + 'px'; card.style.top = top + 'px';
    card.querySelector('[data-edit]')?.addEventListener('click', () => { closeProfile(); openEditProfile(); });
    card.querySelector('[data-msg]')?.addEventListener('click', () => { closeProfile(); openView({ kind: 'dm', userId }); });
    card.querySelector('[data-call]')?.addEventListener('click', () => { closeProfile(); openView({ kind: 'dm', userId }); joinVoice(dmChannel(S.me.id, userId)); });
    card.querySelector('[data-addf]')?.addEventListener('click', () => { closeProfile(); addFriend(u.name); });
    card.querySelector('[data-kick]')?.addEventListener('click', async () => { closeProfile(); if (!confirm(`Expulsar ${u.name} do grupo?`)) return; try { await S.api.call('kick-member', { groupId: g.id, userId }); } catch (e) { toast(e.message, 'error'); } });
    card.querySelector('[data-owner]')?.addEventListener('click', async () => { closeProfile(); if (!confirm(`Tornar ${u.name} o dono do grupo? Você deixa de ser o dono.`)) return; try { await S.api.call('transfer-owner', { groupId: g.id, userId }); } catch (e) { toast(e.message, 'error'); } });
    card.querySelector('[data-assign]')?.addEventListener('click', () => card.querySelector('[data-assignbox]').classList.toggle('hidden'));
    card.querySelectorAll('[data-assignbox] input').forEach((cb) => cb.addEventListener('change', async () => {
      const roleIds = [...card.querySelectorAll('[data-assignbox] input:checked')].map((x) => x.value);
      try { await S.api.call('set-member-roles', { groupId: g.id, userId, roleIds }); } catch (e) { toast(e.message, 'error'); }
    }));
    setTimeout(() => document.addEventListener('mousedown', outsideProfile), 0);
  }
  function outsideProfile(e) { if ($('#profileCard')?.contains(e.target)) return; closeProfile(); }
  function closeProfile() { $('#profileCard')?.remove(); document.removeEventListener('mousedown', outsideProfile); }
  // Clique em qualquer avatar/nome (fora da barra lateral e do toque) abre o cartão
  document.addEventListener('click', (e) => {
    if (e.target.closest('.item, .ring, #profileCard, #userPanel, .tile, .voice-user, .call-invite')) return;
    const t = e.target.closest('[data-user]');
    if (t && t.dataset.user) { e.preventDefault(); openProfile(t.dataset.user, t); }
  });

  // ---------------- Perfil: edição ----------------
  function resizeImage(file, w, h, quality = 0.86) {
    return new Promise((resolve, reject) => {
      const img = new Image(); const url = URL.createObjectURL(file);
      img.onload = () => {
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const ctx = c.getContext('2d');
        const scale = Math.max(w / img.width, h / img.height);
        const dw = img.width * scale, dh = img.height * scale;
        ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Imagem inválida')); };
      img.src = url;
    });
  }
  function openEditProfile() {
    closeProfile();
    const me = S.me; let avatar = me.avatar, banner = me.banner, color = me.color;
    const COLORS = ['#5b8cff', '#a45bff', '#ff5b8c', '#ffa35b', '#3ecf8e', '#5bd7ff', '#f5b942', '#7c5cff', '#e74c3c', '#2ecc71'];
    openModal(`<header><h2>Meu perfil</h2><button class="icon-btn" data-close>${ICON.x}</button></header><div class="modal-body profile-edit">
      <div class="pe-preview">
        <div class="pc-banner" id="peBanner">${banner ? `<img src="${banner}" alt="">` : ''}</div>
        <div class="pc-avatar" id="peAvatar">${avatarHtml({ ...me, avatar }, 'lg', false)}</div>
        <div class="pe-tools">
          <label class="ghost small">${ICON.upload} Foto<input type="file" id="peAvatarFile" accept="image/*" hidden></label>
          <label class="ghost small">${ICON.upload} Banner<input type="file" id="peBannerFile" accept="image/*" hidden></label>
          <button type="button" class="ghost small" id="peRmAvatar">Remover foto</button>
          <button type="button" class="ghost small" id="peRmBanner">Remover banner</button>
        </div>
      </div>
      <label class="field"><span>Nome</span><input id="peName" type="text" maxlength="32" value="${esc(me.name)}"></label>
      <label class="field"><span>Status</span><input id="peStatus" type="text" maxlength="60" placeholder="ex.: jogando, ocupado, ouvindo música…" value="${esc(me.status || '')}"></label>
      <label class="field"><span>Sobre mim</span><textarea id="peBio" rows="3" maxlength="300" placeholder="Fale um pouco sobre você">${esc(me.bio || '')}</textarea></label>
      <div class="field"><span>Cor do perfil</span><div class="color-pick" id="peColors">${COLORS.map((c) => `<button type="button" data-c="${c}" style="background:${c}" class="${c === color ? 'sel' : ''}"></button>`).join('')}<input type="color" id="peColorCustom" value="${color}" title="Outra cor"></div></div>
      <div class="actions"><button class="ghost" data-close>Cancelar</button><button class="primary" id="peSave">Salvar</button></div></div>`);
    const refresh = () => { $('#peBanner').innerHTML = banner ? `<img src="${banner}" alt="">` : ''; $('#peBanner').style.background = banner ? '' : `linear-gradient(135deg, ${color}, var(--accent-2))`; $('#peAvatar').innerHTML = avatarHtml({ ...me, avatar, color }, 'lg', false); };
    refresh();
    $('#peAvatarFile').onchange = async (e) => { const f = e.target.files[0]; if (!f) return; try { avatar = await resizeImage(f, 256, 256); refresh(); } catch { toast('Não foi possível ler a imagem.', 'error'); } };
    $('#peBannerFile').onchange = async (e) => { const f = e.target.files[0]; if (!f) return; try { banner = await resizeImage(f, 960, 340, 0.82); refresh(); } catch { toast('Não foi possível ler a imagem.', 'error'); } };
    $('#peRmAvatar').onclick = () => { avatar = null; refresh(); };
    $('#peRmBanner').onclick = () => { banner = null; refresh(); };
    $$('#peColors button').forEach((b) => { b.onclick = () => { color = b.dataset.c; $$('#peColors button').forEach((x) => x.classList.toggle('sel', x === b)); $('#peColorCustom').value = color; refresh(); }; });
    $('#peColorCustom').oninput = (e) => { color = e.target.value; $$('#peColors button').forEach((x) => x.classList.remove('sel')); refresh(); };
    $('#peSave').onclick = async () => {
      try {
        const name = $('#peName').value.trim();
        if (name && name !== me.name) { const { user } = await S.api.call('set-name', { name }); S.me = user; settings.name = user.name; saveSettings(); }
        const { user } = await S.api.call('update-profile', { bio: $('#peBio').value, status: $('#peStatus').value, avatar: avatar || null, banner: banner || null, color });
        S.me = user; if (S.voice) S.voice.me = user;
        closeModal(); toast('Perfil salvo!', 'ok'); renderAll();
      } catch (e) { toast(e.message, 'error', 6000); }
    };
  }

  // ---------------- Cargos e permissões ----------------
  function openRolesModal(groupId, selectedId = 'everyone') {
    const g = S.groups.get(groupId); if (!g) return;
    const roles = [...g.roles].sort((a, b) => b.position - a.position);
    const sel = selectedId === 'everyone' ? { id: 'everyone', name: '@todos', color: '#99aab5', perms: g.everyone, everyone: true } : roles.find((r) => r.id === selectedId) || { id: 'everyone', name: '@todos', color: '#99aab5', perms: g.everyone, everyone: true };
    const permRows = Object.entries(S.perms).map(([k, label]) => `<label class="perm-row"><span>${esc(label)}</span><input type="checkbox" data-perm="${k}" ${sel.perms?.[k] ? 'checked' : ''}></label>`).join('');
    openModal(`<header><h2>Cargos · ${em(g.icon)} ${esc(g.name)}</h2><button class="icon-btn" data-close>${ICON.x}</button></header>
      <div class="roles-layout">
        <aside class="roles-list">
          <button class="role-item ${sel.everyone ? 'active' : ''}" data-role="everyone"><i class="dot" style="background:#99aab5"></i>@todos <small>base</small></button>
          ${roles.map((r) => `<button class="role-item ${r.id === sel.id ? 'active' : ''}" data-role="${r.id}"><i class="dot" style="background:${r.color}"></i>${esc(r.name)}<small>${Object.values(g.memberRoles).filter((l) => l.includes(r.id)).length}</small></button>`).join('')}
          <button class="ghost small" id="roleNew">${ICON.plus} Novo cargo</button>
        </aside>
        <section class="role-editor">
          ${sel.everyone ? '<p class="hint">Permissões que <b>todos os membros</b> têm por padrão. Cargos só adicionam permissões a esta base. O dono do grupo sempre pode tudo.</p>' : `
          <label class="field"><span>Nome do cargo</span><input id="roleName" type="text" maxlength="32" value="${esc(sel.name)}"></label>
          <div class="field"><span>Cor</span><div class="color-pick" id="roleColors">${['#99aab5', '#f04a5d', '#ffa35b', '#f5b942', '#3ecf8e', '#5bd7ff', '#5b8cff', '#7c5cff', '#a45bff', '#ff5b8c'].map((c) => `<button type="button" data-c="${c}" style="background:${c}" class="${c === sel.color ? 'sel' : ''}"></button>`).join('')}<input type="color" id="roleColorCustom" value="${sel.color}"></div></div>
          <div class="field"><span>Ordem</span><div class="row"><button type="button" class="ghost small" id="roleUp">▲ Subir</button><button type="button" class="ghost small" id="roleDown">▼ Descer</button><small style="align-self:center">Cargos mais altos definem a cor do nome.</small></div></div>`}
          <div class="field"><span>Permissões</span><div class="perm-list">${permRows}</div></div>
          <div class="actions">${sel.everyone ? '' : `<button class="ghost danger-text" id="roleDelete">${ICON.trash} Excluir</button>`}<button class="primary" id="roleSave">Salvar</button></div>
        </section>
      </div>`);
    $('#modalCard').classList.add('wide');
    $$('#modal .role-item').forEach((b) => { b.onclick = () => openRolesModal(groupId, b.dataset.role); });
    $('#roleNew').onclick = async () => { try { const { role } = await S.api.call('create-role', { groupId, name: 'Novo cargo', color: '#5b8cff', perms: {} }); const gg = await waitGroup(groupId); openRolesModal(groupId, role.id); } catch (e) { toast(e.message, 'error'); } };
    let color = sel.color;
    $$('#roleColors button').forEach((b) => { b.onclick = () => { color = b.dataset.c; $$('#roleColors button').forEach((x) => x.classList.toggle('sel', x === b)); $('#roleColorCustom').value = color; }; });
    const cc = $('#roleColorCustom'); if (cc) cc.oninput = (e) => { color = e.target.value; $$('#roleColors button').forEach((x) => x.classList.remove('sel')); };
    const readPerms = () => Object.fromEntries($$('#modal [data-perm]').map((cb) => [cb.dataset.perm, cb.checked]));
    $('#roleSave').onclick = async () => {
      try {
        if (sel.everyone) await S.api.call('update-everyone', { groupId, perms: readPerms() });
        else await S.api.call('update-role', { groupId, roleId: sel.id, name: $('#roleName').value, color, perms: readPerms() });
        await waitGroup(groupId); toast('Cargo salvo.', 'ok'); openRolesModal(groupId, sel.id);
      } catch (e) { toast(e.message, 'error'); }
    };
    const move = async (dir) => { const idx = roles.findIndex((r) => r.id === sel.id); const other = roles[idx - dir]; if (!other) return; try { await S.api.call('update-role', { groupId, roleId: sel.id, position: other.position }); await S.api.call('update-role', { groupId, roleId: other.id, position: sel.position }); await waitGroup(groupId); openRolesModal(groupId, sel.id); } catch (e) { toast(e.message, 'error'); } };
    const up = $('#roleUp'); if (up) up.onclick = () => move(1);
    const down = $('#roleDown'); if (down) down.onclick = () => move(-1);
    const del = $('#roleDelete'); if (del) del.onclick = async () => { if (!confirm(`Excluir o cargo "${sel.name}"?`)) return; try { await S.api.call('delete-role', { groupId, roleId: sel.id }); await waitGroup(groupId); openRolesModal(groupId, 'everyone'); } catch (e) { toast(e.message, 'error'); } };
  }
  // O servidor manda group-updated logo após cada alteração; espera chegar para redesenhar com dados novos
  const waitGroup = (groupId) => new Promise((resolve) => { const h = (e) => { if (e.detail.group.id === groupId) { S.api.removeEventListener('group-updated', h); resolve(e.detail.group); } }; S.api.addEventListener('group-updated', h); setTimeout(() => { S.api.removeEventListener('group-updated', h); resolve(S.groups.get(groupId)); }, 1500); });

  function toggleMic() { if (S.voice) S.voice.setMuted(!S.voice.muted); else S.preMuted = !S.preMuted; renderUserPanel(); }
  async function toggleCam() {
    const v = S.voice; if (!v) return;
    if (v.camOff) { const t = await ensureCamera(); if (t) await v.setCamera(t); }
    else { await v.setCamera(null); S.camStream?.getTracks().forEach((t) => t.stop()); S.camStream = null; }
  }
  async function toggleShare() {
    const v = S.voice; if (!v) return;
    try { if (v.sharing) await v.stopShare(); else await v.startShare(); }
    catch (e) { if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') toast('Não foi possível compartilhar: ' + e.message, 'error'); }
  }
  async function toggleRecording() {
    const v = S.voice; if (!v) return;
    if (!v.recording) { try { v.startRecording(); toast('Gravação iniciada.', 'ok'); } catch (e) { toast('Não foi possível gravar: ' + e.message, 'error'); } return; }
    const blob = await v.stopRecording();
    if (!blob?.size) return toast('Gravação vazia.', 'error');
    const name = `chamada-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.webm`;
    if (isElectron) { const path = await api.saveFile(new Uint8Array(await blob.arrayBuffer()), name, [{ name: 'Vídeo WebM', extensions: ['webm'] }]); if (path) toast('Gravação salva em ' + path, 'ok', 6000); }
    else { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10000); }
  }

  // ---------------- Toque de chamada ----------------
  function onRing(msg) {
    if (S.voice?.channel === msg.channel) return;
    rememberUser(msg.from);
    removeRing(msg.channel);
    const el = document.createElement('div');
    el.className = 'ring'; el.dataset.channel = msg.channel;
    el.innerHTML = `${avatarHtml(msg.from, '', false)}<div class="who"><strong>${esc(msg.from.name)}</strong><span>${msg.channel.startsWith('g:') ? 'começou uma chamada em ' + esc(channelLabel(msg.channel)) : 'está te ligando…'}</span></div>
      <button class="icon-btn decline" title="Recusar">${ICON.phoneOff}</button><button class="icon-btn accept" title="Atender">${ICON.phone}</button>`;
    el.querySelector('.accept').onclick = () => { removeRing(msg.channel); joinVoice(msg.channel); };
    el.querySelector('.decline').onclick = () => { removeRing(msg.channel); S.api.send('decline-call', { channel: msg.channel }); };
    Emoji.apply(el); $('#rings').appendChild(el);
    S.rings.set(msg.channel, el);
    startRingtone();
    notify(msg.from.name, msg.channel.startsWith('g:') ? 'começou uma chamada em ' + channelLabel(msg.channel) : 'está te ligando');
    setTimeout(() => removeRing(msg.channel), 45000);
  }
  function removeRing(channel) { S.rings.get(channel)?.remove(); S.rings.delete(channel); if (!S.rings.size) stopRingtone(); }
  function startRingtone() {
    if (S.ringAudio) return;
    try {
      const ctx = new AudioContext(); const g = ctx.createGain(); g.gain.value = 0.15; g.connect(ctx.destination);
      const beep = () => {
        for (const f of [880, 1108]) {
          const o = ctx.createOscillator(); o.frequency.value = f;
          const e = ctx.createGain(); e.gain.setValueAtTime(0.0001, ctx.currentTime); e.gain.linearRampToValueAtTime(1, ctx.currentTime + 0.02); e.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5);
          o.connect(e); e.connect(g); o.start(); o.stop(ctx.currentTime + 0.55);
        }
      };
      beep(); const t = setInterval(beep, 1800);
      S.ringAudio = { ctx, t };
    } catch {}
  }
  function stopRingtone() { if (!S.ringAudio) return; clearInterval(S.ringAudio.t); S.ringAudio.ctx.close().catch(() => {}); S.ringAudio = null; }

  // ---------------- Soundboard / efeitos (popover) ----------------
  function togglePopover(anchor) {
    const p = $('#popover');
    if (!p.classList.contains('hidden')) return closePopover();
    if (!S.engine) return;
    const r = anchor.getBoundingClientRect();
    p.classList.remove('hidden');
    const w = 360, h = Math.min(p.offsetHeight || 520, window.innerHeight * 0.7);
    const left = Math.min(Math.max(8, r.left - w / 2 + r.width / 2), window.innerWidth - w - 8);
    let top = r.top - h - 10; if (top < 8) top = Math.min(r.bottom + 10, window.innerHeight - h - 8);
    p.style.left = left + 'px'; p.style.top = top + 'px'; p.style.bottom = 'auto';
    setTimeout(() => document.addEventListener('mousedown', outsidePopover), 0);
  }
  function outsidePopover(e) { const p = $('#popover'); if (p.contains(e.target)) return; closePopover(); }
  function closePopover() { $('#popover').classList.add('hidden'); document.removeEventListener('mousedown', outsidePopover); }
  $$('#popover .tab').forEach((t) => { t.onclick = () => { $$('#popover .tab').forEach((x) => x.classList.toggle('active', x === t)); $$('#popover .tab-content').forEach((c) => c.classList.toggle('hidden', c.id !== 'tab-' + t.dataset.tab)); }; });

  async function loadSounds() {
    const list = await DefaultSounds.render(S.engine.ctx.sampleRate);
    try { for (const rec of await SoundStore.all()) { try { list.push({ id: rec.id, name: rec.name, emoji: rec.emoji || '🎵', buffer: await S.engine.decode(rec.data.slice(0)), builtin: false }); } catch {} } } catch {}
    S.sounds = list;
  }
  function renderSoundboard() {
    const grid = $('#soundGrid'); grid.innerHTML = '';
    S.sounds.forEach((s, i) => {
      const b = document.createElement('button'); b.className = 'sound-btn'; b.dataset.index = i;
      b.innerHTML = `${i < 9 ? `<span class="key">${i + 1}</span>` : ''}<span class="emoji-wrap">${Emoji.imgHtml(s.emoji)}</span><span class="name" title="${esc(s.name)}">${esc(s.name)}</span>${s.builtin ? '' : '<span class="del" title="Remover">✕</span>'}`;
      b.onclick = (e) => { if (e.target.classList.contains('del')) return removeSound(s); playSoundIndex(i); };
      grid.appendChild(b);
    });
  }
  function playSoundIndex(i) { const s = S.sounds[i]; if (!s || !S.engine) return; const btn = $(`.sound-btn[data-index="${i}"]`); btn?.classList.add('playing'); S.engine.playSound(s.buffer, () => btn?.classList.remove('playing')); }
  async function removeSound(s) { await SoundStore.remove(s.id); S.sounds = S.sounds.filter((x) => x !== s); renderSoundboard(); }
  $('#soundUpload').onchange = async (e) => {
    for (const file of e.target.files) {
      try {
        const data = await file.arrayBuffer(); const buffer = await S.engine.decode(data.slice(0));
        if (buffer.duration > 30) { toast(`"${file.name}" tem mais de 30s; use sons curtos.`, 'error'); continue; }
        const name = file.name.replace(/\.[^.]+$/, '').slice(0, 24);
        const id = await SoundStore.add({ name, emoji: '🎵', data, addedAt: Date.now() });
        S.sounds.push({ id, name, emoji: '🎵', buffer, builtin: false }); toast(`Som "${name}" adicionado.`, 'ok');
      } catch { toast(`Não foi possível ler "${file.name}".`, 'error'); }
    }
    e.target.value = ''; renderSoundboard();
  };
  $('#stopSounds').onclick = () => S.engine?.stopAllSounds();
  $('#sfxVol').oninput = (e) => { settings.sfxVolume = +e.target.value; $('#sfxVolLabel').textContent = Math.round(settings.sfxVolume * 100) + '%'; S.engine?.setSfxVolume(settings.sfxVolume); saveSettings(); };
  $('#monVol').oninput = (e) => { settings.monitorVolume = +e.target.value; $('#monVolLabel').textContent = Math.round(settings.monitorVolume * 100) + '%'; S.engine?.setMonitorVolume(settings.monitorVolume); saveSettings(); };
  function renderEffects() {
    const list = $('#effectList'); list.innerHTML = '';
    if (!S.engine.workletOk) $('#pitchWarning').classList.remove('hidden');
    for (const fx of AudioEngine.EFFECTS) {
      const b = document.createElement('button'); b.className = 'effect-btn' + (S.engine.currentEffect === fx.id ? ' active' : '');
      b.disabled = fx.pitch && !S.engine.workletOk;
      b.innerHTML = `<span class="emoji-wrap">${Emoji.imgHtml(fx.emoji)}</span><strong>${fx.name}</strong><small>${fx.desc}</small>`;
      b.onclick = () => { if (S.engine.setEffect(fx.id)) renderEffects(); };
      list.appendChild(b);
    }
  }

  // ---------------- Configurações ----------------
  async function openSettings() {
    openModal(`<header><h2>Configurações</h2><button class="icon-btn" data-close>${ICON.x}</button></header><div class="modal-body">
      <label class="field"><span>Seu nome</span><input id="sName" type="text" maxlength="32" value="${esc(S.me.name)}"></label>
      <div class="field"><span>Tema</span><div class="theme-pick">
        <button type="button" data-t="dark" class="${(settings.theme || 'dark') === 'dark' ? 'sel' : ''}"><span class="sw dark"></span>Escuro</button>
        <button type="button" data-t="light" class="${settings.theme === 'light' ? 'sel' : ''}"><span class="sw light"></span>Claro</button>
        <button type="button" data-t="system" class="${settings.theme === 'system' ? 'sel' : ''}"><span class="sw sys"></span>Sistema</button></div></div>
      <label class="field"><span>Microfone</span><select id="sMic"></select></label>
      <div class="field"><button type="button" class="ghost" id="sTestMic">${ICON.mic} Testar microfone</button><div id="sMicTest"></div></div>
      <label class="field"><span>Câmera</span><select id="sCam"></select></label>
      <label class="field"><span>Servidor</span><input id="sServer" type="text" value="${esc(settings.server)}"><small>Trocar o servidor reconecta o app.</small></label>
      <label class="field"><span>Servidor TURN (atravessar roteadores)</span><input id="sTurn" type="text" value="${esc(settings.turnUrl)}"></label>
      <div class="row"><label class="field"><span>Usuário TURN</span><input id="sTurnU" type="text" value="${esc(settings.turnUser)}"></label><label class="field"><span>Senha TURN</span><input id="sTurnP" type="password" value="${esc(settings.turnPass)}"></label></div>
      <label class="field"><span>Código de acesso da conta</span><div class="invite-code" style="font-size:.8rem;letter-spacing:0"><span>${esc(settings.token)}</span><button class="ghost small" data-copytoken>Copiar</button></div><small>Use este código em outro computador (tela inicial → "já tenho uma conta") para entrar com a mesma conta. Não compartilhe com ninguém.</small></label>
      <label style="display:flex;gap:8px;align-items:center;font-size:.9rem"><input id="sNotif" type="checkbox" ${settings.notifications ? 'checked' : ''}> Notificações de mensagens e chamadas</label>
      <div class="actions"><button class="ghost" data-close>Cancelar</button><button class="primary" id="sSave">Salvar</button></div></div>`);
    $('#modal [data-copytoken]').onclick = () => navigator.clipboard.writeText(settings.token).then(() => toast('Código copiado!', 'ok'));
    $$('#modal .theme-pick button').forEach((b) => { b.onclick = () => { setTheme(b.dataset.t); $$('#modal .theme-pick button').forEach((x) => x.classList.toggle('sel', x === b)); }; });
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const fill = (sel, kind, cur) => { const list = devices.filter((d) => d.kind === kind); sel.innerHTML = `<option value="">Padrão do sistema</option>` + list.map((d, i) => `<option value="${esc(d.deviceId)}" ${d.deviceId === cur ? 'selected' : ''}>${esc(d.label || (kind === 'audioinput' ? 'Microfone ' : 'Câmera ') + (i + 1))}</option>`).join(''); };
      fill($('#sMic'), 'audioinput', settings.micId); fill($('#sCam'), 'videoinput', settings.camId);
    } catch {}
    $('#sTestMic').onclick = () => testMic($('#sMicTest'), $('#sMic').value);
    $('#sSave').onclick = async () => {
      const name = $('#sName').value.trim(), server = $('#sServer').value.trim();
      const micId = $('#sMic').value, camId = $('#sCam').value;
      const devChanged = micId !== settings.micId || camId !== settings.camId;
      Object.assign(settings, { micId, camId, turnUrl: $('#sTurn').value.trim(), turnUser: $('#sTurnU').value.trim(), turnPass: $('#sTurnP').value, notifications: $('#sNotif').checked });
      saveSettings();
      try {
        if (name && name !== S.me.name) { const { user } = await S.api.call('set-name', { name }); S.me = user; settings.name = user.name; saveSettings(); }
        if (devChanged && S.voice) {
          S.micStream?.getTracks().forEach((t) => t.stop()); S.micStream = null; await ensureMic();
          if (!S.voice.camOff) { S.camStream?.getTracks().forEach((t) => t.stop()); S.camStream = null; await S.voice.setCamera(await ensureCamera()); }
        }
        closeModal(); toast('Configurações salvas.', 'ok'); renderAll();
        if (server && server !== settings.server && /^wss?:\/\//.test(server)) { settings.server = server; saveSettings(); if (S.voice) await hangUp(); connect(); }
      } catch (e) { toast(e.message, 'error', 6000); }
    };
  }

  // ---------------- Modal genérico ----------------
  function openModal(html) {
    $('#modalCard').innerHTML = html; $('#modal').classList.remove('hidden'); Emoji.apply($('#modalCard'));
    $$('#modal [data-close]').forEach((b) => { b.onclick = closeModal; });
  }
  function closeModal() { $('#modal').classList.add('hidden'); $('#modalCard').innerHTML = ''; $('#modalCard').classList.remove('wide'); }
  $('#modal').addEventListener('mousedown', (e) => { if (e.target === e.currentTarget) closeModal(); });

  // ---------------- Seletor de tela (Electron) + atalhos globais ----------------
  if (isElectron) {
    let sources = [], selected = null, kind = 'screen';
    const modal = $('#pickerModal'), list = $('#pickerList'), confirm = $('#pickerConfirm');
    if (api.platform !== 'win32') $('#pickerAudioWrap').classList.add('hidden');
    const render = () => {
      list.innerHTML = '';
      for (const s of sources.filter((s) => s.kind === kind)) {
        const b = document.createElement('button'); b.className = 'picker-item' + (selected === s.id ? ' selected' : '');
        b.innerHTML = `<img src="${s.thumbnail}" alt=""><span title="${esc(s.name)}">${esc(s.name)}</span>`;
        b.onclick = () => { selected = s.id; confirm.disabled = false; render(); };
        b.ondblclick = () => { selected = s.id; finish(); };
        list.appendChild(b);
      }
    };
    const finish = () => { modal.classList.add('hidden'); api.selectScreenSource(selected ? { id: selected, withAudio: $('#pickerAudio').checked } : null); };
    api.onScreenSources((l) => { sources = l; selected = null; kind = 'screen'; confirm.disabled = true; $$('#pickerModal .tab').forEach((t) => t.classList.toggle('active', t.dataset.kind === 'screen')); render(); modal.classList.remove('hidden'); Emoji.apply(modal.querySelector('.tabs')); });
    $$('#pickerModal .tab').forEach((t) => { t.onclick = () => { kind = t.dataset.kind; $$('#pickerModal .tab').forEach((x) => x.classList.toggle('active', x === t)); render(); }; });
    confirm.onclick = finish;
    $('#pickerCancel').onclick = () => { selected = null; finish(); };
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.classList.contains('hidden')) { selected = null; finish(); } });
    api.onHotkeySound((i) => playSoundIndex(i));
    api.onHotkeyStopSounds(() => S.engine?.stopAllSounds());
    api.onHotkeyMute(() => { if (S.voice) toggleMic(); });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeModal(); closePopover(); closeMenu(); closeEmojiPicker(); closeProfile(); return; }
    const tag = (e.target.tagName || '').toLowerCase();
    if (['input', 'textarea', 'select'].includes(tag) || e.ctrlKey || e.altKey || e.metaKey) return;
    if (!S.voice) return;
    if (/^[1-9]$/.test(e.key)) playSoundIndex(+e.key - 1);
    else if (e.key === '0') S.engine?.stopAllSounds();
    else if (e.key.toLowerCase() === 'm') toggleMic();
    else if (e.key.toLowerCase() === 'c') toggleCam();
  });
  window.addEventListener('focus', () => { const ch = channelOf(S.view); if (ch && S.unread.has(ch)) { S.unread.delete(ch); renderRail(); renderSidebar(); updateTitle(); } });
  window.addEventListener('beforeunload', () => { S.voice?.leave(); });

  // ---------------- Início ----------------
  Emoji.apply($('#welcome')); Emoji.apply($('#popover')); Emoji.apply($('#pickerModal'));
  showWelcome();
  if (settings.token || settings.name) { $('#welcomeStatus').textContent = 'Conectando…'; connect(); }
})();
