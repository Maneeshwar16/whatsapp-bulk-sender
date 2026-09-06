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
    methods: ['GET', 'POST'],
  },
});

app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
  limits: { fileSize: 64 * 1024 * 1024 }, // 64 MB per file (PDF, Docs, Images)
});

// ─── WhatsApp Client ────────────────────────────────────────────────────────

let clientReady = false;
let qrCodeDataUrl = null;
let isSending = false;
let cachedContacts = null;

const authDataPath = process.env.DATA_PATH || './.wwebjs_auth/';
const puppeteerExecutablePath =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  (fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' :
   fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);

const waClient = new Client({
  authStrategy: new LocalAuth({
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
    ],
  },
});

waClient.on('qr', async (qr) => {
  console.log('QR code received — scan it with your phone.');
  qrCodeDataUrl = await qrcode.toDataURL(qr);
  io.emit('qr', qrCodeDataUrl);
});

waClient.on('ready', async () => {
  clientReady = true;
  qrCodeDataUrl = null;
  console.log('✅ WhatsApp client is ready!');
  io.emit('ready');
});

waClient.on('authenticated', () => {
  console.log('🔐 Authenticated successfully.');
});

waClient.on('auth_failure', (msg) => {
  console.error('❌ Authentication failure:', msg);
  io.emit('auth_failure', msg);
});

waClient.on('disconnected', (reason) => {
  clientReady = false;
  cachedContacts = null;
  console.log('🔌 Disconnected:', reason);
  io.emit('disconnected', reason);
  waClient.initialize().catch(() => {});
});

console.log('Initializing WhatsApp client — please wait for the QR code...');
waClient.initialize();

// ─── Helper Functions ───────────────────────────────────────────────────────

function cleanNumber(raw) {
  if (!raw) return '';
  return String(raw).replace(/[^\d]/g, '');
}

function randomDelay(minMs = 1000, maxMs = 2000) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchContactsData() {
  if (!clientReady || !waClient.pupPage) return { recent: [], contacts: [] };

  try {
    const data = await waClient.pupPage.evaluate(async () => {
      const result = { recent: [], contacts: [] };
      const safeStr = (v) => (typeof v === 'string' ? v.trim() : '');

      // Wait a moment if collections are still initializing
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

          // Obtain official WhatsApp Web getter for address book contacts
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
              // This filters out hundreds of random participants from group chats.
              if (!isSaved) continue;

              const effectiveId = isUser ? serialized : `${number}@c.us`;
              if (seen.has(effectiveId)) continue;
              seen.add(effectiveId);

              // Get saved contact name (preferred) or pushname
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

    console.log(`✅ Loaded ${recent.length} recent chats and ${contactList.length} contacts.`);
    cachedContacts = { recent, contacts: contactList };
    return cachedContacts;
  } catch (err) {
    console.error('Failed to retrieve contacts/chats safely:', err);
    return { recent: [], contacts: [] };
  }
}

// ─── Routes ─────────────────────────────────────────────────────────────────

// Connection status
app.get('/api/status', (_req, res) => {
  res.json({ ready: clientReady, sending: isSending });
});

// Fetch contacts and recent chats
app.get('/api/contacts', async (req, res) => {
  if (!clientReady) {
    return res.status(400).json({ error: 'WhatsApp is not connected. Please scan the QR code first.' });
  }

  const forceRefresh = req.query.refresh === 'true';
  if (cachedContacts && !forceRefresh) {
    return res.json(cachedContacts);
  }

  try {
    const data = await fetchContactsData();
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

// Send messages
app.post('/api/send', upload.any(), async (req, res) => {
  if (!clientReady) {
    return res.status(400).json({ error: 'WhatsApp is not connected. Please scan the QR code first.' });
  }
  if (isSending) {
    return res.status(409).json({ error: 'A send operation is already in progress. Please wait.' });
  }

  const { message, recipients: recipientsJson, numbers: legacyNumbersJson } = req.body;
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
  isSending = true;

  // Respond immediately — progress updates sent via WebSocket
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
          await waClient.sendMessage(chatId, media, opts);
        }
      } else if (message) {
        await waClient.sendMessage(chatId, message);
      }

      sentCount++;
      io.emit('progress', {
        id: chatId,
        name: displayName,
        number: displayNum,
        status: 'sent',
        index: i,
        total: recipients.length,
        sentCount,
        failedCount,
      });
      console.log(`✅ [${i + 1}/${recipients.length}] Sent to ${displayName} (${displayNum})`);
    } catch (err) {
      failedCount++;
      io.emit('progress', {
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
      console.error(`❌ [${i + 1}/${recipients.length}] Failed for ${displayName} (${displayNum}): ${err.message}`);
    }

    // Delay between sends (skip after the last one)
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

  isSending = false;
  io.emit('complete', { sentCount, failedCount, total: recipients.length });
  console.log(`\n🏁 Done! Sent: ${sentCount}, Failed: ${failedCount}, Total: ${recipients.length}`);
});

// ─── Socket.IO ──────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log('🌐 Browser connected.');

  if (clientReady) {
    socket.emit('ready');
  } else if (qrCodeDataUrl) {
    socket.emit('qr', qrCodeDataUrl);
  } else {
    socket.emit('loading');
  }
});

// ─── Start Server ───────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Server running at http://localhost:${PORT}`);
  console.log(`📱 Phone app connect URL: http://192.168.0.112:${PORT}\n`);
});
