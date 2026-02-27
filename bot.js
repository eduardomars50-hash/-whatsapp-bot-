const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const http = require('http');

console.log('🤖 Jorge WhatsApp Bot starting...\n');

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './session' }),
    puppeteer: {
        headless: true,
        protocolTimeout: 120000,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

let isReady = false;
const messageLog = []; // in-memory store of all messages

// ─── QR Code ────────────────────────────────────────────────
client.on('qr', (qr) => {
    console.log('\n📱 SCAN THIS QR CODE WITH YOUR WHATSAPP:\n');
    qrcode.generate(qr, { small: true });
    console.log('\n⬆️  WhatsApp → Settings → Linked Devices → Link a Device\n');
});

client.on('authenticated', () => {
    console.log('✅ Authenticated! Session saved.\n');
});

client.on('ready', () => {
    isReady = true;
    console.log('🟢 Bot is READY and connected to WhatsApp!\n');
    console.log('🌐 Command server running on http://localhost:3001\n');
    console.log('─'.repeat(50));
});

// ─── Incoming Messages ──────────────────────────────────────
client.on('message', async (msg) => {
    const contact = await msg.getContact();
    const name = contact.pushname || contact.number;
    const timestamp = new Date().toLocaleTimeString('es-MX');

    console.log(`\n[${timestamp}] 📩 FROM: ${name} (${contact.number})`);
    console.log(`  MESSAGE: ${msg.body}`);

    messageLog.push({
        direction: 'in',
        from: name,
        number: contact.number,
        body: msg.body,
        time: new Date().toISOString()
    });

    if (msg.body.toLowerCase() === 'hola') {
        await msg.reply('¡Hola! 👋 Este es un mensaje automático. Eduardo te responderá pronto.');
    }
    if (msg.body.toLowerCase().includes('precio') || msg.body.toLowerCase().includes('cotiza')) {
        await msg.reply('Gracias por contactarnos. Eduardo revisará tu mensaje y te enviará la cotización pronto. 📋');
    }
});

// ─── HTTP Command Server ────────────────────────────────────
// Jorge uses this to send messages on Eduardo's behalf
const WHATSAPP_SECRET = process.env.WHATSAPP_SECRET;

const server = http.createServer(async (req, res) => {
    // Auth check — skip only for /status (health check)
    if (req.url !== '/status') {
        const auth = req.headers['authorization'];
        if (WHATSAPP_SECRET && auth !== `Bearer ${WHATSAPP_SECRET}`) {
            res.writeHead(401);
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
        }
    }

    if (req.method === 'POST' && req.url === '/send') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { to, message } = JSON.parse(body);

                if (!isReady) {
                    res.writeHead(503);
                    res.end(JSON.stringify({ error: 'Bot not ready yet' }));
                    return;
                }

                // Format number: add @c.us suffix (WhatsApp ID format)
                // Accepts formats: 5219991234567 or +52 999 123 4567
                const number = to.replace(/[^0-9]/g, '') + '@c.us';

                await client.sendMessage(number, message);

                const timestamp = new Date().toLocaleTimeString('es-MX');
                console.log(`\n[${timestamp}] 📤 JORGE SENT to ${to}:`);
                console.log(`  "${message}"`);

                res.writeHead(200);
                res.end(JSON.stringify({ success: true, to, message }));
            } catch (err) {
                console.error('Send error:', err.message);
                res.writeHead(500);
                res.end(JSON.stringify({ error: err.message }));
            }
        });
    } else if (req.method === 'GET' && req.url === '/status') {
        res.writeHead(200);
        res.end(JSON.stringify({ ready: isReady }));

    } else if (req.method === 'GET' && req.url.startsWith('/chat')) {
        // Get recent chat with a contact: GET /chat?q=Valen&limit=20
        try {
            const urlParams = new URL(req.url, 'http://localhost');
            const query = (urlParams.searchParams.get('q') || '').toLowerCase();
            const limit = parseInt(urlParams.searchParams.get('limit') || '20');

            // Find the contact
            const contacts = await client.getContacts();
            const contact = contacts.find(c => {
                const name = (c.pushname || c.name || '').toLowerCase();
                return name.includes(query) && c.isMyContact;
            });

            if (!contact) {
                res.writeHead(404);
                res.end(JSON.stringify({ error: `No contact found matching: ${query}` }));
                return;
            }

            // Get the chat
            const chat = await client.getChatById(contact.id._serialized);
            const messages = await chat.fetchMessages({ limit });

            const formatted = messages.map(m => ({
                direction: m.fromMe ? 'out' : 'in',
                from: m.fromMe ? 'Eduardo' : (contact.pushname || contact.number),
                body: m.body,
                time: new Date(m.timestamp * 1000).toLocaleString('es-MX')
            }));

            res.writeHead(200);
            res.end(JSON.stringify({ contact: contact.pushname || contact.name, messages: formatted }));
        } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: err.message }));
        }

    } else if (req.method === 'GET' && req.url.startsWith('/groups')) {
        // Search groups by name: GET /groups?q=chico
        try {
            const urlParams = new URL(req.url, 'http://localhost');
            const query = (urlParams.searchParams.get('q') || '').toLowerCase();
            const chats = await client.getChats();
            const groups = chats
                .filter(c => c.isGroup && c.name.toLowerCase().includes(query))
                .map(c => ({ name: c.name, id: c.id._serialized }));
            res.writeHead(200);
            res.end(JSON.stringify(groups));
        } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: err.message }));
        }

    } else if (req.method === 'GET' && req.url.startsWith('/contacts')) {
        // Search contacts by name: GET /contacts?q=Valen
        try {
            const urlParams = new URL(req.url, 'http://localhost');
            const query = (urlParams.searchParams.get('q') || '').toLowerCase();
            const contacts = await client.getContacts();
            const matches = contacts
                .filter(c => {
                    const name = (c.pushname || c.name || '').toLowerCase();
                    return name.includes(query) && c.isMyContact;
                })
                .map(c => ({
                    name: c.pushname || c.name,
                    number: c.number,
                    id: c.id._serialized
                }));
            res.writeHead(200);
            res.end(JSON.stringify(matches));
        } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: err.message }));
        }

    } else if (req.method === 'POST' && req.url === '/send-doc') {
        // Send a document/file: POST /send-doc { to, filePath, caption }
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { to, filePath, caption } = JSON.parse(body);
                if (!isReady) { res.writeHead(503); res.end(JSON.stringify({ error: 'Bot not ready' })); return; }
                const { MessageMedia } = require('whatsapp-web.js');
                const media = MessageMedia.fromFilePath(filePath);
                const number = to.replace(/[^0-9]/g, '') + '@c.us';
                await client.sendMessage(number, media, { caption: caption || '' });
                const timestamp = new Date().toLocaleTimeString('es-MX');
                console.log(`\n[${timestamp}] 📎 JORGE SENT DOC to ${to}: ${filePath}`);
                res.writeHead(200);
                res.end(JSON.stringify({ success: true, to, filePath }));
            } catch (err) {
                res.writeHead(500);
                res.end(JSON.stringify({ error: err.message }));
            }
        });

    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Command server listening on port ${PORT}\n`);
});

client.on('disconnected', (reason) => {
    isReady = false;
    console.log('🔴 Disconnected:', reason);
});

client.initialize();
