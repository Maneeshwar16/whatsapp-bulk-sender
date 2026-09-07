try { require('./patch-wwebjs'); } catch (_) {}

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const multer = require('multer');
const qrcode = require('qrcode');
const { parse } = require('csv-parse/sync');
const path = require('path');
const fs = require('fs');

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

const authDataPath = process.env.DATA_PATH || './.wwebjs_auth/';
if (!fs.existsSync(authDataPath)) fs.mkdirSync(authDataPath, { recursive: true });

// Auto-migrate legacy single-session folder if present
const legacySessionDir = path.join(authDataPath, 'session');
const defaultSessionDir = path.join(authDataPath, 'session-default');
if (fs.existsSync(legacySessionDir) && !fs.existsSync(defaultSessionDir)) {
  try {
    fs.renameSync(legacySessionDir, defaultSessionDir);
    console.log('📦 Migrated legacy single-session directory to session-default.');
  } catch (e) {
    console.warn('Migration note:', e.message);
  }
}

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

// ─── WhatsApp Multi-Session Manager ─────────────────────────────────────────

const puppeteerExecutablePath =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  (fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' :
   fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);

// sessions: Map<sessionId, SessionData>
const sessions = new Map();

function createSession(id, name) {
  if (sessions.has(id)) {
    return sessions.get(id);
  }

  console.log(`🚀 [${id}] Initializing WhatsApp session ("${name}")...`);

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: id,
      dataPath: authDataPath,
    }),
    puppeteer: {
      headless: true,
      executablePath: puppeteerExecutablePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-default-apps',
        '--mute-audio',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-breakpad',
        '--disable-component-extensions-with-background-pages',
        '--disable-features=TranslateUI,BlinkGenPropertyTrees',
        '--disable-ipc-flooding-protection',
        '--disable-renderer-backgrounding',
        '--force-color-profile=srgb',
        '--metrics-recording-only',
        '--js-flags=--max-old-space-size=256',
      ],
    },
  });

  const session = {
    id,
    name: name || id,
    client,
    ready: false,
    qrCodeDataUrl: null,
    pairingCode: null,
    isSending: false,
    cachedContacts: null,
    createdAt: Date.now(),
  };

  sessions.set(id, session);

  client.on('qr', async (qr) => {
    console.log(`[${id}] QR code received — scan it with your phone.`);
    session.qrCodeDataUrl = await qrcode.toDataURL(qr);
    io.to(id).emit('qr', session.qrCodeDataUrl);
  });

  client.on('code_received', (code) => {
    console.log(`[${id}] 🔑 Pairing code received:`, code);
    session.pairingCode = code;
    io.to(id).emit('pairing_code', code);
  });

  client.on('ready', async () => {
    session.ready = true;
    session.qrCodeDataUrl = null;
    session.pairingCode = null;
    console.log(`[${id}] ✅ WhatsApp client is ready!`);
    io.to(id).emit('ready');
  });

  client.on('authenticated', () => {
    console.log(`[${id}] 🔐 Authenticated successfully.`);
  });

  client.on('auth_failure', (msg) => {
    console.error(`[${id}] ❌ Authentication failure:`, msg);
    io.to(id).emit('auth_failure', msg);
  });

  client.on('disconnected', (reason) => {
    session.ready = false;
    session.cachedContacts = null;
    console.log(`[${id}] 🔌 Disconnected:`, reason);
    io.to(id).emit('disconnected', reason);
    client.initialize().catch(() => {});
  });

  client.initialize().catch((err) => {
    console.error(`[${id}] Initialization error:`, err);
  });

  return session;
}

// Startup: initialize all known sessions from manifest
const initialManifest = loadSessionsManifest();
for (const item of initialManifest) {
  createSession(item.id, item.name);
}

// ─── Helper Functions ───────────────────────────────────────────────────────

function cleanNumber(raw) {
  if (!raw) return '';
  return String(raw).replace(/[^\d]/g, '');
}

function randomDelay(minMs = 1000, maxMs = 2000) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchContactsData(session) {
  if (!session || !session.ready || !session.client?.pupPage) {
    return { recent: [], contacts: [] };
  }

  try {
    const data = await session.client.pupPage.evaluate(async () => {
      const result = { recent: [], contacts: [] };
      const safeStr = (v) => (typeof v === 'string' ? v.trim() : '');

      const getCollections = () => {
        try {
          return window.require('WAWebCollections');
        } catch {
          return null;
        }
      };

      let collections = getCollections();
      if (!collections) {
        await new Promise((res) => setTimeout(res, 1000));
        collections = getCollections();
      }

      if (!collections) return result;

      // 1. Extract 1-on-1 Chats (Recent)
      try {
        const ChatCollection = collections.Chat;
        if (ChatCollection && typeof ChatCollection.getModelsArray === 'function') {
          const chats = ChatCollection.getModelsArray();

          for (const chat of chats) {
            try {
              if (!chat || !chat.id) continue;
              const serialized = safeStr(chat.id._serialized);

              // Skip groups (@g.us), broadcasts (@broadcast), and newsletters (@newsletter)
              if (!serialized.endsWith('@c.us')) continue;

              const number = safeStr(chat.id.user);
              const name =
                safeStr(chat.name) ||
                safeStr(chat.formattedTitle) ||
                safeStr(chat.__x_formattedTitle) ||
                safeStr(chat.contact?.name) ||
                safeStr(chat.contact?.pushname) ||
                safeStr(chat.contact?.verifiedName) ||
                number;

              const timestamp = chat.t || chat.timestamp || chat.__x_t || 0;
              const unreadCount = chat.unreadCount || chat.__x_unreadCount || 0;

              result.recent.push({
                id: serialized,
                number: number,
                name: name || number,
                timestamp: Number(timestamp) || 0,
                unreadCount: Number(unreadCount) || 0,
              });
            } catch {
              // skip single malformed chat
            }
          }
        }
      } catch (chatErr) {
        console.warn('Error reading Chat collection:', chatErr);
      }

      // 2. Extract Contacts (Saved Contacts only)
      try {
        const ContactCollection = collections.Contact;
        if (ContactCollection && typeof ContactCollection.getModelsArray === 'function') {
          const contacts = ContactCollection.getModelsArray();
          const seen = new Set();

          let getIsMyContactFn = null;
          try {
            const getters = window.require('WAWebFrontendContactGetters');
            if (getters && typeof getters.getIsMyContact === 'function') {
              getIsMyContactFn = getters.getIsMyContact;
            }
          } catch {}

          let contactGetters = null;
          try {
            contactGetters = window.require('WAWebContactGetters');
          } catch {}

          for (const c of contacts) {
            try {
              if (!c || !c.id) continue;
              const serialized = safeStr(c.id._serialized);

              const isUser = serialized.endsWith('@c.us');
              if (!isUser && !c.phoneNumber) continue;

              const number =
                safeStr(c.number) ||
                safeStr(c.id.user) ||
                safeStr(c.phoneNumber?._serialized ? c.phoneNumber.user : '');

              if (!number) continue;

              // Determine if this is an address book / saved contact
              let isSaved = false;
              if (getIsMyContactFn) {
                try { isSaved = Boolean(getIsMyContactFn(c)); } catch {}
              }
              if (!isSaved) {
                isSaved = Boolean(c.isMyContact || c.__x_isMyContact || c.isAddressBookContact);
              }

              // STRICT FILTER: If not a saved contact in your phonebook, skip it!
              if (!isSaved) continue;

              const effectiveId = isUser ? serialized : `${number}@c.us`;
              if (seen.has(effectiveId)) continue;
              seen.add(effectiveId);

              let savedName = '';
              if (contactGetters && typeof contactGetters.getName === 'function') {
                try { savedName = safeStr(contactGetters.getName(c)); } catch {}
              }
              if (!savedName) {
                savedName = safeStr(c.name) || safeStr(c.__x_name);
              }

              const pushname = safeStr(c.pushname) || safeStr(c.__x_pushname);
              const displayName = savedName || pushname || number;

              result.contacts.push({
                id: effectiveId,
                number: number,
                name: displayName,
                isMyContact: true,
              });
            } catch {
              // skip single malformed contact
            }
          }
        }
      } catch (contactErr) {
        console.warn('Error reading Contact collection:', contactErr);
      }

      return result;
    });

    const recent = data.recent || [];
    const contactList = data.contacts || [];

    // Sort recent chats by latest message timestamp descending
    recent.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    // Map recent status
    const recentIds = new Set(recent.map((r) => r.id));
    for (const c of contactList) {
      c.isRecent = recentIds.has(c.id);
    }

    // Sort all contacts alphabetically by name
    contactList.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    console.log(`[${session.id}] ✅ Loaded ${recent.length} recent chats and ${contactList.length} contacts.`);
    session.cachedContacts = { recent, contacts: contactList };
    if (global.gc) {
      try { global.gc(); } catch (_) {}
    }
    return session.cachedContacts;
  } catch (err) {
    console.error(`[${session.id}] Failed to retrieve contacts:`, err);
    return { recent: [], contacts: [] };
  }
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
app.post('/api/sessions', (req, res) => {
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

  const session = createSession(id, cleanName);

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
      if (session.client) {
        await session.client.logout().catch(() => {});
        await session.client.destroy().catch(() => {});
      }
    } catch (destroyErr) {
      console.warn(`[${id}] Error during client cleanup:`, destroyErr.message);
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

// Connection status for a session
app.get('/api/status', (req, res) => {
  const sessionId = req.query.sessionId || 'default';
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found', ready: false });
  }

  res.json({
    ready: session.ready,
    sending: session.isSending,
    qr: session.qrCodeDataUrl,
    sessionId: session.id,
    name: session.name,
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

  const clean = String(phone).replace(/\D/g, '');
  if (clean.length < 8) {
    return res.status(400).json({ error: 'Please enter a valid phone number with country code (e.g. 919876543210).' });
  }

  if (session.ready) {
    return res.status(400).json({ error: 'WhatsApp is already connected for this account!' });
  }

  try {
    console.log(`[${sessionId}] 📱 Requesting pairing code for: ${clean}`);
    const code = await session.client.requestPairingCode(clean);
    console.log(`[${sessionId}] 🔑 Pairing code generated: ${code}`);
    session.pairingCode = code;
    io.to(sessionId).emit('pairing_code', code);
    res.json({ success: true, code });
  } catch (err) {
    console.error(`[${sessionId}] Pairing code request failed:`, err);
    res.status(500).json({ error: err.message || 'Failed to request pairing code. Make sure QR code is visible.' });
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
    session.cachedContacts = null;
    session.qrCodeDataUrl = null;
    session.pairingCode = null;
    io.to(sessionId).emit('loading');

    try {
      await session.client.logout();
    } catch (logoutErr) {
      console.warn(`[${sessionId}] Logout warning:`, logoutErr.message);
    }

    console.log(`[${sessionId}] 🔄 Re-initializing WhatsApp client...`);
    session.client.initialize().catch((initErr) => {
      console.warn(`[${sessionId}] Re-initialization note:`, initErr.message);
    });

    res.json({ success: true, message: 'Logged out successfully.' });
  } catch (err) {
    console.error(`[${sessionId}] Logout failed:`, err);
    res.status(500).json({ error: 'Logout failed: ' + err.message });
  }
});

// Fetch contacts and recent chats for a session
app.get('/api/contacts', async (req, res) => {
  const sessionId = req.query.sessionId || 'default';
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found.' });
  }

  if (!session.ready) {
    return res.status(400).json({ error: 'WhatsApp is not connected for this account. Please scan the QR code first.' });
  }

  const forceRefresh = req.query.refresh === 'true';
  if (session.cachedContacts && !forceRefresh) {
    return res.json(session.cachedContacts);
  }

  try {
    const data = await fetchContactsData(session);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch contacts: ' + err.message });
  }
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
        id: `${cleanNumber(num)}@c.us`,
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

  // Respond immediately — progress updates sent via WebSocket to room
  res.json({ status: 'started', total: recipients.length });

  // ── Background send loop ──────────────────────────────────────────────
  let sentCount = 0;
  let failedCount = 0;

  for (let i = 0; i < recipients.length; i++) {
    const item = recipients[i];
    let chatId = '';
    let displayName = '';
    let displayNum = '';

    if (typeof item === 'object') {
      displayName = item.name || item.number || 'Contact';
      displayNum = item.number || cleanNumber(item.id);
      chatId = item.id && item.id.includes('@c.us')
        ? item.id
        : `${cleanNumber(displayNum)}@c.us`;
    } else {
      const rawNum = cleanNumber(String(item));
      displayName = rawNum;
      displayNum = rawNum;
      chatId = `${rawNum}@c.us`;
    }

    try {
      if (uploadedFiles.length > 0) {
        for (let j = 0; j < uploadedFiles.length; j++) {
          const file = uploadedFiles[j];
          const media = MessageMedia.fromFilePath(file.path);
          media.filename = file.originalname;

          const isImage = file.mimetype && file.mimetype.startsWith('image/');
          const opts = {
            sendMediaAsDocument: !isImage,
          };
          if (j === 0 && message) {
            opts.caption = message;
          }
          await session.client.sendMessage(chatId, media, opts);
        }
      } else if (message) {
        await session.client.sendMessage(chatId, message);
      }

      sentCount++;
      io.to(sessionId).emit('progress', {
        id: chatId,
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
        id: chatId,
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

    // Delay between sends (1–2s maximum for safe & fast delivery)
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
  console.log(`\n🚀 Multi-Session WhatsApp Server running at http://localhost:${PORT}`);
  console.log(`📱 Phone app connect URL: http://192.168.0.112:${PORT}`);
  console.log(`👥 Active accounts: ${Array.from(sessions.keys()).join(', ')}\n`);
});
