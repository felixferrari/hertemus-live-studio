const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const crypto = require('crypto');
const { exec } = require('child_process');

const ROOT = __dirname;
const WEB = path.join(ROOT, 'web');
const LEGACY_DATA = path.join(ROOT, 'data');
const DATA = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'HERTEMUS Alerts')
  : (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'HERTEMUS Alerts') : path.join(ROOT, 'data-user'));
const CONFIG_FILE = path.join(DATA, 'config.json');
const CONFIG_BACKUP_FILE = path.join(DATA, 'config.backup.json');
const HISTORY_FILE = path.join(DATA, 'history.jsonl');
const SESSION_FILE = path.join(DATA, 'session.json');
const LOG_FILE = path.join(DATA, 'hertemus-alerts.log');
const PORT = 3000;
const HOST = '127.0.0.1';
const BASE_URL = `http://${HOST}:${PORT}`;

fs.mkdirSync(DATA, { recursive: true });

function migrateLegacyDataOnce() {
  try {
    const marker = path.join(DATA, '.migrated-from-install');
    if (fs.existsSync(marker)) return;
    const names = ['config.json','session.json','history.jsonl','hertemus-alerts.log'];
    for (const name of names) {
      const src = path.join(LEGACY_DATA, name);
      const dst = path.join(DATA, name);
      if (!fs.existsSync(dst) && fs.existsSync(src)) fs.copyFileSync(src, dst);
    }
    fs.writeFileSync(marker, new Date().toISOString(), 'utf8');
  } catch {}
}
migrateLegacyDataOnce();

// v4.2: uma cópia de segurança da configuração anterior, criada uma única vez.
// Preserva login/tokens e permite retornar à v4.1 sem perder ajustes.
try {
  const snapshot = path.join(DATA, 'config.pre-v4.2.json');
  if (fs.existsSync(CONFIG_FILE) && !fs.existsSync(snapshot)) fs.copyFileSync(CONFIG_FILE, snapshot);
} catch (e) { console.warn('Não foi possível fazer snapshot da configuração anterior:', e.message); }

const defaultConfig = {
  apiKey: '',
  liveUrl: '',
  clientId: '',
  clientSecret: '',
  refreshToken: '',
  accessToken: '',
  accessTokenExpiry: 0,
  durationMs: 6500,
  volume: 0.85,
  alertScale: 0.72,
  alertTemplate: 'original',
  pollSubscribers: true,
  autoDetectLive: true,
  emoteWallEnabled: true,
  emoteMaxOnScreen: 6,
  emotePerMessage: 3,
  emoteMinSize: 42,
  emoteMaxSize: 112,
  emoteDurationMs: 6200,
  emoteMinGapMs: 900,
  sceneTheme: 'frame-00',
  sceneCameraStyle: 'camera-00',
  sceneCameraEnabled: false,
  sceneMotionEnabled: true,
  sceneCameraX: 4,
  sceneCameraY: 5,
  sceneCameraWidth: 24,
  sceneOverlayOpacity: 1,
  sceneCameraOpacity: 1,
  lastUpdated: null
};

function normalizeConfig(x) {
  const c = { ...defaultConfig, ...(x || {}) };
  if (/apps\.googleusercontent\.com/i.test(String(c.liveUrl || ''))) c.liveUrl = '';
  c.alertTemplate = String(c.alertTemplate || 'original').replace(/[^a-z0-9_-]/gi,'').slice(0,60) || 'original';
  return c;
}
function loadConfig() {
  const candidates = [CONFIG_FILE, CONFIG_BACKUP_FILE];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const x = JSON.parse(fs.readFileSync(file, 'utf8'));
      return normalizeConfig(x);
    } catch {}
  }
  return { ...defaultConfig };
}
let config = loadConfig();
function saveConfig() {
  config = normalizeConfig(config);
  config.lastUpdated = new Date().toISOString();
  try {
    if (fs.existsSync(CONFIG_FILE)) fs.copyFileSync(CONFIG_FILE, CONFIG_BACKUP_FILE);
  } catch {}
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

let state = {
  seq: 0,
  emoteSeq: 0,
  events: [],
  emotes: [],
  processedIds: new Map(),
  serverStartedAt: Date.now(),
  oauthState: null,
  live: {
    videoId: null,
    configuredVideoId: null,
    chatId: null,
    title: null,
    pageToken: null,
    primed: false,
    nextPollAt: 0,
    lastLookupAt: 0,
    lastError: null,
    waitingReason: null,
    phase: 'idle',
    source: null,
    reconnects: 0,
    lastSuccessAt: null,
    lastChatMessageAt: null,
    recoveredPaidEvents: 0,
    lastErrorLoggedAt: 0,
    lastErrorLoggedText: ''
  },
  subscribers: {
    primed: false,
    known: new Set(),
    nextPollAt: 0,
    lastError: null
  },
  session: {
    videoId: null,
    title: null,
    startedAt: null,
    updatedAt: null,
    counts: {subscriber:0,member:0,upgrade:0,milestone:0,superchat:0,sticker:0,gift:0,giftreceived:0,jewelgift:0,redirect:0},
    giftMemberships: 0,
    currencies: {},
    topSuperChat: null,
    lastSupporter: null
  },
  lastApiError: null,
  apiPauseUntil: 0,
  quotaExceeded: false,
  quotaMessage: null
};


function appendLog(level, message) {
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}\n`;
  try { fs.appendFileSync(LOG_FILE, line, 'utf8'); } catch {}
  if (level === 'error') console.error(message); else console.log(message);
}

function loadSession() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return;
    const d = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    if (d && typeof d === 'object') state.session = { ...state.session, ...d, counts:{...state.session.counts,...(d.counts||{})}, currencies:{...(d.currencies||{})} };
  } catch {}
}
function saveSession() {
  state.session.updatedAt = new Date().toISOString();
  try { fs.writeFileSync(SESSION_FILE, JSON.stringify(state.session, null, 2), 'utf8'); } catch {}
}
function resetSession(videoId=null, title=null) {
  state.session = {
    videoId: videoId || null,
    title: title || null,
    startedAt: videoId ? new Date().toISOString() : null,
    updatedAt: new Date().toISOString(),
    counts: {subscriber:0,member:0,upgrade:0,milestone:0,superchat:0,sticker:0,gift:0,giftreceived:0,jewelgift:0,redirect:0},
    giftMemberships: 0,
    currencies: {},
    topSuperChat: null,
    lastSupporter: null
  };
  saveSession();
}
function ensureSession(videoId, title) {
  if (!videoId) return;
  if (state.session.videoId !== videoId) resetSession(videoId, title || null);
  else if (title && state.session.title !== title) { state.session.title = title; saveSession(); }
}
function rememberProcessed(id) {
  if (!id) return false;
  const now = Date.now();
  if (state.processedIds.has(id)) return true;
  state.processedIds.set(id, now);
  if (state.processedIds.size > 4000) {
    for (const [k,t] of state.processedIds) if (now - t > 6*60*60*1000) state.processedIds.delete(k);
    while (state.processedIds.size > 4000) state.processedIds.delete(state.processedIds.keys().next().value);
  }
  return false;
}
function recordHistory(ev) {
  try { fs.appendFileSync(HISTORY_FILE, JSON.stringify(ev) + '\n', 'utf8'); } catch {}
}
function updateSession(ev) {
  if (!state.session.videoId) return;
  const c = state.session.counts;
  if (Object.prototype.hasOwnProperty.call(c, ev.type)) c[ev.type]++;
  if (ev.type === 'gift' && Number(ev.count || 0)) state.session.giftMemberships += Number(ev.count || 0);
  if (ev.type === 'superchat' && Number(ev.amountMicros || 0) > 0) {
    const cur = ev.currency || 'UNK';
    state.session.currencies[cur] = Number(state.session.currencies[cur] || 0) + Number(ev.amountMicros || 0);
    if (!state.session.topSuperChat || Number(ev.amountMicros) > Number(state.session.topSuperChat.amountMicros || 0)) {
      state.session.topSuperChat = { name:ev.name, amount:ev.amount, amountMicros:ev.amountMicros, currency:ev.currency, message:ev.message || '' };
    }
    state.session.lastSupporter = {name:ev.name, amount:ev.amount, type:ev.type};
  } else if (['member','upgrade','gift','jewelgift','sticker'].includes(ev.type)) {
    state.session.lastSupporter = {name:ev.name, amount:ev.amount || '', type:ev.type};
  }
  saveSession();
}
function readHistory(limit=100) {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    const lines = fs.readFileSync(HISTORY_FILE,'utf8').trim().split(/\r?\n/).filter(Boolean);
    return lines.slice(-Math.max(1, Math.min(500, Number(limit)||100))).map(x=>{try{return JSON.parse(x)}catch{return null}}).filter(Boolean).reverse();
  } catch { return []; }
}
loadSession();

// Impede que Super Chats recentes sejam exibidos de novo ao reiniciar o programa.
// O histórico original permanece no diretório APPDATA; não é apagado nem migrado.
for (const ev of readHistory(500)) {
  if (ev.sourceId && ev.source === 'youtube-live') {
    state.processedIds.set(ev.sourceId, Date.parse(ev.createdAt) || Date.now());
  }
}

// Clientes do overlay conectados por Server-Sent Events (SSE).
// Mantemos o polling antigo como fallback, mas o SSE entrega o alerta imediatamente
// ao OBS/preview e permite diagnosticar se o overlay está realmente conectado.
const streamClients = new Set();

function pushNamedStreamEvent(eventName, ev) {
  const payload = `id: ${ev.id}\nevent: ${eventName}\ndata: ${JSON.stringify(ev)}\n\n`;
  for (const client of [...streamClients]) {
    try { client.write(payload); }
    catch { streamClients.delete(client); }
  }
}

function pushStreamEvent(ev) { pushNamedStreamEvent('alert', ev); }

function pushEmoteEvent(emote, data={}) {
  if (!config.emoteWallEnabled || !emote) return null;
  const ev = {
    id: ++state.emoteSeq,
    emoji: String(emote),
    name: data.name || '',
    avatar: data.avatar || '',
    createdAt: new Date().toISOString(),
    source: data.source || 'youtube-live'
  };
  state.emotes.push(ev);
  if (state.emotes.length > 300) state.emotes.shift();
  pushNamedStreamEvent('emote', ev);
  return ev;
}

setInterval(() => {
  for (const client of [...streamClients]) {
    try { client.write(`: ping ${Date.now()}\n\n`); }
    catch { streamClients.delete(client); }
  }
}, 15000).unref?.();

function addEvent(type, data = {}) {
  if (data.sourceId && rememberProcessed(data.sourceId)) return null;
  const ev = {
    id: ++state.seq,
    sourceId: data.sourceId || '',
    type,
    name: data.name || 'HERTEMUS',
    avatar: data.avatar || '',
    amount: data.amount || '',
    amountMicros: Number(data.amountMicros || 0),
    currency: data.currency || '',
    count: Number(data.count || 0),
    months: Number(data.months || 0),
    message: data.message || '',
    detail: data.detail || '',
    level: data.level || '',
    createdAt: new Date().toISOString(),
    source: data.source || 'youtube'
  };
  state.events.push(ev);
  if (state.events.length > 200) state.events.shift();
  appendLog('info', `[ALERTA] ${ev.type} | ${ev.name} | ${ev.amount} ${ev.message}`);
  recordHistory(ev);
  if (!['teste','replay'].includes(ev.source)) updateSession(ev);
  pushStreamEvent(ev);
  return ev;
}

function json(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}
function text(res, status, body, type='text/plain; charset=utf-8') {
  const buf = Buffer.from(body);
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': buf.length,
    'Cache-Control': 'no-store'
  });
  res.end(buf);
}
function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.wav': 'audio/wav',
  '.json': 'application/json; charset=utf-8'
};
function serveFile(res, filePath) {
  if (!filePath.startsWith(WEB)) return text(res, 403, 'Forbidden');
  fs.readFile(filePath, (err, data) => {
    if (err) return text(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': mime[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-store, no-cache, must-revalidate'
    });
    res.end(data);
  });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1024*1024) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
function safePublicConfig() {
  return {
    apiKey: config.apiKey,
    liveUrl: config.liveUrl,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    durationMs: config.durationMs,
    volume: config.volume,
    alertScale: config.alertScale,
    alertTemplate: config.alertTemplate,
    pollSubscribers: config.pollSubscribers,
    autoDetectLive: config.autoDetectLive,
    emoteWallEnabled: config.emoteWallEnabled,
    emoteMaxOnScreen: config.emoteMaxOnScreen,
    emotePerMessage: config.emotePerMessage,
    emoteMinSize: config.emoteMinSize,
    emoteMaxSize: config.emoteMaxSize,
    emoteDurationMs: config.emoteDurationMs,
    emoteMinGapMs: config.emoteMinGapMs,
    sceneTheme: config.sceneTheme,
    sceneCameraStyle: config.sceneCameraStyle,
    sceneCameraEnabled: config.sceneCameraEnabled,
    sceneMotionEnabled: config.sceneMotionEnabled,
    sceneCameraX: config.sceneCameraX,
    sceneCameraY: config.sceneCameraY,
    sceneCameraWidth: config.sceneCameraWidth,
    sceneOverlayOpacity: config.sceneOverlayOpacity,
    sceneCameraOpacity: config.sceneCameraOpacity,
    oauthConnected: !!config.refreshToken,
    overlayUrl: `${BASE_URL}/overlay`
  };
}

function overlaySettingsPayload() {
  return {
    durationMs:Number(config.durationMs||6500),
    volume:Number(config.volume||0.85),
    alertScale:Number(config.alertScale||0.72),
    alertTemplate:String(config.alertTemplate||'original'),
    emoteSettings:{
      enabled:!!config.emoteWallEnabled,
      maxOnScreen:Number(config.emoteMaxOnScreen||6),
      minSize:Number(config.emoteMinSize||42),
      maxSize:Number(config.emoteMaxSize||112),
      durationMs:Number(config.emoteDurationMs||6200),
      minGapMs:Number(config.emoteMinGapMs ?? 900)
    }
  };
}

function extractVideoId(input) {
  if (!input) return null;
  input = String(input).trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(input)) return input;
  try {
    const u = new URL(input);
    if (u.hostname.includes('youtu.be')) return u.pathname.split('/').filter(Boolean)[0] || null;
    if (u.searchParams.get('v')) return u.searchParams.get('v');
    const parts = u.pathname.split('/').filter(Boolean);
    const liveIdx = parts.indexOf('live');
    if (liveIdx >= 0 && parts[liveIdx+1]) return parts[liveIdx+1];
    const shortsIdx = parts.indexOf('shorts');
    if (shortsIdx >= 0 && parts[shortsIdx+1]) return parts[shortsIdx+1];
  } catch {}
  return null;
}

async function refreshAccessToken(force=false) {
  if (!config.refreshToken || !config.clientId || !config.clientSecret) return null;
  if (!force && config.accessToken && Date.now() < (config.accessTokenExpiry || 0) - 60000) return config.accessToken;
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: config.refreshToken,
    grant_type: 'refresh_token'
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: {'Content-Type':'application/x-www-form-urlencoded'}, body
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error_description || data.error || `OAuth HTTP ${r.status}`);
  config.accessToken = data.access_token;
  config.accessTokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
  saveConfig();
  return config.accessToken;
}

function isQuotaError(reason, msg) {
  return /quotaExceeded|dailyLimitExceeded|dailyLimit/i.test(String(reason || '')) || /quota/i.test(String(msg || '')) && /exceed|limit/i.test(String(msg || ''));
}
function quotaPauseMessage() {
  return 'Cota diária da API do YouTube esgotada. O HERTEMUS Alerts pausou as consultas para não insistir inutilmente. A cota diária do YouTube é redefinida à meia-noite do horário do Pacífico.';
}

async function youtubeGet(endpoint, params={}, preferOAuth=true) {
  if (state.apiPauseUntil && Date.now() < state.apiPauseUntil) {
    throw new Error(state.quotaMessage || quotaPauseMessage());
  }
  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  for (const [k,v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const headers = {};
  let token = null;
  if (preferOAuth && config.refreshToken) {
    try { token = await refreshAccessToken(); } catch (e) { state.lastApiError = e.message; }
  }
  if (token) headers.Authorization = `Bearer ${token}`;
  else if (config.apiKey) url.searchParams.set('key', config.apiKey);
  else throw new Error('Configure uma API Key ou conecte o YouTube por OAuth.');

  const r = await fetch(url, { headers });
  const data = await r.json();
  if (!r.ok) {
    const reason = data?.error?.errors?.[0]?.reason || '';
    const msg = data?.error?.message || `YouTube HTTP ${r.status}`;
    if (isQuotaError(reason, msg)) {
      state.quotaExceeded = true;
      state.quotaMessage = quotaPauseMessage();
      state.apiPauseUntil = Date.now() + 60 * 60 * 1000;
      state.lastApiError = state.quotaMessage;
      throw new Error(state.quotaMessage);
    }
    const err = new Error(reason ? `${msg} (${reason})` : msg);
    err.httpStatus = r.status;
    err.youtubeReason = reason;
    err.youtubeEndpoint = endpoint;
    throw err;
  }
  state.quotaExceeded = false;
  state.quotaMessage = null;
  state.apiPauseUntil = 0;
  return data;
}

function clearLiveRuntime(keepIdentity=false) {
  state.live.chatId = null;
  state.live.pageToken = null;
  state.live.primed = false;
  state.live.nextPollAt = 0;
  state.live.reconnects = 0;
  if (!keepIdentity) {
    state.live.videoId = null;
    state.live.title = null;
    state.live.source = null;
  }
}

async function detectLive() {
  const now = Date.now();
  const configuredNow = extractVideoId(config.liveUrl);
  const lookupEvery = state.live.chatId ? 300000 : (configuredNow ? 30000 : 60000);
  if (now - state.live.lastLookupAt < lookupEvery) return;
  state.live.lastLookupAt = now;

  const configuredVideoId = extractVideoId(config.liveUrl);
  if (configuredVideoId !== state.live.configuredVideoId) {
    state.live.configuredVideoId = configuredVideoId;
    clearLiveRuntime();
    state.live.lastError = null;
    state.live.waitingReason = null;
    state.live.phase = configuredVideoId ? 'waiting' : 'idle';
  }

  try {
    let videoId = configuredVideoId;
    let chatId = null, title = null, source = null;
    let waitingReason = null;

    // Caminho preferencial: URL/ID colado pelo usuário. Funciona com OAuth OU API Key.
    // Isso evita depender da descoberta automática e funciona inclusive com broadcasts persistentes.
    if (videoId) {
      const v = await youtubeGet('videos', { part: 'snippet,liveStreamingDetails,status', id: videoId }, true);
      const item = v.items?.[0];
      if (!item) throw new Error('A URL/ID informada não corresponde a um vídeo acessível pelo YouTube.');

      title = item?.snippet?.title || null;
      chatId = item?.liveStreamingDetails?.activeLiveChatId || null;
      source = config.refreshToken ? 'URL + OAuth' : 'URL + API Key';
      state.live.videoId = videoId;
      state.live.title = title;
      state.live.source = source;

      if (!chatId) {
        const liveState = item?.snippet?.liveBroadcastContent || 'none';
        const actualEnd = item?.liveStreamingDetails?.actualEndTime;
        if (actualEnd) waitingReason = 'Essa transmissão já terminou. Na próxima live, cole o novo link/ID.';
        else if (liveState === 'upcoming') waitingReason = 'Live encontrada e agendada. Aguardando você iniciar a transmissão.';
        else if (liveState === 'live') waitingReason = 'A live está no ar, mas o YouTube ainda não retornou um chat ativo. Verifique se o chat ao vivo está habilitado.';
        else waitingReason = 'Vídeo encontrado, mas ainda não há chat ao vivo ativo. Se esta for a próxima live, o programa continuará aguardando.';
      }
    }

    // Descoberta automática via OAuth.
    // IMPORTANTE: liveBroadcasts.list aceita apenas UM filtro principal por chamada.
    // Portanto usamos mine=true sozinho e filtramos o lifeCycleStatus localmente.
    // broadcastType=all continua permitido com mine=true e inclui eventos e streams persistentes.
    if (!chatId && !configuredVideoId && config.autoDetectLive && config.refreshToken) {
      const broadcasts = [];
      let pageToken = null;
      for (let page = 0; page < 5; page++) {
        const params = {
          part:'id,snippet,status',
          mine:'true',
          broadcastType:'all',
          maxResults:50
        };
        if (pageToken) params.pageToken = pageToken;
        const b = await youtubeGet('liveBroadcasts', params, true);
        broadcasts.push(...(b.items || []));
        pageToken = b.nextPageToken || null;
        if (!pageToken) break;
      }

      const activeStates = new Set(['live','liveStarting','testing','testStarting']);
      const item = broadcasts.find(x => activeStates.has(x?.status?.lifeCycleStatus) && x?.snippet?.liveChatId) || null;
      if (item) {
        videoId = item.id;
        chatId = item.snippet.liveChatId;
        title = item.snippet.title || null;
        source = 'OAuth automático';
      } else {
        const upcoming = broadcasts
          .filter(x => ['ready','created'].includes(x?.status?.lifeCycleStatus))
          .sort((a,b) => new Date(a?.snippet?.scheduledStartTime || 8640000000000000) - new Date(b?.snippet?.scheduledStartTime || 8640000000000000))[0];
        waitingReason = upcoming
          ? `Live agendada encontrada: ${upcoming.snippet?.title || upcoming.id}. Aguardando iniciar.`
          : 'OAuth conectado. Aguardando uma live ativa neste canal.';
      }
    }

    if (chatId) {
      if (chatId !== state.live.chatId) {
        state.live.chatId = chatId;
        state.live.videoId = videoId;
        state.live.title = title;
        state.live.pageToken = null;
        state.live.primed = false;
        state.live.nextPollAt = 0;
        state.live.source = source;
        ensureSession(videoId, title);
        appendLog('info', `[YOUTUBE] Live detectada: ${title || videoId} | chat ${chatId}`);
      }
      state.live.phase = 'connected';
      state.live.waitingReason = null;
      state.live.lastError = null;
      state.live.reconnects = 0;
      return;
    }

    clearLiveRuntime(true);
    state.live.phase = 'waiting';
    state.live.waitingReason = waitingReason || 'Aguardando uma live ativa.';
    state.live.lastError = null;
  } catch (e) {
    clearLiveRuntime(true);
    if (state.quotaExceeded) {
      state.live.phase = 'quota';
      state.live.waitingReason = state.quotaMessage;
      state.live.lastError = null;
    } else {
      state.live.phase = 'error';
      state.live.waitingReason = null;
      state.live.lastError = e.message;
    }
  }
}


const graphemeSegmenter = (() => {
  try { return new Intl.Segmenter('pt-BR', { granularity: 'grapheme' }); }
  catch { return null; }
})();
function extractUnicodeEmojis(text) {
  const raw = String(text || '');
  if (!raw) return [];
  const parts = graphemeSegmenter ? [...graphemeSegmenter.segment(raw)].map(x => x.segment) : Array.from(raw);
  const out = [];
  for (const seg of parts) {
    try {
      if (/\p{Extended_Pictographic}/u.test(seg) || /\p{Regional_Indicator}/u.test(seg) || /\p{Emoji_Presentation}/u.test(seg) || /[0-9#*]\uFE0F?\u20E3/u.test(seg)) out.push(seg);
    } catch {
      if (/[\u2600-\u27BF\uD83C-\uDBFF\uDC00-\uDFFF]/u.test(seg)) out.push(seg);
    }
  }
  return out;
}
function textForEmoteWall(item) {
  const s = item?.snippet || {};
  switch (s.type) {
    case 'textMessageEvent': return s.textMessageDetails?.messageText || s.displayMessage || '';
    case 'superChatEvent': return s.superChatDetails?.userComment || '';
    case 'memberMilestoneChatEvent': return s.memberMilestoneChatDetails?.userComment || '';
    default: return '';
  }
}
function emitEmotesFromChatItem(item) {
  if (!config.emoteWallEnabled) return;
  const text = textForEmoteWall(item);
  if (!text) return;
  const emojis = extractUnicodeEmojis(text).slice(0, Math.max(1, Number(config.emotePerMessage || 6)));
  if (!emojis.length) return;
  const a = item?.authorDetails || {};
  for (const emoji of emojis) pushEmoteEvent(emoji, { name:a.displayName || '', avatar:a.profileImageUrl || '', source:'youtube-live' });
}

function mapChatEvent(item) {
  const type = item?.snippet?.type;
  const a = item?.authorDetails || {};
  const s = item?.snippet || {};
  const sourceId = item?.id || '';
  const base = {
    sourceId,
    name:a.displayName || 'Usuário do YouTube',
    avatar:a.profileImageUrl || '',
    source:'youtube-live'
  };
  switch(type) {
    case 'textMessageEvent': {
      const d=s.textMessageDetails||{};
      return ['chat', { ...base, message:d.messageText || s.displayMessage || '' }];
    }
    case 'newSponsorEvent': {
      const d=s.newSponsorDetails||{};
      if (d.isUpgrade) return ['upgrade', { ...base, detail:d.memberLevelName || '', level:d.memberLevelName || '' }];
      return ['member', { ...base, detail:d.memberLevelName || '', level:d.memberLevelName || '' }];
    }
    case 'memberMilestoneChatEvent': {
      const d=s.memberMilestoneChatDetails||{};
      const months=Number(d.memberMonth||0);
      return ['milestone', { ...base, months, message:d.userComment || '', detail:[months?`${months} meses`:'',d.memberLevelName||''].filter(Boolean).join(' • '), level:d.memberLevelName||'' }];
    }
    case 'superChatEvent': {
      const d=s.superChatDetails||{};
      return ['superchat', { ...base, amount:d.amountDisplayString || '', amountMicros:Number(d.amountMicros||0), currency:d.currency||'', message:d.userComment || '' }];
    }
    case 'superStickerEvent': {
      const d=s.superStickerDetails||{};
      return ['sticker', { ...base, amount:d.amountDisplayString || '', amountMicros:Number(d.amountMicros||0), currency:d.currency||'', message:d.superStickerMetadata?.altText || '' }];
    }
    case 'membershipGiftingEvent': {
      const d=s.membershipGiftingDetails||{};
      const n=Number(d.giftMembershipsCount||0);
      const lvl=d.giftMembershipsLevelName||'';
      return ['gift', { ...base, count:n, amount:n ? `${n} presente${n===1?'':'s'}` : '', detail:lvl, level:lvl }];
    }
    case 'giftMembershipReceivedEvent': {
      const d=s.giftMembershipReceivedDetails||{};
      return ['giftreceived', { ...base, detail:d.memberLevelName || '', level:d.memberLevelName || '' }];
    }
    case 'giftEvent': {
      const d=s.giftEventDetails?.giftMetadata||{};
      const jewels=Number(d.jewelsAmount||0), combo=Number(d.comboCount||0);
      return ['jewelgift', { ...base, amount:jewels?`${jewels} Jewels`:'', count:combo, detail:[d.giftName||'',combo>1?`Combo x${combo}`:''].filter(Boolean).join(' • '), message:d.altText||'' }];
    }
    default:
      return null;
  }
}

// No primeiro lote só recuperamos apoio financeiro/membros muito recentes.
// Mensagens normais e alertas antigos continuam ignorados ao entrar na live.
const RECENT_PAID_EVENT_WINDOW_MS = 30 * 60 * 1000;
const PAID_CHAT_TYPES = new Set([
  'superChatEvent','superStickerEvent','newSponsorEvent',
  'memberMilestoneChatEvent','membershipGiftingEvent',
  'giftMembershipReceivedEvent','giftEvent'
]);
function recentPaidChatItem(item, now=Date.now()) {
  if (!PAID_CHAT_TYPES.has(item?.snippet?.type)) return false;
  const when = Date.parse(item?.snippet?.publishedAt || '');
  return Number.isFinite(when) && when <= now + 60000 && (now - when) <= RECENT_PAID_EVENT_WINDOW_MS;
}
function processChatItem(item, includeEmotes=true) {
  if (includeEmotes) emitEmotesFromChatItem(item);
  const mapped = mapChatEvent(item);
  return mapped ? addEvent(mapped[0], mapped[1]) : null;
}

async function pollLiveChat() {
  if (!state.live.chatId || Date.now() < state.live.nextPollAt) return;
  try {
    // NUNCA envie hl=pt_BR: esse formato não é um código de idioma aceito pela API.
    // Omitir hl mantém os eventos e valores monetários retornados pelo YouTube.
    const params = { liveChatId: state.live.chatId, part:'id,snippet,authorDetails', maxResults:200, profileImageSize:88 };
    if (state.live.pageToken) params.pageToken = state.live.pageToken;
    const d = await youtubeGet('liveChat/messages', params, !!config.refreshToken);
    // Respeita o intervalo informado pelo YouTube e reduz consumo da cota.
    const interval = Math.max(5000, Number(d.pollingIntervalMillis || 5000));
    state.live.nextPollAt = Date.now() + interval;
    state.live.lastSuccessAt = new Date().toISOString();
    state.live.phase = 'connected';
    state.live.reconnects = 0;
    state.live.lastErrorLoggedText = '';

    if (!state.live.primed) {
      let recovered = 0;
      for (const item of (d.items || [])) {
        if (recentPaidChatItem(item) && processChatItem(item, false)) recovered++;
      }
      state.live.recoveredPaidEvents += recovered;
      state.live.pageToken = d.nextPageToken || null;
      state.live.primed = true;
      state.live.lastError = null;
      appendLog('info', `[YOUTUBE] Chat conectado. ${recovered} evento(s) pago(s) recente(s) recuperado(s); mensagens antigas ignoradas.`);
      return;
    }

    for (const item of (d.items || [])) {
      processChatItem(item);
    }
    state.live.pageToken = d.nextPageToken || state.live.pageToken;
    state.live.lastError = null;
  } catch (e) {
    const msg = e.message || String(e);
    state.live.lastError = msg;
    if (e.httpStatus === 400 && state.live.pageToken && /pageToken|invalid/i.test(msg)) {
      // Token de paginação expirado/inválido: renova sem repetir as mensagens comuns.
      state.live.pageToken = null;
      state.live.primed = false;
      state.live.nextPollAt = Date.now() + 15000;
      state.live.phase = 'reconnecting';
      appendLog('error', '[YOUTUBE] Token de paginação rejeitado. Reconectando com segurança em 15s.');
      return;
    }
    if (/liveChatEnded|not found|ended|closed/i.test(msg)) {
      clearLiveRuntime(true);
      state.live.phase = 'waiting';
      state.live.waitingReason = 'O chat dessa transmissão encerrou. Aguardando a próxima live.';
      state.live.lastError = null;
      state.live.lastLookupAt = 0;
    } else if (state.quotaExceeded) {
      state.live.phase = 'quota';
      state.live.waitingReason = state.quotaMessage;
      state.live.lastError = null;
      state.live.nextPollAt = state.apiPauseUntil;
      appendLog('error', `[YOUTUBE] ${state.quotaMessage}`);
    } else {
      state.live.phase = 'error';
      state.live.reconnects = Number(state.live.reconnects||0) + 1;
      const retryDelay = e.httpStatus === 400
        ? Math.min(300000, 30000 * Math.pow(2, Math.min(4, state.live.reconnects - 1)))
        : Math.min(60000, 5000 * Math.pow(2, Math.min(4, state.live.reconnects - 1)));
      state.live.nextPollAt = Date.now() + retryDelay;
      // Atualiza a identificação da transmissão nas falhas persistentes.
      if (state.live.reconnects >= 3) state.live.lastLookupAt = 0;
      if (msg !== state.live.lastErrorLoggedText || Date.now() - state.live.lastErrorLoggedAt > 60000) {
        appendLog('error', `[YOUTUBE] Falha no chat (HTTP ${e.httpStatus || '?'}): ${msg}. Próxima tentativa em ${Math.ceil(retryDelay/1000)}s.`);
        state.live.lastErrorLoggedText = msg;
        state.live.lastErrorLoggedAt = Date.now();
      }
    }
  }
}

async function pollSubscribers() {
  if (!config.pollSubscribers || !config.refreshToken || Date.now() < state.subscribers.nextPollAt) return;
  state.subscribers.nextPollAt = Date.now() + 120000;
  try {
    const d = await youtubeGet('subscriptions', { part:'subscriberSnippet,snippet', myRecentSubscribers:'true', maxResults:50 }, true);
    const items = d.items || [];
    const ids = [];
    for (const item of items) {
      const sub = item.subscriberSnippet || {};
      const id = sub.channelId || item.id;
      if (!id) continue;
      ids.push(id);
      if (state.subscribers.primed && !state.subscribers.known.has(id)) {
        addEvent('subscriber', {
          name: sub.title || item.snippet?.title || 'Novo inscrito',
          avatar: sub.thumbnails?.medium?.url || sub.thumbnails?.default?.url || '',
          source:'youtube-subscriber',
          sourceId:`subscriber:${id}`
        });
      }
    }
    state.subscribers.known = new Set(ids);
    state.subscribers.primed = true;
    state.subscribers.lastError = null;
  } catch (e) {
    state.subscribers.lastError = e.message;
  }
}

let tickRunning = false;
async function tick() {
  // Evita requisições concorrentes ao YouTube quando uma resposta demora > 1s.
  if (tickRunning) return;
  tickRunning = true;
  try {
    try { await detectLive(); } catch {}
    try { await pollLiveChat(); } catch {}
    try { await pollSubscribers(); } catch {}
  } finally { tickRunning = false; }
}
setInterval(tick, 1000);
setTimeout(tick, 300);

function testEvent(type, custom={}) {
  const samples = {
    subscriber:{name:'AventureiroBR', message:'se inscreveu no canal!'},
    member:{name:'SylvanasBR', detail:'Membro HERTEMUS', level:'Membro HERTEMUS'},
    upgrade:{name:'GarroshBR', detail:'Lenda HERTEMUS', level:'Lenda HERTEMUS', message:'subiu de nível!'},
    milestone:{name:'TaurenGamer', months:12, detail:'12 meses • Membro HERTEMUS', message:'Obrigado pelas lives!'},
    superchat:{name:'ArthasGameplays', amount:'R$ 20,00', amountMicros:20000000, currency:'BRL', message:'Grande live, Hertemus!'},
    sticker:{name:'JainaLive', amount:'R$ 10,00', amountMicros:10000000, currency:'BRL', message:'Mandou um Super Sticker!'},
    gift:{name:'ThrallBR', count:5, amount:'5 presentes', message:'presenteou a comunidade!'},
    giftreceived:{name:'IllidanPlayer', message:'ganhou uma assinatura de presente!'},
    jewelgift:{name:'AlexstraszaBR', amount:'250 Jewels', count:3, detail:'Dragão Roxo • Combo x3', message:'Enviou um presente!'},
    redirect:{name:'Raid da Horda', message:'chegou na live!'}
  };
  return addEvent(type, { ...(samples[type] || samples.subscriber), ...custom, source:'teste' });
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, BASE_URL);
    const p = decodeURIComponent(u.pathname);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'}); return res.end();
    }

    if (req.method === 'GET' && p === '/') return serveFile(res, path.join(WEB,'dashboard.html'));
    if (req.method === 'GET' && p === '/overlay') return serveFile(res, path.join(WEB,'overlay.html'));
    if (req.method === 'GET' && p === '/molduras') return serveFile(res, path.join(WEB,'scenes.html'));
    if (req.method === 'GET' && (p === '/gameplay' || p === '/camera')) return serveFile(res, path.join(WEB,'gameplay.html'));
    if (req.method === 'GET' && p === '/api/config') return json(res,200,safePublicConfig());
    if (req.method === 'GET' && p === '/api/status') {
      return json(res,200,{
        ok:true,
        server:'online',
        oauthConnected:!!config.refreshToken,
        apiKeyConfigured:!!config.apiKey,
        live:{...state.live},
        subscribers:{primed:state.subscribers.primed,lastError:state.subscribers.lastError,enabled:config.pollSubscribers},
        eventCount:state.events.length,
        emoteCount:state.emotes.length,
        lastEvent:state.events[state.events.length-1] || null,
        overlayClients:streamClients.size,
        session:state.session,
        lastApiError:state.lastApiError,
        quotaExceeded:state.quotaExceeded,
        apiPauseUntil:state.apiPauseUntil,
        dataDir:DATA
      });
    }
    if (req.method === 'GET' && p === '/api/diagnostics') {
      const out = { ok:true, oauthConnected:!!config.refreshToken, apiKeyConfigured:!!config.apiKey, channel:null, directLive:null, autoActive:[], checks:[] };
      try {
        if (config.refreshToken) {
          const c = await youtubeGet('channels', { part:'id,snippet', mine:'true', maxResults:1 }, true);
          const ch = c.items?.[0];
          if (ch) { out.channel = { id:ch.id, title:ch.snippet?.title || '' }; out.checks.push({name:'OAuth',ok:true,detail:`Conectado ao canal ${out.channel.title}`}); }
          else out.checks.push({name:'OAuth',ok:false,detail:'OAuth válido, mas nenhum canal do YouTube foi retornado para esta conta.'});
        } else out.checks.push({name:'OAuth',ok:false,detail:'OAuth não conectado.'});
      } catch(e) { out.ok=false; out.checks.push({name:'OAuth',ok:false,detail:e.message}); }

      const vid = extractVideoId(config.liveUrl);
      if (vid) {
        try {
          const v = await youtubeGet('videos',{part:'snippet,liveStreamingDetails,status',id:vid},true);
          const item=v.items?.[0];
          if (item) {
            out.directLive = {
              id:vid,
              title:item.snippet?.title || '',
              liveBroadcastContent:item.snippet?.liveBroadcastContent || 'none',
              activeLiveChatId:!!item.liveStreamingDetails?.activeLiveChatId,
              scheduledStartTime:item.liveStreamingDetails?.scheduledStartTime || null,
              actualStartTime:item.liveStreamingDetails?.actualStartTime || null,
              actualEndTime:item.liveStreamingDetails?.actualEndTime || null
            };
            out.checks.push({name:'Link da live',ok:true,detail:`Vídeo encontrado: ${out.directLive.title || vid}`});
          } else { out.ok=false; out.checks.push({name:'Link da live',ok:false,detail:'O link/ID salvo não foi encontrado.'}); }
        } catch(e) { out.ok=false; out.checks.push({name:'Link da live',ok:false,detail:e.message}); }
      } else out.checks.push({name:'Link da live',ok:true,detail:'Nenhum link salvo; será usada a detecção automática.'});

      if (config.refreshToken) {
        try {
          const broadcasts=[]; let pageToken=null;
          for (let page=0; page<5; page++) {
            const params={part:'id,snippet,status',mine:'true',broadcastType:'all',maxResults:50};
            if (pageToken) params.pageToken=pageToken;
            const b=await youtubeGet('liveBroadcasts',params,true);
            broadcasts.push(...(b.items||[]));
            pageToken=b.nextPageToken||null;
            if(!pageToken) break;
          }
          const activeStates=new Set(['live','liveStarting','testing','testStarting']);
          out.autoActive=broadcasts
            .filter(x=>activeStates.has(x?.status?.lifeCycleStatus))
            .map(x=>({id:x.id,title:x.snippet?.title||'',hasChat:!!x.snippet?.liveChatId,status:x.status?.lifeCycleStatus||'',privacy:x.status?.privacyStatus||''}));
          const upcoming=broadcasts.filter(x=>['ready','created'].includes(x?.status?.lifeCycleStatus));
          out.checks.push({name:'Busca automática',ok:true,detail:out.autoActive.length?`${out.autoActive.length} live(s) ativa(s) encontrada(s).`:(upcoming.length?`${upcoming.length} live(s) agendada(s) encontrada(s); nenhuma está ao vivo agora.`:'Nenhuma live ativa ou agendada encontrada agora.')});
        } catch(e) { out.ok=false; out.checks.push({name:'Busca automática',ok:false,detail:e.message}); }
      }
      return json(res,200,out);
    }

    if (req.method === 'GET' && p === '/api/stream') {
      res.writeHead(200, {
        'Content-Type':'text/event-stream; charset=utf-8',
        'Cache-Control':'no-cache, no-transform',
        'Connection':'keep-alive',
        'Access-Control-Allow-Origin':'*',
        'X-Accel-Buffering':'no'
      });
      res.write(`event: hello\ndata: ${JSON.stringify({latest:state.seq,emoteLatest:state.emoteSeq,...overlaySettingsPayload()})}\n\n`);
      streamClients.add(res);
      req.on('close', () => streamClients.delete(res));
      return;
    }

    if (req.method === 'GET' && p === '/api/events') {
      const since = Number(u.searchParams.get('since') || 0);
      const emoteSince = Number(u.searchParams.get('emoteSince') || 0);
      return json(res,200,{events:state.events.filter(e=>e.id>since),emotes:state.emotes.filter(e=>e.id>emoteSince),latest:state.seq,emoteLatest:state.emoteSeq,...overlaySettingsPayload()});
    }
    if (req.method === 'GET' && p === '/api/history') {
      return json(res,200,{ok:true,events:readHistory(Number(u.searchParams.get('limit')||100))});
    }
    if (req.method === 'GET' && p === '/api/session') {
      return json(res,200,{ok:true,session:state.session});
    }
    if (req.method === 'POST' && p === '/api/replay') {
      const ev = state.events[state.events.length-1];
      if (!ev) return json(res,404,{ok:false,error:'Nenhum alerta para repetir.'});
      const replay = addEvent(ev.type,{...ev,sourceId:'',source:'replay',createdAt:undefined});
      return json(res,200,{ok:true,event:replay});
    }
    if (req.method === 'POST' && p === '/api/reset-session') {
      resetSession(state.live.videoId || null, state.live.title || null);
      return json(res,200,{ok:true,session:state.session});
    }
    if (req.method === 'GET' && p === '/api/test') {
      const type = u.searchParams.get('type') || 'subscriber';
      if (type === 'emotewall') {
        const demo = ['🔥','💜','😂','⚔️','🎉','👑','💀','✨','❤️','🚀','😱','👏'];
        const count = Math.max(1, Math.min(demo.length, Number(config.emoteMaxOnScreen || 6)));
        const sent = demo.slice(0,count).map((emoji,i)=>pushEmoteEvent(emoji,{name:'Teste HERTEMUS',source:'teste-emote'})).filter(Boolean);
        return json(res,200,{ok:true,emotes:sent.length});
      }
      const ev = testEvent(type);
      return json(res,200,{ok:true,event:ev});
    }
    if (req.method === 'POST' && p === '/api/test') {
      const raw = await readBody(req); let body={};
      try { body=JSON.parse(raw||'{}'); } catch {}
      const type = body.type || 'subscriber';
      delete body.type;
      const ev = testEvent(type,body);
      return json(res,200,{ok:true,event:ev});
    }
    if (req.method === 'POST' && p === '/api/config') {
      const raw = await readBody(req); let body={};
      try { body=JSON.parse(raw||'{}'); } catch { return json(res,400,{ok:false,error:'JSON inválido'}); }
      const allowed=['apiKey','liveUrl','clientId','clientSecret','durationMs','volume','alertScale','alertTemplate','pollSubscribers','autoDetectLive','emoteWallEnabled','emoteMaxOnScreen','emotePerMessage','emoteMinSize','emoteMaxSize','emoteDurationMs','emoteMinGapMs','sceneTheme','sceneCameraStyle','sceneCameraEnabled','sceneMotionEnabled','sceneCameraX','sceneCameraY','sceneCameraWidth','sceneOverlayOpacity','sceneCameraOpacity'];
      const previousLiveUrl = config.liveUrl;
      if (Object.prototype.hasOwnProperty.call(body,'liveUrl') && /apps\.googleusercontent\.com/i.test(String(body.liveUrl||''))) body.liveUrl = previousLiveUrl || '';
      for (const k of allowed) if (Object.prototype.hasOwnProperty.call(body,k)) config[k]=body[k];
      config.durationMs = Math.max(3000, Math.min(15000, Number(config.durationMs||6500)));
      config.volume = Math.max(0, Math.min(1, Number(config.volume??0.85)));
      config.alertScale = Math.max(0.25, Math.min(1.20, Number(config.alertScale||0.72)));
      config.alertTemplate = String(config.alertTemplate||'original').replace(/[^a-z0-9_-]/gi,'').slice(0,60) || 'original';
      config.emoteWallEnabled = config.emoteWallEnabled !== false;
      config.emoteMaxOnScreen = Math.max(1, Math.min(30, Number(config.emoteMaxOnScreen||6)));
      config.emotePerMessage = Math.max(1, Math.min(10, Number(config.emotePerMessage||3)));
      config.emoteMinSize = Math.max(24, Math.min(160, Number(config.emoteMinSize||42)));
      config.emoteMaxSize = Math.max(config.emoteMinSize, Math.min(220, Number(config.emoteMaxSize||112)));
      config.emoteDurationMs = Math.max(2500, Math.min(15000, Number(config.emoteDurationMs||6200)));
      config.emoteMinGapMs = Math.max(0, Math.min(5000, Number(config.emoteMinGapMs ?? 900)));
      config.sceneTheme = /^frame-\d{2}$/.test(String(config.sceneTheme)) ? String(config.sceneTheme) : 'frame-00';
      config.sceneCameraStyle = /^camera-\d{2}$/.test(String(config.sceneCameraStyle)) ? String(config.sceneCameraStyle) : 'camera-00';
      config.sceneCameraEnabled = config.sceneCameraEnabled === true;
      config.sceneMotionEnabled = config.sceneMotionEnabled !== false;
      config.sceneCameraX = Math.max(0, Math.min(85, Number(config.sceneCameraX??4)));
      config.sceneCameraY = Math.max(0, Math.min(80, Number(config.sceneCameraY??5)));
      config.sceneCameraWidth = Math.max(12, Math.min(47, Number(config.sceneCameraWidth??24)));
      config.sceneOverlayOpacity = Math.max(0.2, Math.min(1, Number(config.sceneOverlayOpacity??1)));
      config.sceneCameraOpacity = Math.max(0.2, Math.min(1, Number(config.sceneCameraOpacity??1)));
      saveConfig();
      pushNamedStreamEvent('settings', {id:Date.now(), ...overlaySettingsPayload()});
      state.live.lastLookupAt=0;
      if (previousLiveUrl !== config.liveUrl) {
        state.live.configuredVideoId = null;
        clearLiveRuntime();
      }
      return json(res,200,{ok:true,config:safePublicConfig()});
    }
    if (req.method === 'POST' && p === '/api/disconnect') {
      config.refreshToken=''; config.accessToken=''; config.accessTokenExpiry=0; saveConfig();
      state.subscribers.primed=false; state.subscribers.known=new Set();
      return json(res,200,{ok:true});
    }
    if (req.method === 'GET' && p === '/oauth/start') {
      if (!config.clientId || !config.clientSecret) return redirect(res,'/?oauth=missing');
      state.oauthState = crypto.randomBytes(18).toString('hex');
      const q = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: `${BASE_URL}/oauth/callback`,
        response_type:'code',
        scope:'https://www.googleapis.com/auth/youtube.readonly',
        access_type:'offline',
        prompt:'consent',
        include_granted_scopes:'true',
        state:state.oauthState
      });
      return redirect(res,`https://accounts.google.com/o/oauth2/v2/auth?${q}`);
    }
    if (req.method === 'GET' && p === '/oauth/callback') {
      const code=u.searchParams.get('code'); const gotState=u.searchParams.get('state');
      if (!code || !gotState || gotState!==state.oauthState) return text(res,400,'Falha na validação OAuth. Volte ao painel e tente conectar novamente.');
      const body=new URLSearchParams({code,client_id:config.clientId,client_secret:config.clientSecret,redirect_uri:`${BASE_URL}/oauth/callback`,grant_type:'authorization_code'});
      const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});
      const d=await r.json();
      if(!r.ok) return text(res,400,`Falha no OAuth: ${d.error_description||d.error||r.status}`);
      config.accessToken=d.access_token||'';
      config.accessTokenExpiry=Date.now()+(d.expires_in||3600)*1000;
      if(d.refresh_token) config.refreshToken=d.refresh_token;
      saveConfig();
      state.oauthState=null; state.live.lastLookupAt=0; state.subscribers.primed=false;
      return redirect(res,'/?oauth=ok');
    }

    if (req.method === 'GET' && p.startsWith('/assets/')) {
      const rel = p.replace(/^\/+/, '');
      return serveFile(res, path.join(WEB, rel));
    }

    return text(res,404,'Não encontrado');
  } catch (e) {
    appendLog('error', `[SERVIDOR] ${e.stack || e.message || e}`);
    return json(res,500,{ok:false,error:e.message});
  }
});

server.on('error', err => {
  appendLog('error', `ERRO AO INICIAR: ${err.message}`);
  if (err.code === 'EADDRINUSE') console.error('A porta 3000 já está em uso. Talvez o HERTEMUS Alerts já esteja aberto.');
});
server.listen(PORT, HOST, () => {
  console.log('====================================================');
  console.log('          HERTEMUS ALERTS 4.3.1 - ONLINE');
  console.log('====================================================');
  console.log(`Painel : ${BASE_URL}/`);
  console.log(`OBS    : ${BASE_URL}/overlay`);
  console.log('Feche esta janela para encerrar o programa.');
  console.log('====================================================');
  setTimeout(() => {
    const target = `${BASE_URL}/`;
    if (process.platform === 'win32') exec(`start "" "${target}"`);
  }, 700);
});
