// Servidor: contas/perfis, amigos, grupos com cargos e permissões, chat persistente, presença e sinalização WebRTC.
// Os dados ficam em server/data.json. O áudio/vídeo trafega direto entre os participantes.
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const MAX_VOICE = Number(process.env.MAX_VOICE || 8);
const MAX_HISTORY = 2000;
const MAX_AVATAR = 400 * 1024;   // data URL (bytes)
const MAX_BANNER = 900 * 1024;

// Permissões que um cargo pode conceder. "everyone" é o cargo base de todos os membros.
const PERMS = {
  sendMessages: 'Enviar mensagens',
  joinVoice: 'Entrar na chamada de voz',
  invite: 'Ver e compartilhar o código de convite',
  deleteMessages: 'Apagar mensagens de outros',
  kick: 'Expulsar membros',
  manageGroup: 'Editar nome, ícone e convite do grupo',
  manageRoles: 'Criar cargos e atribuir a membros',
};
const DEFAULT_EVERYONE = { sendMessages: true, joinVoice: true, invite: true, deleteMessages: false, kick: false, manageGroup: false, manageRoles: false };

// ---------------- Persistência ----------------
let db = { users: {}, groups: {}, friends: {}, messages: {} };
try {
  if (fs.existsSync(DATA_FILE)) db = { ...db, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) };
} catch (e) { console.error('Não foi possível ler data.json:', e.message); }
// Migração: grupos antigos ganham cargos
for (const g of Object.values(db.groups)) {
  g.roles = g.roles || [];
  g.memberRoles = g.memberRoles || {};
  g.everyone = { ...DEFAULT_EVERYONE, ...(g.everyone || {}) };
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(db), (err) => { if (err) console.error('Erro ao salvar:', err.message); });
  }, 400);
}

const rid = (n = 8) => crypto.randomBytes(n).toString('hex').slice(0, n);
const norm = (s) => String(s || '').trim().toLowerCase();
const isDataImage = (s, max) => typeof s === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,/.test(s) && s.length <= max;

// ---------------- Estado em memória ----------------
const online = new Map();            // userId -> ws
const voiceRooms = new Map();        // channel -> Set<userId>
const userVoice = new Map();         // userId -> channel

const publicUser = (u) => u && ({
  id: u.id, name: u.name, color: u.color, avatar: u.avatar || null, banner: u.banner || null,
  bio: u.bio || '', status: u.status || '', online: online.has(u.id), inVoice: userVoice.get(u.id) || null,
});

function channelMembers(channel) {
  if (channel.startsWith('g:')) { const g = db.groups[channel.slice(2)]; return g ? g.members : []; }
  if (channel.startsWith('dm:')) return channel.slice(3).split(':');
  return [];
}
const canAccess = (userId, channel) => channelMembers(channel).includes(userId);

// ---------------- Cargos / permissões ----------------
function perms(g, userId) {
  if (g.ownerId === userId) return Object.fromEntries(Object.keys(PERMS).map((k) => [k, true]));
  const out = { ...DEFAULT_EVERYONE, ...g.everyone };
  for (const rid_ of g.memberRoles[userId] || []) {
    const r = g.roles.find((x) => x.id === rid_);
    if (r) for (const k of Object.keys(PERMS)) if (r.perms[k]) out[k] = true;
  }
  return out;
}
const can = (g, userId, perm) => !!perms(g, userId)[perm];
function requireGroup(user, groupId, perm) {
  const g = db.groups[groupId];
  if (!g || !g.members.includes(user.id)) throw new Error('Grupo não encontrado.');
  if (perm && !can(g, user.id, perm)) throw new Error('Você não tem permissão para isso (' + PERMS[perm].toLowerCase() + ').');
  return g;
}
function cleanPerms(p) { const out = {}; for (const k of Object.keys(PERMS)) out[k] = !!(p && p[k]); return out; }

function send(ws, msg) { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); }
function sendTo(userId, msg) { send(online.get(userId), msg); }
function sendToChannel(channel, msg, except) { for (const id of channelMembers(channel)) if (id !== except) sendTo(id, msg); }
function relatedUsers(userId) {
  const set = new Set(db.friends[userId] || []);
  for (const g of Object.values(db.groups)) if (g.members.includes(userId)) g.members.forEach((m) => set.add(m));
  set.delete(userId);
  return [...set];
}
function broadcastPresence(userId) {
  const u = db.users[userId]; if (!u) return;
  const msg = { type: 'presence', user: publicUser(u) };
  for (const id of relatedUsers(userId)) sendTo(id, msg);
}
function voiceStateMsg(channel) {
  const users = [...(voiceRooms.get(channel) || [])].map((id) => publicUser(db.users[id])).filter(Boolean);
  return { type: 'voice-state', channel, users };
}

// Visão do grupo para um membro específico (o convite só vai para quem pode ver)
function groupView(g, forUserId) {
  const view = {
    id: g.id, name: g.name, icon: g.icon, ownerId: g.ownerId, createdAt: g.createdAt,
    members: g.members.map((id) => publicUser(db.users[id])).filter(Boolean),
    roles: g.roles, memberRoles: g.memberRoles, everyone: g.everyone,
    invite: can(g, forUserId, 'invite') ? g.invite : null,
    myPerms: perms(g, forUserId),
  };
  return view;
}
function broadcastGroup(g) { for (const id of g.members) sendTo(id, { type: 'group-updated', group: groupView(g, id) }); }
function friendsView(userId) { return (db.friends[userId] || []).map((id) => publicUser(db.users[id])).filter(Boolean); }
function userGroups(userId) { return Object.values(db.groups).filter((g) => g.members.includes(userId)).map((g) => groupView(g, userId)); }

function addMessage(channel, from, text, system = false) {
  const message = { id: rid(12), from, text, ts: Date.now(), system: system || undefined };
  db.messages[channel] = db.messages[channel] || [];
  db.messages[channel].push(message);
  if (db.messages[channel].length > MAX_HISTORY) db.messages[channel].splice(0, db.messages[channel].length - MAX_HISTORY);
  save();
  return message;
}
function systemMessage(channel, text) { sendToChannel(channel, { type: 'message', channel, message: addMessage(channel, null, text, true) }); }

// ---------------- Voz ----------------
function leaveVoice(userId, notify = true) {
  const channel = userVoice.get(userId);
  if (!channel) return;
  const room = voiceRooms.get(channel);
  if (room) {
    room.delete(userId);
    for (const id of room) sendTo(id, { type: 'voice-peer-left', id: userId });
    if (room.size === 0) {
      voiceRooms.delete(channel);
      if (channel.startsWith('dm:')) sendToChannel(channel, { type: 'ring-cancel', channel });
    }
  }
  userVoice.delete(userId);
  if (notify) { sendToChannel(channel, voiceStateMsg(channel)); broadcastPresence(userId); }
}

function removeMember(g, userId) {
  if (userVoice.get(userId) === 'g:' + g.id) leaveVoice(userId);
  g.members = g.members.filter((id) => id !== userId);
  delete g.memberRoles[userId];
  if (g.members.length === 0) { delete db.groups[g.id]; delete db.messages['g:' + g.id]; save(); return; }
  if (g.ownerId === userId) g.ownerId = g.members[0];
  save();
  broadcastGroup(g);
}

// ---------------- Handlers ----------------
const handlers = {
  'set-name'(user, { name }) {
    name = String(name || '').trim().slice(0, 32);
    if (name.length < 2) throw new Error('Nome muito curto.');
    const taken = Object.values(db.users).find((u) => norm(u.name) === norm(name) && u.id !== user.id);
    if (taken) throw new Error('Esse nome já está em uso.');
    user.name = name; save();
    broadcastPresence(user.id);
    return { user: publicUser(user) };
  },

  'update-profile'(user, { bio, status, avatar, banner, color }) {
    if (bio !== undefined) user.bio = String(bio || '').slice(0, 300);
    if (status !== undefined) user.status = String(status || '').slice(0, 60);
    if (color !== undefined && /^#[0-9a-f]{6}$/i.test(color)) user.color = color;
    if (avatar !== undefined) {
      if (avatar === null || avatar === '') user.avatar = null;
      else if (isDataImage(avatar, MAX_AVATAR)) user.avatar = avatar;
      else throw new Error('Foto inválida ou grande demais.');
    }
    if (banner !== undefined) {
      if (banner === null || banner === '') user.banner = null;
      else if (isDataImage(banner, MAX_BANNER)) user.banner = banner;
      else throw new Error('Banner inválido ou grande demais.');
    }
    save();
    broadcastPresence(user.id);
    return { user: publicUser(user) };
  },

  'get-user'(user, { userId }) {
    const u = db.users[userId];
    if (!u) throw new Error('Usuário não encontrado.');
    return { user: publicUser(u) };
  },

  'add-friend'(user, { name }) {
    const other = Object.values(db.users).find((u) => norm(u.name) === norm(name));
    if (!other) throw new Error('Nenhum usuário com esse nome. Peça para a pessoa abrir o app e criar o perfil primeiro.');
    if (other.id === user.id) throw new Error('Você não pode adicionar você mesmo.');
    db.friends[user.id] = db.friends[user.id] || [];
    db.friends[other.id] = db.friends[other.id] || [];
    if (!db.friends[user.id].includes(other.id)) db.friends[user.id].push(other.id);
    if (!db.friends[other.id].includes(user.id)) db.friends[other.id].push(user.id);
    save();
    sendTo(other.id, { type: 'friend-added', friend: publicUser(user) });
    return { friend: publicUser(other) };
  },

  'remove-friend'(user, { userId }) {
    db.friends[user.id] = (db.friends[user.id] || []).filter((id) => id !== userId);
    db.friends[userId] = (db.friends[userId] || []).filter((id) => id !== user.id);
    save();
    sendTo(userId, { type: 'friend-removed', userId: user.id });
    return {};
  },

  'create-group'(user, { name, icon }) {
    name = String(name || '').trim().slice(0, 40);
    if (!name) throw new Error('Dê um nome ao grupo.');
    const g = {
      id: rid(10), name, icon: String(icon || '').slice(0, 8) || name.charAt(0).toUpperCase(), ownerId: user.id,
      members: [user.id], invite: rid(6).toUpperCase(), createdAt: Date.now(),
      roles: [], memberRoles: {}, everyone: { ...DEFAULT_EVERYONE },
    };
    db.groups[g.id] = g; save();
    return { group: groupView(g, user.id) };
  },

  'join-group'(user, { code }) {
    const g = Object.values(db.groups).find((x) => x.invite === String(code || '').trim().toUpperCase());
    if (!g) throw new Error('Código de convite inválido.');
    if (!g.members.includes(user.id)) {
      g.members.push(user.id); save();
      broadcastGroup(g);
      systemMessage('g:' + g.id, `${user.name} entrou no grupo.`);
    }
    return { group: groupView(g, user.id) };
  },

  'leave-group'(user, { groupId }) {
    const g = requireGroup(user, groupId);
    removeMember(g, user.id);
    if (db.groups[g.id]) systemMessage('g:' + g.id, `${user.name} saiu do grupo.`);
    return {};
  },

  'kick-member'(user, { groupId, userId }) {
    const g = requireGroup(user, groupId, 'kick');
    if (userId === g.ownerId) throw new Error('O dono do grupo não pode ser expulso.');
    if (!g.members.includes(userId)) throw new Error('Essa pessoa não está no grupo.');
    const target = db.users[userId];
    removeMember(g, userId);
    sendTo(userId, { type: 'group-removed', groupId: g.id, name: g.name });
    systemMessage('g:' + g.id, `${target?.name || 'Alguém'} foi removido do grupo por ${user.name}.`);
    return {};
  },

  'rename-group'(user, { groupId, name, icon }) {
    const g = requireGroup(user, groupId, 'manageGroup');
    if (name) g.name = String(name).trim().slice(0, 40) || g.name;
    if (icon) g.icon = String(icon).slice(0, 8);
    save(); broadcastGroup(g);
    return { group: groupView(g, user.id) };
  },

  'regen-invite'(user, { groupId }) {
    const g = requireGroup(user, groupId, 'manageGroup');
    g.invite = rid(6).toUpperCase(); save(); broadcastGroup(g);
    return { group: groupView(g, user.id) };
  },

  'transfer-owner'(user, { groupId, userId }) {
    const g = requireGroup(user, groupId);
    if (g.ownerId !== user.id) throw new Error('Só o dono pode transferir o grupo.');
    if (!g.members.includes(userId)) throw new Error('Essa pessoa não está no grupo.');
    g.ownerId = userId; save(); broadcastGroup(g);
    systemMessage('g:' + g.id, `${db.users[userId]?.name} agora é o dono do grupo.`);
    return {};
  },

  // ---- cargos ----
  'create-role'(user, { groupId, name, color, perms: p }) {
    const g = requireGroup(user, groupId, 'manageRoles');
    name = String(name || '').trim().slice(0, 32);
    if (!name) throw new Error('Dê um nome ao cargo.');
    if (g.roles.length >= 25) throw new Error('Limite de 25 cargos.');
    const role = { id: rid(6), name, color: /^#[0-9a-f]{6}$/i.test(color) ? color : '#99aab5', perms: cleanPerms(p), position: g.roles.length };
    g.roles.push(role); save(); broadcastGroup(g);
    return { role };
  },
  'update-role'(user, { groupId, roleId, name, color, perms: p, position }) {
    const g = requireGroup(user, groupId, 'manageRoles');
    const role = g.roles.find((r) => r.id === roleId);
    if (!role) throw new Error('Cargo não encontrado.');
    if (name !== undefined) role.name = String(name).trim().slice(0, 32) || role.name;
    if (color !== undefined && /^#[0-9a-f]{6}$/i.test(color)) role.color = color;
    if (p !== undefined) role.perms = cleanPerms(p);
    if (position !== undefined) role.position = Number(position) || 0;
    g.roles.sort((a, b) => a.position - b.position);
    save(); broadcastGroup(g);
    return { role };
  },
  'delete-role'(user, { groupId, roleId }) {
    const g = requireGroup(user, groupId, 'manageRoles');
    g.roles = g.roles.filter((r) => r.id !== roleId);
    for (const id of Object.keys(g.memberRoles)) g.memberRoles[id] = g.memberRoles[id].filter((r) => r !== roleId);
    save(); broadcastGroup(g);
    return {};
  },
  'update-everyone'(user, { groupId, perms: p }) {
    const g = requireGroup(user, groupId, 'manageRoles');
    g.everyone = cleanPerms(p); save(); broadcastGroup(g);
    return {};
  },
  'set-member-roles'(user, { groupId, userId, roleIds }) {
    const g = requireGroup(user, groupId, 'manageRoles');
    if (!g.members.includes(userId)) throw new Error('Essa pessoa não está no grupo.');
    const valid = new Set(g.roles.map((r) => r.id));
    g.memberRoles[userId] = [...new Set((roleIds || []).filter((r) => valid.has(r)))];
    save(); broadcastGroup(g);
    return {};
  },

  // ---- chat ----
  'history'(user, { channel, before }) {
    if (!canAccess(user.id, channel)) throw new Error('Sem acesso a esse canal.');
    let list = db.messages[channel] || [];
    if (before) list = list.filter((m) => m.ts < before);
    return { channel, messages: list.slice(-60), hasMore: list.length > 60 };
  },
  'message'(user, { channel, text }) {
    if (!canAccess(user.id, channel)) throw new Error('Sem acesso a esse canal.');
    if (channel.startsWith('g:') && !can(db.groups[channel.slice(2)], user.id, 'sendMessages')) throw new Error('Você não tem permissão para enviar mensagens neste grupo.');
    text = String(text || '').slice(0, 4000);
    if (!text.trim()) throw new Error('Mensagem vazia.');
    const message = addMessage(channel, user.id, text);
    sendToChannel(channel, { type: 'message', channel, message });
    return { message };
  },
  'delete-message'(user, { channel, messageId }) {
    if (!canAccess(user.id, channel)) throw new Error('Sem acesso a esse canal.');
    const list = db.messages[channel] || [];
    const m = list.find((x) => x.id === messageId);
    if (!m) throw new Error('Mensagem não encontrada.');
    const mine = m.from === user.id;
    if (!mine && !(channel.startsWith('g:') && can(db.groups[channel.slice(2)], user.id, 'deleteMessages'))) throw new Error('Você não pode apagar essa mensagem.');
    db.messages[channel] = list.filter((x) => x.id !== messageId); save();
    sendToChannel(channel, { type: 'message-deleted', channel, messageId });
    return {};
  },

  // ---- voz ----
  'voice-join'(user, { channel }) {
    if (!canAccess(user.id, channel)) throw new Error('Sem acesso a esse canal.');
    if (channel.startsWith('g:') && !can(db.groups[channel.slice(2)], user.id, 'joinVoice')) throw new Error('Você não tem permissão para entrar na voz deste grupo.');
    if (userVoice.get(user.id) === channel) return { peers: [...voiceRooms.get(channel)].filter((id) => id !== user.id).map((id) => publicUser(db.users[id])) };
    leaveVoice(user.id, false);
    if (!voiceRooms.has(channel)) voiceRooms.set(channel, new Set());
    const room = voiceRooms.get(channel);
    if (room.size >= MAX_VOICE) throw new Error(`A chamada está cheia (máx. ${MAX_VOICE}).`);
    const peers = [...room].map((id) => publicUser(db.users[id])).filter(Boolean);
    const wasEmpty = room.size === 0;
    room.add(user.id);
    userVoice.set(user.id, channel);
    for (const id of room) if (id !== user.id) sendTo(id, { type: 'voice-peer-joined', id: user.id, name: user.name, color: user.color, avatar: user.avatar || null });
    sendToChannel(channel, voiceStateMsg(channel));
    broadcastPresence(user.id);
    if (wasEmpty) for (const id of channelMembers(channel)) if (id !== user.id && !userVoice.has(id)) sendTo(id, { type: 'ring', channel, from: publicUser(user) });
    return { peers };
  },
  'voice-leave'(user) { leaveVoice(user.id); return {}; },
  'decline-call'(user, { channel }) {
    for (const id of voiceRooms.get(channel) || []) sendTo(id, { type: 'call-declined', channel, by: publicUser(user) });
    return {};
  },
  'signal'(user, { to, data }) {
    const channel = userVoice.get(user.id);
    if (channel && voiceRooms.get(channel)?.has(to)) sendTo(to, { type: 'signal', from: user.id, data });
    return null;
  },
  'voice-meta'(user, { state }) {
    const channel = userVoice.get(user.id);
    if (channel) for (const id of voiceRooms.get(channel)) if (id !== user.id) sendTo(id, { type: 'voice-meta', from: user.id, state });
    return null;
  },
};

// ---------------- HTTP + WS ----------------
const app = express();
app.use(express.static(path.join(__dirname, '..', 'app', 'renderer')));
app.get('/health', (_req, res) => res.json({ ok: true, usuarios: Object.keys(db.users).length, online: online.size, grupos: Object.keys(db.groups).length }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 4 * 1024 * 1024 });

wss.on('connection', (ws) => {
  let user = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const reply = (ok, data) => { if (msg.reqId) send(ws, { type: 'res', reqId: msg.reqId, ok, ...(ok ? { data } : { error: data }) }); };

    if (msg.type === 'auth') {
      let u = msg.token && Object.values(db.users).find((x) => x.token === msg.token);
      if (!u) {
        const name = String(msg.name || '').trim().slice(0, 32);
        if (name.length < 2) return reply(false, 'Escolha um nome com pelo menos 2 letras.');
        if (Object.values(db.users).find((x) => norm(x.name) === norm(name))) return reply(false, 'Esse nome já está em uso. Escolha outro.');
        const colors = ['#5b8cff', '#a45bff', '#ff5b8c', '#ffa35b', '#3ecf8e', '#5bd7ff', '#f5b942'];
        u = { id: rid(8), name, token: rid(32), color: colors[Math.floor(Math.random() * colors.length)], createdAt: Date.now(), bio: '', status: '', avatar: null, banner: null };
        db.users[u.id] = u; save();
        console.log(`[novo usuário] ${u.name}`);
      }
      const old = online.get(u.id);
      if (old && old !== ws) { send(old, { type: 'kicked', reason: 'Você entrou em outro lugar.' }); old.close(); }
      user = u;
      online.set(u.id, ws);
      const voice = {};
      for (const [ch, set] of voiceRooms) if (canAccess(u.id, ch)) voice[ch] = [...set].map((id) => publicUser(db.users[id])).filter(Boolean);
      reply(true, { user: publicUser(u), token: u.token, groups: userGroups(u.id), friends: friendsView(u.id), voice, perms: PERMS });
      broadcastPresence(u.id);
      console.log(`[online] ${u.name}`);
      return;
    }

    if (!user) return reply(false, 'Não autenticado.');
    const h = handlers[msg.type];
    if (!h) return reply(false, 'Comando desconhecido: ' + msg.type);
    try {
      const out = h(user, msg);
      if (out !== null) reply(true, out);
    } catch (e) { reply(false, e.message); }
  });

  const cleanup = () => {
    if (!user) return;
    if (online.get(user.id) === ws) {
      leaveVoice(user.id);
      online.delete(user.id);
      broadcastPresence(user.id);
      console.log(`[offline] ${user.name}`);
    }
    user = null;
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}  (dados em ${DATA_FILE})`);
});
