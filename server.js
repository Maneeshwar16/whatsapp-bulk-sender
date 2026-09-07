import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import multer from 'multer';
import qrcode from 'qrcode';
import { parse } from 'csv-parse/sync';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Express + Socket.IO Setup ───────────────────────────────────────────────

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'DELETE'],
  },
});

app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (_req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Multer (file uploads) ──────────────────────────────────────────────────

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({
  storage,
  limits: { fileSize: 64 * 1024 * 1024 }, // 64 MB per file
});

// ─── Sessions Manifest & Auth Storage ───────────────────────────────────────

const authDataPath = process.env.DATA_PATH || path.join(__dirname, '.baileys_auth');
if (!fs.existsSync(authDataPath)) fs.mkdirSync(authDataPath, { recursive: true });

const SESSIONS_MANIFEST_FILE = path.join(__dirname, 'sessions.json');

function loadSessionsManifest() {
  try {
    if (fs.existsSync(SESSIONS_MANIFEST_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSIONS_MANIFEST_FILE, 'utf-8'));
      if (Array.isArray(data) && data.length > 0) return data;
    }
  } catch (e) {
    console.error('Failed reading sessions manifest:', e);
  }
  return [{ id: 'default', name: 'Primary Account' }];
}

function saveSessionsManifest(list) {
  try {
    fs.writeFileSync(SESSIONS_MANIFEST_FILE, JSON.stringify(list, null, 2), 'utf-8');
  } catch (e) {
    console.error('Failed saving sessions manifest:', e);
  }
}

// ─── WhatsApp Baileys Multi-Session Manager ─────────────────────────────────

const sessions = new Map();
let engineRunning = true;

async function createSession(id, name) {
  if (sessions.has(id)) {
    return sessions.get(id);
  }

  console.log(`🚀 [${id}] Initializing Baileys WhatsApp session ("${name}")...`);

  const sessionDir = path.join(authDataPath, `session-${id}`);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: Browsers.macOS('Desktop'),
    syncFullHistory: false,
    markOnlineOnConnect: true,
    generateHighQualityLinkPreview: false,
  });

  const session = {
    id,
    name: name || id,
    sock,
    ready: false,
    qrCodeDataUrl: null,
    pairingCode: null,
    isSending: false,
    contactsMap: new Map(), // jid -> { id, name, notify, verifiedName, isSaved }
    chatsMap: new Map(),    // jid -> { id, name, timestamp, unreadCount }
    createdAt: Date.now(),
  };

  sessions.set(id, session);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log(`[${id}] 📷 QR code received — ready for scan.`);
      session.qrCodeDataUrl = await qrcode.toDataURL(qr);
      io.to(id).emit('qr', session.qrCodeDataUrl);
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode
        : (lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      session.ready = false;
      session.qrCodeDataUrl = null;
      console.log(`[${id}] 🔌 Disconnected (status: ${statusCode}). Reconnect: ${shouldReconnect}`);
      io.to(id).emit('disconnected', statusCode);

      if (shouldReconnect && engineRunning) {
        sessions.delete(id);
        createSession(id, name).catch((err) => console.error(`[${id}] Reconnect error:`, err));
      }
    } else if (connection === 'open') {
      session.ready = true;
      session.qrCodeDataUrl = null;
      session.pairingCode = null;
      console.log(`[${id}] ✅ Baileys WhatsApp client is connected and ready! (RAM: ~40MB)`);
      io.to(id).emit('ready');
    }
  });

  // Track contacts
  sock.ev.on('contacts.upsert', (contacts) => {
    for (const c of contacts) {
      if (!c.id) continue;
      const existing = session.contactsMap.get(c.id) || {};
      session.contactsMap.set(c.id, {
        id: c.id,
        name: c.name || existing.name || '',
        notify: c.notify || existing.notify || '',
        verifiedName: c.verifiedName || existing.verifiedName || '',
        isSaved: Boolean(c.name || existing.name),
      });
    }
  });

  sock.ev.on('contacts.update', (updates) => {
    for (const u of updates) {
      if (!u.id) continue;
      const existing = session.contactsMap.get(u.id) || {};
      session.contactsMap.set(u.id, {
        ...existing,
        ...u,
        isSaved: Boolean(u.name || existing.name),
      });
    }
  });

  // Track chats
  sock.ev.on('chats.upsert', (chats) => {
    for (const ch of chats) {
      if (!ch.id || !ch.id.endsWith('@s.whatsapp.net')) continue;
      session.chatsMap.set(ch.id, {
        id: ch.id,
        name: ch.name || '',
        timestamp: Number(ch.conversationTimestamp || 0) * 1000,
        unreadCount: Number(ch.unreadCount || 0),
      });
    }
  });

  sock.ev.on('chats.update', (updates) => {
    for (const u of updates) {
      if (!u.id || !u.id.endsWith('@s.whatsapp.net')) continue;
      const existing = session.chatsMap.get(u.id) || {};
      session.chatsMap.set(u.id, {
        ...existing,
        ...u,
        timestamp: u.conversationTimestamp ? Number(u.conversationTimestamp) * 1000 : existing.timestamp,
      });
    }
  });

  // History sync
  sock.ev.on('messaging-history.set', ({ chats, contacts }) => {
    if (contacts) {
      for (const c of contacts) {
        if (!c.id) continue;
        session.contactsMap.set(c.id, {
          id: c.id,
          name: c.name || '',
          notify: c.notify || '',
          verifiedName: c.verifiedName || '',
          isSaved: Boolean(c.name),
        });
      }
    }
    if (chats) {
      for (const ch of chats) {
        if (!ch.id || !ch.id.endsWith('@s.whatsapp.net')) continue;
        session.chatsMap.set(ch.id, {
          id: ch.id,
          name: ch.name || '',
          timestamp: Number(ch.conversationTimestamp || 0) * 1000,
          unreadCount: Number(ch.unreadCount || 0),
        });
      }
    }
  });

  return session;
}

// WhatsApp Engine On-Demand Controls (Sleep / Wake)
async function stopEngine() {
  engineRunning = false;
  console.log('🛑 Putting WhatsApp engine to sleep (freeing memory to ~20MB)...');
  for (const [id, session] of sessions.entries()) {
    try {
      if (session.sock) {
        session.sock.end(undefined);
      }
    } catch (_) {}
    session.ready = false;
    session.qrCodeDataUrl = null;
  }
  sessions.clear();
  if (global.gc) {
    try { global.gc(); } catch (_) {}
  }
  io.emit('engine_state', { running: false });
}

async function startEngine(sessionId = 'default') {
  engineRunning = true;
  console.log(`⚡ Starting WhatsApp engine on demand for: "${sessionId}"...`);
  const manifest = loadSessionsManifest();
  const target = manifest.find((m) => m.id === sessionId) || manifest[0] || { id: 'default', name: 'Primary Account' };
  const session = await createSession(target.id, target.name);
  io.emit('engine_state', { running: true });
  return session;
}

// Initial startup
const initialManifest = loadSessionsManifest();
if (initialManifest.length > 0) {
  createSession(initialManifest[0].id, initialManifest[0].name).catch(console.error);
}

// ─── Helper Functions ───────────────────────────────────────────────────────

function cleanNumber(raw) {
  if (!raw) return '';
  return String(raw).replace(/[^\d]/g, '');
}

function toJid(raw) {
  const num = cleanNumber(raw);
  return num ? `${num}@s.whatsapp.net` : '';
}

function randomDelay(minMs = 1000, maxMs = 2000) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getContactsData(session) {
  if (!session) return { recent: [], contacts: [] };

  const recent = [];
  const contacts = [];
  const seenNumbers = new Set();

  // 1. Process recent chats (1-on-1 chats only)
  for (const [jid, ch] of session.chatsMap.entries()) {
    if (!jid.endsWith('@s.whatsapp.net')) continue;
    const num = jid.split('@')[0];
    const contactInfo = session.contactsMap.get(jid);
    const displayName = ch.name || contactInfo?.name || contactInfo?.notify || contactInfo?.verifiedName || num;

    recent.push({
      id: jid,
      number: num,
      name: displayName,
      timestamp: ch.timestamp || 0,
      unreadCount: ch.unreadCount || 0,
    });
  }
  recent.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  // 2. Process contacts
  for (const [jid, c] of session.contactsMap.entries()) {
    if (!jid.endsWith('@s.whatsapp.net')) continue;
    const num = jid.split('@')[0];
    if (seenNumbers.has(num)) continue;
    seenNumbers.add(num);

    const displayName = c.name || c.notify || c.verifiedName || num;
    contacts.push({
      id: jid,
      number: num,
      name: displayName,
      isMyContact: Boolean(c.isSaved || c.name),
    });
  }

  // 3. Fallback: Include recent chat participants in contacts if missing
  for (const r of recent) {
    if (!seenNumbers.has(r.number)) {
      seenNumbers.add(r.number);
      contacts.push({
        id: r.id,
        number: r.number,
        name: r.name,
        isMyContact: false,
      });
    }
  }

  const recentJids = new Set(recent.map((r) => r.id));
  for (const c of contacts) {
    c.isRecent = recentJids.has(c.id);
  }

  contacts.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  return { recent, contacts };
}

// ─── API Routes ─────────────────────────────────────────────────────────────

// List all registered accounts/sessions
app.get('/api/sessions', (_req, res) => {
  const manifest = loadSessionsManifest();
  const list = manifest.map((item) => {
    const sess = sessions.get(item.id);
    return {
      id: item.id,
      name: item.name,
      ready: Boolean(sess?.ready),
      sending: Boolean(sess?.isSending),
      hasQr: Boolean(sess?.qrCodeDataUrl),
    };
  });
  res.json({ sessions: list });
});

// Create a new account session
app.post('/api/sessions', async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Account name is required.' });
  }

  const cleanName = name.trim();
  const slug = cleanName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 16);
  const id = `${slug || 'account'}-${Date.now().toString(36)}`;

  const manifest = loadSessionsManifest();
  manifest.push({ id, name: cleanName });
  saveSessionsManifest(manifest);

  const session = await createSession(id, cleanName);

  res.json({
    success: true,
    session: {
      id: session.id,
      name: session.name,
      ready: session.ready,
      sending: session.isSending,
      hasQr: Boolean(session.qrCodeDataUrl),
    },
  });
});

// Delete an account session
app.delete('/api/sessions/:id', async (req, res) => {
  const { id } = req.params;
  const manifest = loadSessionsManifest();

  if (manifest.length <= 1) {
    return res.status(400).json({ error: 'Cannot delete the only remaining account.' });
  }

  const sessionIndex = manifest.findIndex((m) => m.id === id);
  if (sessionIndex === -1) {
    return res.status(404).json({ error: 'Account not found.' });
  }

  const session = sessions.get(id);
  if (session) {
    try {
      if (session.sock) {
        await session.sock.logout().catch(() => {});
        session.sock.end(undefined);
      }
    } catch (destroyErr) {
      console.warn(`[${id}] Error during cleanup:`, destroyErr.message);
    }
    sessions.delete(id);
  }

  // Remove local auth folder
  const sessDir = path.join(authDataPath, `session-${id}`);
  if (fs.existsSync(sessDir)) {
    try {
      fs.rmSync(sessDir, { recursive: true, force: true });
    } catch (rmErr) {
      console.warn(`[${id}] Error removing auth directory:`, rmErr.message);
    }
  }

  manifest.splice(sessionIndex, 1);
  saveSessionsManifest(manifest);

  res.json({ success: true, message: `Account "${id}" removed.` });
});

// WhatsApp Engine Power Management (Sleep / Wake On-Demand)
app.get('/api/engine/status', (_req, res) => {
  res.json({ running: engineRunning, activeSessions: sessions.size });
});

app.post('/api/engine/start', async (req, res) => {
  const { sessionId = 'default' } = req.body || {};
  try {
    const session = await startEngine(sessionId);
    res.json({ success: true, running: true, sessionId: session.id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to start engine: ' + err.message });
  }
});

app.post('/api/engine/stop', async (_req, res) => {
  try {
    await stopEngine();
    res.json({ success: true, running: false, message: 'WhatsApp engine sleeping.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to stop engine: ' + err.message });
  }
});

// Connection status for a session
app.get('/api/status', (req, res) => {
  if (!engineRunning || sessions.size === 0) {
    return res.json({ ready: false, engineRunning: false, sending: false });
  }

  const sessionId = req.query.sessionId || 'default';
  const session = sessions.get(sessionId);

  if (!session) {
    return res.json({ error: 'Session not found', ready: false, engineRunning: true });
  }

  res.json({
    ready: session.ready,
    sending: session.isSending,
    qr: session.qrCodeDataUrl,
    sessionId: session.id,
    name: session.name,
    engineRunning: true,
  });
});

// Request WhatsApp pairing code (link with phone number)
app.post('/api/pairing-code', async (req, res) => {
  const { sessionId = 'default', phone } = req.body || {};
  if (!phone) {
    return res.status(400).json({ error: 'Phone number is required.' });
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Account session not found.' });
  }

  const clean = cleanNumber(phone);
  if (clean.length < 8) {
    return res.status(400).json({ error: 'Please enter a valid phone number with country code (e.g. 919876543210).' });
  }

  if (session.ready) {
    return res.status(400).json({ error: 'WhatsApp is already connected for this account!' });
  }

  try {
    console.log(`[${sessionId}] 📱 Requesting Baileys pairing code for: ${clean}`);
    const code = await session.sock.requestPairingCode(clean);
    console.log(`[${sessionId}] 🔑 Pairing code generated: ${code}`);
    session.pairingCode = code;
    io.to(sessionId).emit('pairing_code', code);
    res.json({ success: true, code });
  } catch (err) {
    console.error(`[${sessionId}] Pairing code request failed:`, err);
    res.status(500).json({ error: err.message || 'Failed to request pairing code.' });
  }
});

// Logout / unlink WhatsApp session
app.post('/api/logout', async (req, res) => {
  const { sessionId = 'default' } = req.body || {};
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Account session not found.' });
  }

  try {
    console.log(`[${sessionId}] 🚪 Logging out WhatsApp session...`);
    session.ready = false;
    session.qrCodeDataUrl = null;
    session.pairingCode = null;
    io.to(sessionId).emit('loading');

    try {
      await session.sock.logout();
    } catch (logoutErr) {
      console.warn(`[${sessionId}] Logout note:`, logoutErr.message);
    }

    // Clean auth directory for this session so a new QR is generated
    const sessDir = path.join(authDataPath, `session-${sessionId}`);
    if (fs.existsSync(sessDir)) {
      try {
        fs.rmSync(sessDir, { recursive: true, force: true });
      } catch (_) {}
    }

    sessions.delete(sessionId);
    await createSession(session.id, session.name);

    res.json({ success: true, message: 'Logged out successfully.' });
  } catch (err) {
    console.error(`[${sessionId}] Logout failed:`, err);
    res.status(500).json({ error: 'Logout failed: ' + err.message });
  }
});

// Fetch contacts and recent chats for a session
app.get('/api/contacts', (req, res) => {
  const sessionId = req.query.sessionId || 'default';
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found.' });
  }

  if (!session.ready) {
    return res.status(400).json({ error: 'WhatsApp is not connected for this account. Please scan the QR code first.' });
  }

  const data = getContactsData(session);
  res.json(data);
});

// Parse uploaded contacts file (CSV or TXT)
app.post('/api/upload-contacts', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

  try {
    const raw = fs.readFileSync(req.file.path, 'utf-8');
    let numbers = [];

    if (req.file.originalname.toLowerCase().endsWith('.csv')) {
      const records = parse(raw, {
        columns: false,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
      });
      numbers = records.flat();
    } else {
      numbers = raw.split(/\r?\n/);
    }

    numbers = numbers
      .map((n) => cleanNumber(String(n)))
      .filter((n) => n.length >= 7);

    numbers = [...new Set(numbers)];
    fs.unlinkSync(req.file.path);

    res.json({ numbers });
  } catch (err) {
    res.status(400).json({ error: 'Failed to parse contacts file: ' + err.message });
  }
});

// Send messages for a specific session
app.post('/api/send', upload.any(), async (req, res) => {
  const { sessionId = 'default', message, recipients: recipientsJson, numbers: legacyNumbersJson } = req.body;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found.' });
  }
  if (!session.ready) {
    return res.status(400).json({ error: 'WhatsApp is not connected for this account. Please scan the QR code first.' });
  }
  if (session.isSending) {
    return res.status(409).json({ error: 'A send operation is already in progress for this account. Please wait.' });
  }

  let recipients = [];

  try {
    if (recipientsJson) {
      recipients = JSON.parse(recipientsJson);
    } else if (legacyNumbersJson) {
      const rawNumbers = JSON.parse(legacyNumbersJson);
      recipients = rawNumbers.map((num) => ({
        id: toJid(num),
        name: cleanNumber(num),
        number: cleanNumber(num),
      }));
    }
  } catch {
    return res.status(400).json({ error: 'Invalid recipients data.' });
  }

  if (!recipients || recipients.length === 0) {
    return res.status(400).json({ error: 'No recipients selected.' });
  }
  if (!message && (!req.files || req.files.length === 0)) {
    return res.status(400).json({ error: 'Provide a message, attachments, or both.' });
  }

  const uploadedFiles = req.files || [];
  session.isSending = true;

  res.json({ status: 'started', total: recipients.length });

  // ── Background send loop ──────────────────────────────────────────────
  let sentCount = 0;
  let failedCount = 0;

  for (let i = 0; i < recipients.length; i++) {
    const item = recipients[i];
    let jid = '';
    let displayName = '';
    let displayNum = '';

    if (typeof item === 'object') {
      displayName = item.name || item.number || 'Contact';
      displayNum = cleanNumber(item.number || item.id);
      jid = toJid(displayNum);
    } else {
      displayNum = cleanNumber(String(item));
      displayName = displayNum;
      jid = toJid(displayNum);
    }

    try {
      if (uploadedFiles.length > 0) {
        for (let j = 0; j < uploadedFiles.length; j++) {
          const file = uploadedFiles[j];
          const fileBuffer = fs.readFileSync(file.path);
          const isImage = file.mimetype && file.mimetype.startsWith('image/');
          const isVideo = file.mimetype && file.mimetype.startsWith('video/');
          const isAudio = file.mimetype && file.mimetype.startsWith('audio/');

          const caption = (j === 0 && message) ? message : undefined;

          if (isImage) {
            await session.sock.sendMessage(jid, {
              image: fileBuffer,
              caption,
              mimetype: file.mimetype,
            });
          } else if (isVideo) {
            await session.sock.sendMessage(jid, {
              video: fileBuffer,
              caption,
              mimetype: file.mimetype,
            });
          } else if (isAudio) {
            await session.sock.sendMessage(jid, {
              audio: fileBuffer,
              mimetype: file.mimetype,
            });
          } else {
            await session.sock.sendMessage(jid, {
              document: fileBuffer,
              fileName: file.originalname,
              mimetype: file.mimetype,
              caption,
            });
          }
        }
      } else if (message) {
        await session.sock.sendMessage(jid, { text: message });
      }

      sentCount++;
      io.to(sessionId).emit('progress', {
        id: jid,
        name: displayName,
        number: displayNum,
        status: 'sent',
        index: i,
        total: recipients.length,
        sentCount,
        failedCount,
      });
      console.log(`[${sessionId}] ✅ [${i + 1}/${recipients.length}] Sent to ${displayName} (${displayNum})`);
    } catch (err) {
      failedCount++;
      io.to(sessionId).emit('progress', {
        id: jid,
        name: displayName,
        number: displayNum,
        status: 'failed',
        error: err.message,
        index: i,
        total: recipients.length,
        sentCount,
        failedCount,
      });
      console.error(`[${sessionId}] ❌ [${i + 1}/${recipients.length}] Failed for ${displayName} (${displayNum}): ${err.message}`);
    }

    // Safe delivery delay (1–2 seconds)
    if (i < recipients.length - 1) {
      await randomDelay(1000, 2000);
    }
  }

  // Clean up uploaded files
  for (const file of uploadedFiles) {
    try {
      fs.unlinkSync(file.path);
    } catch {
      /* ignore */
    }
  }

  session.isSending = false;
  io.to(sessionId).emit('complete', { sentCount, failedCount, total: recipients.length });
  console.log(`\n[${sessionId}] 🏁 Done! Sent: ${sentCount}, Failed: ${failedCount}, Total: ${recipients.length}`);
});

// ─── Socket.IO ──────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log('🌐 Client connected:', socket.id);

  socket.on('join_session', (sessionId) => {
    const sid = sessionId || 'default';
    for (const room of socket.rooms) {
      if (room !== socket.id) socket.leave(room);
    }
    socket.join(sid);
    console.log(`👤 Socket ${socket.id} joined session room: "${sid}"`);

    const session = sessions.get(sid);
    if (!session) {
      socket.emit('session_not_found', sid);
      return;
    }

    if (session.ready) {
      socket.emit('ready');
    } else if (session.qrCodeDataUrl) {
      socket.emit('qr', session.qrCodeDataUrl);
    } else {
      socket.emit('loading');
    }

    if (session.pairingCode) {
      socket.emit('pairing_code', session.pairingCode);
    }
  });

  socket.on('disconnect', () => {
    // disconnected
  });
});

// ─── Start Server ───────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Baileys Multi-Session WhatsApp Server running at http://localhost:${PORT}`);
  console.log(`⚡ Ultralight engine (No Chrome, ~40MB RAM usage)`);
  console.log(`👥 Active accounts: ${Array.from(sessions.keys()).join(', ')}\n`);
});
