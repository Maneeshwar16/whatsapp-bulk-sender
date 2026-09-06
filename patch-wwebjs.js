const fs = require('fs');
const path = require('path');

const clientPath = path.join(__dirname, 'node_modules', 'whatsapp-web.js', 'src', 'Client.js');

if (!fs.existsSync(clientPath)) {
  console.log('whatsapp-web.js not found, skipping patch.');
  process.exit(0);
}

let content = fs.readFileSync(clientPath, 'utf8');

if (!content.includes('Socket.hasSynced)')) {
  if (content.includes("Socket.on('change:hasSynced'")) {
    content = content.replace(
      /Socket\.on\('change:hasSynced'[\s\S]*?\}\);/,
      `Socket.on('change:hasSynced', () => {
                    window.onAppStateHasSyncedEvent();
                });
            try {
                if (window.require('WAWebSocketModel').Socket.hasSynced) {
                    window.onAppStateHasSyncedEvent();
                }
            } catch (_) {}`
    );
    fs.writeFileSync(clientPath, content, 'utf8');
    console.log('✅ Successfully patched whatsapp-web.js Socket.hasSynced bug!');
  } else {
    console.log('⚠️ Could not locate patch insertion point in whatsapp-web.js.');
  }
} else {
  console.log('✅ whatsapp-web.js is already patched.');
}
