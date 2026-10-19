import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} from '@whiskeysockets/baileys';
import { ADMIN_HTML } from './admin.js';

/* ------------------------------------------------------------ Config */
const SECRET    = (process.env.SECRET || '').trim();
const HOST      = process.env.HOST || '127.0.0.1';
const PORT      = parseInt(process.env.PORT || '3000', 10);
const AUTH_DIR  = process.env.AUTH_DIR || './auth';
const MIN_DELAY = Math.max(0, parseFloat(process.env.MIN_DELAY || '3'));
const MAX_DELAY = Math.max(MIN_DELAY, parseFloat(process.env.MAX_DELAY || '8'));

if (SECRET.length < 12) {
  console.error('Falta SECRET en las variables (mínimo 12 caracteres).');
  process.exit(1);
}

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const ID_RE = /^[a-z0-9_-]{1,32}$/;

/* ------------------------------------------------------------ Registro de números (sesiones) */
const SESS_DIR = path.join(AUTH_DIR, 'sessions');
const REG_FILE = path.join(AUTH_DIR, 'sessions.json');
fs.mkdirSync(SESS_DIR, { recursive: true });

// Migración: si antes había UN solo número guardado directo en AUTH_DIR, pasa a la sesión "default"
if (fs.existsSync(path.join(AUTH_DIR, 'creds.json')) && !fs.existsSync(path.join(SESS_DIR, 'default'))) {
  const dest = path.join(SESS_DIR, 'default');
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(AUTH_DIR)) {
    if (f === 'sessions' || f === 'sessions.json') continue;
    fs.renameSync(path.join(AUTH_DIR, f), path.join(dest, f));
  }
  console.log('Sesión anterior migrada a "default".');
}

let registry = {};
try { registry = JSON.parse(fs.readFileSync(REG_FILE, 'utf8')); } catch { registry = {}; }
if (!registry.default) registry.default = { name: 'Principal' };   // usa la SECRET general
const saveRegistry = () => fs.writeFileSync(REG_FILE, JSON.stringify(registry, null, 2));
saveRegistry();

const newKey = () => crypto.randomBytes(24).toString('hex');

/* ------------------------------------------------------------ Sistemas conectados (clientes de la API)
   Cada sistema externo tiene su propia clave y una lista de instancias permitidas ('*' = todas).
   El sistema consulta GET /instances y elige en cuál enviar con el campo "instance". */
const CLIENTS_FILE = path.join(AUTH_DIR, 'clients.json');
let clients = {};
try { clients = JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8')); } catch { clients = {}; }
const saveClients = () => fs.writeFileSync(CLIENTS_FILE, JSON.stringify(clients, null, 2));
const clientAllows = (cid, id) => {
  const l = clients[cid]?.instances || [];
  return l.includes('*') || l.includes(id);
};

/* ------------------------------------------------------------ WhatsApp (una conexión por número) */
const sessions = new Map();

function createSession(id) {
  const s = { id, sock: null, state: 'starting', qr: null, me: null, starting: false,
              stopped: false, queue: Promise.resolve(), lastSentAt: 0 };
  sessions.set(id, s);
  start(s);
  return s;
}

async function start(s) {
  if (s.starting || s.stopped) return;
  s.starting = true;
  const dir = path.join(SESS_DIR, s.id);
  try {
    const { state: auth, saveCreds } = await useMultiFileAuthState(dir);
    let version;
    try { ({ version } = await fetchLatestBaileysVersion()); } catch { /* versión por defecto */ }

    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth,
      logger,
      browser: Browsers.ubuntu('Facturas'),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    s.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (u) => {
      if (s.sock !== sock || s.stopped) return;      // evento de una conexión vieja
      const { connection, lastDisconnect, qr } = u;

      if (qr) {
        s.state = 'qr';
        try { s.qr = await QRCode.toDataURL(qr, { margin: 1, width: 320 }); } catch { s.qr = null; }
      }
      if (connection === 'open') {
        s.state = 'connected';
        s.qr = null;
        s.me = sock.user ? String(sock.user.id).split(':')[0].split('@')[0] : null;
        console.log(`[${s.id}] WhatsApp conectado:`, s.me);
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        s.me = null; s.qr = null; s.starting = false;
        if (code === DisconnectReason.loggedOut) {
          s.state = 'logged_out';
          fs.rmSync(dir, { recursive: true, force: true });
          setTimeout(() => start(s), 1500);
        } else {
          s.state = 'reconnecting';
          setTimeout(() => start(s), 3000);
        }
      }
    });
  } catch (e) {
    console.error(`[${s.id}] Error iniciando WhatsApp:`, e.message);
    s.state = 'reconnecting';
    s.starting = false;
    setTimeout(() => start(s), 5000);
    return;
  }
  s.starting = false;
}

async function logoutSession(s) {
  try { await s.sock?.logout(); } catch { /* ya estaba cerrada */ }
  fs.rmSync(path.join(SESS_DIR, s.id), { recursive: true, force: true });
  s.state = 'logged_out'; s.qr = null; s.me = null;
  const old = s.sock; s.sock = null;
  try { old?.end(undefined); } catch {}
  s.starting = false;
  setTimeout(() => start(s), 1000);
}

async function removeSession(s) {
  s.stopped = true;
  try { await s.sock?.logout(); } catch {}
  try { s.sock?.end(undefined); } catch {}
  fs.rmSync(path.join(SESS_DIR, s.id), { recursive: true, force: true });
  sessions.delete(s.id);
}

/* Cola por número: un mensaje a la vez, con pausa aleatoria */
function enqueue(s, task) {
  const run = s.queue.then(async () => {
    const wait = s.lastSentAt + rand(MIN_DELAY, MAX_DELAY) * 1000 - Date.now();
    if (wait > 0) await sleep(wait);
    try { return await task(); } finally { s.lastSentAt = Date.now(); }
  });
  s.queue = run.catch(() => {});
  return run;
}

/* Si el hosting durmió el proceso, esperamos a que reconecte antes de fallar */
async function waitConnected(s, maxMs = 18000) {
  const t0 = Date.now();
  while (s.state !== 'connected' && s.state !== 'qr' && s.state !== 'logged_out' && Date.now() - t0 < maxMs) {
    await sleep(500);
  }
  return s.state === 'connected';
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

async function sendMessage(s, p) {
  const phone = String(p?.client?.phone || '').replace(/\D+/g, '');
  if (phone.length < 10) throw httpError(422, 'Teléfono inválido.');

  const [found] = (await s.sock.onWhatsApp(phone)) || [];
  if (!found?.exists) throw httpError(422, 'Ese número no tiene WhatsApp.');
  const jid = found.jid;

  const text = String(p.message || '').slice(0, 1000);

  let buffer = null;
  const pdf = p.pdf || {};
  if (pdf.base64) {
    buffer = Buffer.from(pdf.base64, 'base64');
  } else if (pdf.url) {
    const r = await fetch(pdf.url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw httpError(502, `No se pudo descargar el archivo (HTTP ${r.status}).`);
    buffer = Buffer.from(await r.arrayBuffer());
  }

  await s.sock.sendPresenceUpdate('composing', jid);
  await sleep(rand(800, 2000));

  if (buffer && buffer.length > 0) {
    await s.sock.sendMessage(jid, {
      document: buffer,
      mimetype: pdf.mime || 'application/pdf',
      fileName: pdf.filename || 'documento.pdf',
      caption: text,
    });
  } else {
    await s.sock.sendMessage(jid, { text });
  }
  await s.sock.sendPresenceUpdate('paused', jid);
  return { to: phone, with_file: !!buffer };
}

/* ------------------------------------------------------------ Autenticación */
function safeEq(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

/* admin = SECRET general (o firma HMAC). Clave de número = solo puede usar ese número. */
function identify(req) {
  const key = req.get('x-webhook-secret');
  if (key && safeEq(key, SECRET)) return { admin: true };
  const sig = req.get('x-signature');
  if (sig && req.rawBody) {
    const expect = 'sha256=' + crypto.createHmac('sha256', SECRET).update(req.rawBody).digest('hex');
    if (safeEq(sig, expect)) return { admin: true };
  }
  if (key) {
    for (const [id, r] of Object.entries(registry)) {
      if (r.apiKey && safeEq(key, r.apiKey)) return { session: id };
    }
    for (const [id, c] of Object.entries(clients)) {
      if (c.apiKey && safeEq(key, c.apiKey)) return { client: id };
    }
  }
  return null;
}

const canUse = (auth, id) => !!(auth.admin || auth.session === id || (auth.client && clientAllows(auth.client, id)));

/* ------------------------------------------------------------ HTTP */
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '20mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

/* ------------------------------------------------------------ Registro de peticiones
   Guarda cada petición (también las rechazadas por clave incorrecta) para poder ver qué llega a la API.
   No guarda el texto del mensaje ni la clave; el teléfono se guarda enmascarado. */
const LOG_FILE = path.join(AUTH_DIR, 'requests.jsonl');
const LOG_MAX  = 1000;
let reqLog = [];
try {
  reqLog = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean).slice(-LOG_MAX)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
} catch { reqLog = []; }
let logSeq = reqLog.reduce((m, e) => Math.max(m, e.n || 0), 0);

function pushLog(entry) {
  entry.n = ++logSeq;
  reqLog.push(entry);
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
    if (reqLog.length > LOG_MAX * 1.5) {            // recorta memoria y archivo
      reqLog = reqLog.slice(-LOG_MAX);
      fs.writeFileSync(LOG_FILE, reqLog.map((e) => JSON.stringify(e)).join('\n') + '\n');
    }
  } catch { /* si el disco falla, al menos queda en memoria */ }
}
const maskPhone = (p) => {
  const d = String(p || '').replace(/\D+/g, '');
  return d.length > 6 ? d.slice(0, 4) + '***' + d.slice(-3) : d;
};
const clientIp = (req) => String(req.get('x-forwarded-for') || req.socket.remoteAddress || '').split(',')[0].trim();

app.use((req, res, next) => {
  const t0 = Date.now();
  const origJson = res.json.bind(res);
  res.json = (o) => { res.locals.out = o; return origJson(o); };
  res.on('finish', () => {
    const p = req.path;
    if (p === '/' || p === '/admin' || p === '/health' || p.startsWith('/logs')) return;
    if (req.method === 'GET' && req.auth?.admin) return;     // ruido del panel
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const out = res.locals.out || {};
    const who = req.auth?.admin ? 'admin (SECRET)'
      : req.auth?.session ? 'número: ' + req.auth.session
      : req.auth?.client ? 'sistema: ' + req.auth.client
      : (req.get('x-webhook-secret') || req.get('x-signature') ? 'clave incorrecta' : 'sin clave');
    pushLog({
      t: new Date().toISOString(),
      method: req.method,
      path: p,
      ip: clientIp(req),
      who,
      event: b.event || (p === '/send' ? 'send' : ''),
      instance: out.session || String(b.instance || b.session || req.get('x-instance') || req.get('x-session') || req.auth?.session || '').toLowerCase(),
      phone: maskPhone(b.client?.phone || b.phone),
      event_id: b.event_id ? String(b.event_id).slice(0, 80) : '',
      has_file: !!(b.pdf && (b.pdf.url || b.pdf.base64)),
      msg_len: typeof b.message === 'string' ? b.message.length : 0,
      status: res.statusCode,
      ok: out.ok === true,
      duplicate: !!out.duplicate,
      error: out.ok === true ? '' : String(out.error || '').slice(0, 300),
      ms: Date.now() - t0,
    });
  });
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true }));
app.get(['/', '/admin'], (_req, res) => {
  res.set('Cache-Control', 'no-store').type('html').send(ADMIN_HTML);
});

app.use((req, res, next) => {
  req.auth = identify(req);
  if (!req.auth) return res.status(401).json({ ok: false, error: 'No autorizado.' });
  next();
});

const view = (s) => ({ id: s.id, name: registry[s.id]?.name || s.id, state: s.state, me: s.me });

/* --- Gestión de números --- */
app.get('/sessions', (req, res) => {
  if (!req.auth.admin) return res.status(403).json({ ok: false, error: 'Solo administrador.' });
  res.json({ ok: true, sessions: [...sessions.values()].map(view) });
});

app.post('/sessions', (req, res) => {
  if (!req.auth.admin) return res.status(403).json({ ok: false, error: 'Solo administrador.' });
  const id = String(req.body?.id || '').toLowerCase().trim();
  const name = String(req.body?.name || id).slice(0, 60);
  if (!ID_RE.test(id)) return res.status(400).json({ ok: false, error: 'Identificador inválido: usa letras minúsculas, números, - o _ (máx. 32).' });
  if (sessions.has(id)) return res.status(409).json({ ok: false, error: 'Ya existe un número con ese identificador.' });
  const apiKey = newKey();
  registry[id] = { name, apiKey };
  saveRegistry();
  createSession(id);
  res.json({ ok: true, id, name, apiKey });
});

app.post('/sessions/:id/rotate-key', (req, res) => {
  if (!req.auth.admin) return res.status(403).json({ ok: false, error: 'Solo administrador.' });
  const id = req.params.id;
  if (!sessions.has(id)) return res.status(404).json({ ok: false, error: 'Número no encontrado.' });
  if (id === 'default') return res.status(400).json({ ok: false, error: 'El número principal usa la clave general (SECRET).' });
  registry[id].apiKey = newKey();
  saveRegistry();
  res.json({ ok: true, id, apiKey: registry[id].apiKey });
});

app.delete('/sessions/:id', async (req, res) => {
  if (!req.auth.admin) return res.status(403).json({ ok: false, error: 'Solo administrador.' });
  const id = req.params.id;
  const s = sessions.get(id);
  if (!s) return res.status(404).json({ ok: false, error: 'Número no encontrado.' });
  if (id === 'default') return res.status(400).json({ ok: false, error: 'No se puede eliminar el número principal.' });
  await removeSession(s);
  delete registry[id];
  saveRegistry();
  for (const c of Object.values(clients)) c.instances = c.instances.filter((x) => x !== id);
  saveClients();
  res.json({ ok: true });
});

function statusOf(req, res, id) {
  const s = sessions.get(id);
  if (!s) return res.status(404).json({ ok: false, error: 'Número no encontrado.' });
  if (!canUse(req.auth, id)) return res.status(403).json({ ok: false, error: 'Esa clave no pertenece a este número.' });
  // Un sistema conectado puede ver el estado, pero el QR solo lo ve el administrador o el dueño de ese número
  return res.json({ ok: true, ...view(s), qr: req.auth.client ? null : s.qr });
}
async function logoutOf(req, res, id) {
  const s = sessions.get(id);
  if (!s) return res.status(404).json({ ok: false, error: 'Número no encontrado.' });
  if (!canUse(req.auth, id)) return res.status(403).json({ ok: false, error: 'Esa clave no pertenece a este número.' });
  await logoutSession(s);
  res.json({ ok: true });
}
app.get('/sessions/:id/status', (req, res) => statusOf(req, res, req.params.id));

/* --- Instancias visibles para quien llama (lo que un sistema usa para elegir) --- */
app.get('/instances', (req, res) => {
  const list = [...sessions.values()].filter((s) => canUse(req.auth, s.id)).map(view);
  res.json({ ok: true, instances: list });
});
app.get('/instances/:id/status', (req, res) => statusOf(req, res, req.params.id));

/* --- Registro de peticiones (solo administrador) --- */
app.get('/logs', (req, res) => {
  if (!req.auth.admin) return res.status(403).json({ ok: false, error: 'Solo administrador.' });
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));
  const only = String(req.query.only || '');
  const inst = String(req.query.instance || '').toLowerCase();
  const q = String(req.query.q || '').toLowerCase();
  let list = reqLog;
  if (only === 'errors') list = list.filter((e) => !e.ok);
  if (inst) list = list.filter((e) => e.instance === inst);
  if (q) list = list.filter((e) => JSON.stringify(e).toLowerCase().includes(q));
  res.json({ ok: true, total: reqLog.length, logs: list.slice(-limit).reverse() });
});
app.delete('/logs', (req, res) => {
  if (!req.auth.admin) return res.status(403).json({ ok: false, error: 'Solo administrador.' });
  reqLog = [];
  try { fs.writeFileSync(LOG_FILE, ''); } catch {}
  res.json({ ok: true });
});

/* --- Sistemas conectados (solo administrador) --- */
const adminOnly = (req, res) => {
  if (req.auth.admin) return true;
  res.status(403).json({ ok: false, error: 'Solo administrador.' });
  return false;
};
const cleanInstances = (v) => {
  if (v === '*' || (Array.isArray(v) && v.includes('*'))) return ['*'];
  const arr = (Array.isArray(v) ? v : []).map((x) => String(x).toLowerCase());
  return [...new Set(arr)].filter((x) => sessions.has(x));
};
const clientView = (id) => ({ id, name: clients[id].name, instances: clients[id].instances });

app.get('/clients', (req, res) => {
  if (!adminOnly(req, res)) return;
  res.json({ ok: true, clients: Object.keys(clients).map(clientView) });
});
app.post('/clients', (req, res) => {
  if (!adminOnly(req, res)) return;
  const id = String(req.body?.id || '').toLowerCase().trim();
  const name = String(req.body?.name || id).slice(0, 60);
  if (!ID_RE.test(id)) return res.status(400).json({ ok: false, error: 'Identificador inválido: usa letras minúsculas, números, - o _ (máx. 32).' });
  if (clients[id]) return res.status(409).json({ ok: false, error: 'Ya existe un sistema con ese identificador.' });
  const instances = cleanInstances(req.body?.instances);
  if (!instances.length) return res.status(400).json({ ok: false, error: 'Elige al menos una instancia (o todas).' });
  const apiKey = newKey();
  clients[id] = { name, apiKey, instances };
  saveClients();
  res.json({ ok: true, ...clientView(id), apiKey });
});
app.put('/clients/:id', (req, res) => {
  if (!adminOnly(req, res)) return;
  const c = clients[req.params.id];
  if (!c) return res.status(404).json({ ok: false, error: 'Sistema no encontrado.' });
  if (req.body?.name) c.name = String(req.body.name).slice(0, 60);
  if (req.body?.instances !== undefined) {
    const instances = cleanInstances(req.body.instances);
    if (!instances.length) return res.status(400).json({ ok: false, error: 'Elige al menos una instancia (o todas).' });
    c.instances = instances;
  }
  saveClients();
  res.json({ ok: true, ...clientView(req.params.id) });
});
app.post('/clients/:id/rotate-key', (req, res) => {
  if (!adminOnly(req, res)) return;
  const c = clients[req.params.id];
  if (!c) return res.status(404).json({ ok: false, error: 'Sistema no encontrado.' });
  c.apiKey = newKey();
  saveClients();
  res.json({ ok: true, id: req.params.id, apiKey: c.apiKey });
});
app.delete('/clients/:id', (req, res) => {
  if (!adminOnly(req, res)) return;
  if (!clients[req.params.id]) return res.status(404).json({ ok: false, error: 'Sistema no encontrado.' });
  delete clients[req.params.id];
  saveClients();
  res.json({ ok: true });
});
app.post('/sessions/:id/logout', (req, res) => logoutOf(req, res, req.params.id));
// Compatibilidad con la versión de un solo número
app.get('/status', (req, res) => statusOf(req, res, 'default'));
app.post('/logout', (req, res) => logoutOf(req, res, 'default'));

/* --- Envío --- */
const recent = new Set();

async function handleSend(req, res, body) {
  const asked = String(body.instance || body.session || req.get('x-instance') || req.get('x-session') || '').toLowerCase();
  let id;
  if (req.auth.session) {                       // clave de un número: solo ese
    id = req.auth.session;
    if (asked && asked !== id) return res.status(403).json({ ok: false, error: 'Esa clave no pertenece a esa instancia.' });
  } else if (req.auth.client) {                 // sistema conectado: elige entre las que tiene permitidas
    const allowed = clients[req.auth.client].instances;
    if (asked) id = asked;
    else if (allowed.length === 1 && allowed[0] !== '*') id = allowed[0];
    else return res.status(400).json({ ok: false, error: 'Indica la instancia en el campo "instance". Consulta GET /instances para ver las disponibles.' });
    if (!canUse(req.auth, id)) return res.status(403).json({ ok: false, error: `Este sistema no tiene permiso para usar la instancia «${id}».` });
  } else {
    id = asked || 'default';                    // administrador (SECRET general)
  }
  const s = sessions.get(id);
  if (!s) return res.status(404).json({ ok: false, error: `El número «${id}» no existe.` });

  const notLinked = () => res.status(503).json({
    ok: false,
    error: `El WhatsApp «${id}» no está vinculado (estado: ${s.state}). Escanea su QR en el panel de números.`,
  });

  if (body.event === 'ping') {
    return (await waitConnected(s)) ? res.json({ ok: true, session: id, state: s.state, me: s.me }) : notLinked();
  }
  if (body.event !== 'invoice.send') {
    return res.status(400).json({ ok: false, error: 'Evento no soportado.' });
  }
  if (!(await waitConnected(s))) return notLinked();

  // Evita enviar dos veces el mismo evento si quien llama reintenta
  const evKey = body.event_id ? id + ':' + body.event_id : null;
  if (evKey) {
    if (recent.has(evKey)) return res.json({ ok: true, duplicate: true });
    recent.add(evKey);
    if (recent.size > 1000) recent.delete(recent.values().next().value);
  }

  try {
    const r = await enqueue(s, () => sendMessage(s, body));
    res.json({ ok: true, session: id, ...r });
  } catch (e) {
    if (evKey) recent.delete(evKey);
    console.error(`[${id}] Error enviando:`, e.message);
    res.status(e.status || 500).json({ ok: false, error: e.message || 'Error al enviar.' });
  }
}

app.post('/webhook', (req, res) => handleSend(req, res, req.body || {}));

/* Endpoint simple para otros sistemas: { phone, message, pdf?, session?, event_id? } */
app.post('/send', (req, res) => {
  const b = req.body || {};
  handleSend(req, res, {
    event: 'invoice.send',
    session: b.instance || b.session,
    event_id: b.event_id,
    message: b.message,
    pdf: b.pdf,
    client: { phone: b.phone },
  });
});

app.listen(PORT, HOST, () => console.log(`Servicio WhatsApp escuchando en http://${HOST}:${PORT}`));
for (const id of Object.keys(registry)) createSession(id);
