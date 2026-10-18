import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} from '@whiskeysockets/baileys';

/* ------------------------------------------------------------ Config */
const SECRET    = (process.env.SECRET || '').trim();
const HOST      = process.env.HOST || '127.0.0.1';
const PORT      = parseInt(process.env.PORT || '3000', 10);
const AUTH_DIR  = process.env.AUTH_DIR || './auth';
const MIN_DELAY = Math.max(0, parseFloat(process.env.MIN_DELAY || '3'));
const MAX_DELAY = Math.max(MIN_DELAY, parseFloat(process.env.MAX_DELAY || '8'));

if (SECRET.length < 12) {
  console.error('Falta SECRET en .env (mínimo 12 caracteres). Debe coincidir con la clave secreta del sistema.');
  process.exit(1);
}

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

/* ------------------------------------------------------------ WhatsApp */
let sock = null;
let state = 'starting';      // starting | qr | connected | reconnecting | logged_out
let qrDataUrl = null;
let me = null;
let starting = false;

async function start() {
  if (starting) return;
  starting = true;
  try {
    const { state: auth, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    let version;
    try { ({ version } = await fetchLatestBaileysVersion()); } catch { /* usa la versión por defecto */ }

    sock = makeWASocket({
      ...(version ? { version } : {}),
      auth,
      logger,
      browser: Browsers.ubuntu('Facturas'),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (u) => {
      const { connection, lastDisconnect, qr } = u;

      if (qr) {
        state = 'qr';
        try { qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 }); } catch { qrDataUrl = null; }
      }

      if (connection === 'open') {
        state = 'connected';
        qrDataUrl = null;
        me = sock.user ? String(sock.user.id).split(':')[0].split('@')[0] : null;
        console.log('WhatsApp conectado:', me);
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        me = null;
        qrDataUrl = null;
        starting = false;
        if (code === DisconnectReason.loggedOut) {
          // Se cerró la sesión desde el celular: borrar credenciales y pedir QR nuevo
          state = 'logged_out';
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          setTimeout(start, 1500);
        } else {
          state = 'reconnecting';
          setTimeout(start, 3000);
        }
      }
    });
  } catch (e) {
    console.error('Error iniciando WhatsApp:', e);
    state = 'reconnecting';
    setTimeout(start, 5000);
  } finally {
    starting = false;
  }
}

/* Cola: un mensaje a la vez, con pausa aleatoria entre envíos */
let queue = Promise.resolve();
let lastSentAt = 0;
function enqueue(task) {
  const run = queue.then(async () => {
    const wait = lastSentAt + rand(MIN_DELAY, MAX_DELAY) * 1000 - Date.now();
    if (wait > 0) await sleep(wait);
    try { return await task(); } finally { lastSentAt = Date.now(); }
  });
  queue = run.catch(() => {});
  return run;
}

async function sendInvoice(p) {
  const phone = String(p?.client?.phone || '').replace(/\D+/g, '');
  if (phone.length < 10) throw httpError(422, 'Teléfono inválido.');

  const [found] = (await sock.onWhatsApp(phone)) || [];
  if (!found?.exists) throw httpError(422, 'Ese número no tiene WhatsApp.');
  const jid = found.jid;

  const text = String(p.message || '').slice(0, 1000);

  let buffer = null;
  const pdf = p.pdf || {};
  if (pdf.base64) {
    buffer = Buffer.from(pdf.base64, 'base64');
  } else if (pdf.url) {
    const r = await fetch(pdf.url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw httpError(502, `No se pudo descargar el PDF (HTTP ${r.status}).`);
    buffer = Buffer.from(await r.arrayBuffer());
  }

  await sock.sendPresenceUpdate('composing', jid);
  await sleep(rand(800, 2000));

  if (buffer && buffer.length > 0) {
    await sock.sendMessage(jid, {
      document: buffer,
      mimetype: 'application/pdf',
      fileName: pdf.filename || 'factura.pdf',
      caption: text,
    });
  } else {
    await sock.sendMessage(jid, { text });
  }
  await sock.sendPresenceUpdate('paused', jid);
  return { to: phone, with_pdf: !!buffer };
}

/* ------------------------------------------------------------ HTTP */
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function safeEq(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

/* Acepta X-Webhook-Secret o X-Signature: sha256=HMAC(cuerpo) (lo que ya envía el sistema) */
function authorized(req) {
  const hs = req.get('x-webhook-secret');
  if (hs && safeEq(hs, SECRET)) return true;
  const sig = req.get('x-signature');
  if (sig && req.rawBody) {
    const expect = 'sha256=' + crypto.createHmac('sha256', SECRET).update(req.rawBody).digest('hex');
    return safeEq(sig, expect);
  }
  return false;
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({
  limit: '20mb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use((req, res, next) => {
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'No autorizado.' });
  next();
});

app.get('/status', (_req, res) => {
  res.json({ ok: true, state, qr: qrDataUrl, me });
});

app.post('/logout', async (_req, res) => {
  try { await sock?.logout(); } catch { /* ya estaba cerrada */ }
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  state = 'logged_out';
  qrDataUrl = null;
  me = null;
  try { sock?.end(undefined); } catch {}
  starting = false;
  setTimeout(start, 1000);
  res.json({ ok: true });
});

/* En hosting que apaga el proceso por inactividad, al llegar una petición el servicio
   despierta y WhatsApp tarda unos segundos en reconectar: esperamos un poco antes de fallar. */
async function waitConnected(maxMs = 18000) {
  const t0 = Date.now();
  while (state !== 'connected' && state !== 'qr' && state !== 'logged_out' && Date.now() - t0 < maxMs) {
    await sleep(500);
  }
  return state === 'connected';
}

const recent = new Set();
app.post('/webhook', async (req, res) => {
  const body = req.body || {};

  if (body.event === 'ping') {
    if (await waitConnected()) return res.json({ ok: true, state, me });
    return res.status(503).json({ ok: false, error: 'WhatsApp no está vinculado (estado: ' + state + '). Escanea el QR en Integraciones.' });
  }

  if (body.event !== 'invoice.send') {
    return res.status(400).json({ ok: false, error: 'Evento no soportado.' });
  }
  if (!(await waitConnected())) {
    return res.status(503).json({ ok: false, error: 'WhatsApp no está vinculado (estado: ' + state + '). Escanea el QR en Integraciones.' });
  }

  // Evita enviar dos veces el mismo evento si el sistema reintenta
  if (body.event_id) {
    if (recent.has(body.event_id)) return res.json({ ok: true, duplicate: true });
    recent.add(body.event_id);
    if (recent.size > 500) recent.delete(recent.values().next().value);
  }

  try {
    const r = await enqueue(() => sendInvoice(body));
    res.json({ ok: true, ...r });
  } catch (e) {
    if (body.event_id) recent.delete(body.event_id);
    console.error('Error enviando:', e.message);
    res.status(e.status || 500).json({ ok: false, error: e.message || 'Error al enviar.' });
  }
});

app.listen(PORT, HOST, () => console.log(`Servicio WhatsApp escuchando en http://${HOST}:${PORT}`));
start();
