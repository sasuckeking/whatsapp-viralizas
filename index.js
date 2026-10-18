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
  }
  return null;
}

const canUse = (auth, id) => auth.admin || auth.session === id;

/* ------------------------------------------------------------ HTTP */
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '20mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

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
  res.json({ ok: true });
});

function statusOf(req, res, id) {
  const s = sessions.get(id);
  if (!s) return res.status(404).json({ ok: false, error: 'Número no encontrado.' });
  if (!canUse(req.auth, id)) return res.status(403).json({ ok: false, error: 'Esa clave no pertenece a este número.' });
  return res.json({ ok: true, ...view(s), qr: s.qr });
}
async function logoutOf(req, res, id) {
  const s = sessions.get(id);
  if (!s) return res.status(404).json({ ok: false, error: 'Número no encontrado.' });
  if (!canUse(req.auth, id)) return res.status(403).json({ ok: false, error: 'Esa clave no pertenece a este número.' });
  await logoutSession(s);
  res.json({ ok: true });
}
app.get('/sessions/:id/status', (req, res) => statusOf(req, res, req.params.id));
app.post('/sessions/:id/logout', (req, res) => logoutOf(req, res, req.params.id));
// Compatibilidad con la versión de un solo número
app.get('/status', (req, res) => statusOf(req, res, 'default'));
app.post('/logout', (req, res) => logoutOf(req, res, 'default'));

/* --- Envío --- */
const recent = new Set();

async function handleSend(req, res, body) {
  const id = String(req.auth.session || body.session || req.get('x-session') || 'default').toLowerCase();
  if (req.auth.session && body.session && String(body.session).toLowerCase() !== req.auth.session) {
    return res.status(403).json({ ok: false, error: 'Esa clave no pertenece a ese número.' });
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
    session: b.session,
    event_id: b.event_id,
    message: b.message,
    pdf: b.pdf,
    client: { phone: b.phone },
  });
});

app.listen(PORT, HOST, () => console.log(`Servicio WhatsApp escuchando en http://${HOST}:${PORT}`));
for (const id of Object.keys(registry)) createSession(id);
