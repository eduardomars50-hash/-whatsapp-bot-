import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import QRCode from "qrcode";
import { join } from "path";

const AUTH_DIR = process.env.AUTH_DIR ?? join(import.meta.dir, "auth");
const PORT = parseInt(process.env.PORT ?? "8891");
const SECRET = process.env.WHATSAPP_SECRET ?? "";

let sock: ReturnType<typeof makeWASocket> | null = null;
let isConnected = false;
let latestQR: string | null = null;

// In-memory stores
const msgStore: Record<string, Array<{ from: string; body: string; time: string; out: boolean }>> = {};
const contactStore: Record<string, string> = {}; // jid → display name

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ["PAI", "Chrome", "1.0"],
    getMessage: async () => undefined,
  });

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      latestQR = qr;
      console.log("📱 QR ready — visit /qr to scan");
    }
    if (connection === "close") {
      isConnected = false;
      latestQR = null;
      const shouldReconnect =
        (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("Connection closed. Reconnect:", shouldReconnect);
      if (shouldReconnect) setTimeout(startWhatsApp, 3000);
    } else if (connection === "open") {
      isConnected = true;
      latestQR = null;
      console.log("✅ WhatsApp connected to PAI!");
    }
  });

  sock.ev.on("messages.upsert", ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      const jid = msg.key.remoteJid!;
      const body =
        msg.message?.conversation ??
        msg.message?.extendedTextMessage?.text ??
        "[media]";
      const name = msg.pushName ?? jid.replace("@s.whatsapp.net", "");
      const out = !!msg.key.fromMe;
      if (!out && name) contactStore[jid] = name;
      if (!msgStore[jid]) msgStore[jid] = [];
      msgStore[jid].push({
        from: out ? "me" : name,
        body,
        time: new Date(Number(msg.messageTimestamp) * 1000).toLocaleString("es-MX"),
        out,
      });
      if (msgStore[jid].length > 100) msgStore[jid].shift();
    }
  });

  sock.ev.on("creds.update", saveCreds);
}

function checkAuth(req: Request): boolean {
  if (!SECRET) return true;
  return req.headers.get("authorization") === `Bearer ${SECRET}`;
}

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // ── Public endpoints ──────────────────────────────────────
    if (path === "/status") {
      return Response.json({ ready: isConnected });
    }

    if (path === "/qr") {
      if (isConnected) {
        return new Response(
          `<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#111;color:#fff"><h2>✅ Already connected! No QR needed.</h2></body></html>`,
          { headers: { "Content-Type": "text/html" } }
        );
      }
      if (!latestQR) {
        return new Response(
          `<html><head><meta http-equiv="refresh" content="5"></head><body style="font-family:sans-serif;text-align:center;padding:40px;background:#111;color:#fff"><h2>⏳ Starting up... auto-refreshing in 5s</h2></body></html>`,
          { headers: { "Content-Type": "text/html" } }
        );
      }
      const dataUrl = await QRCode.toDataURL(latestQR, { width: 400, margin: 2 });
      return new Response(
        `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="20"><title>WhatsApp QR</title>
        <style>body{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#111;color:#fff;font-family:sans-serif}img{background:#fff;padding:16px;border-radius:16px}</style>
        </head><body>
        <h2>📱 Scan with WhatsApp → Settings → Linked Devices</h2>
        <img src="${dataUrl}"/>
        <p style="color:#888">Auto-refreshes every 20s. Scan quickly — QR expires in ~20s.</p>
        </body></html>`,
        { headers: { "Content-Type": "text/html" } }
      );
    }

    // ── Auth-protected endpoints ──────────────────────────────
    if (!checkAuth(req)) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (path === "/send" && req.method === "POST") {
      if (!isConnected || !sock)
        return Response.json({ error: "Not connected" }, { status: 503 });
      const { to, message } = (await req.json()) as { to: string; message: string };
      if (!to || !message)
        return Response.json({ error: "to and message required" }, { status: 400 });
      const jid = to.replace(/[^0-9]/g, "") + "@s.whatsapp.net";
      await sock.sendMessage(jid, { text: message });
      console.log(`📤 Sent to ${to}: "${message}"`);
      return Response.json({ success: true, to, message });
    }

    if (path === "/contacts") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const matches = Object.entries(contactStore)
        .filter(([jid, name]) => name.toLowerCase().includes(q) || jid.includes(q))
        .map(([jid, name]) => ({
          name,
          number: jid.replace("@s.whatsapp.net", ""),
          id: jid,
        }));
      return Response.json(matches);
    }

    if (path === "/chat") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const limit = parseInt(url.searchParams.get("limit") ?? "20");
      const entry = Object.entries(contactStore).find(
        ([jid, name]) => name.toLowerCase().includes(q) || jid.includes(q)
      );
      if (!entry)
        return Response.json({ error: `No contact found: ${q}` }, { status: 404 });
      const [jid, name] = entry;
      const messages = (msgStore[jid] ?? []).slice(-limit);
      return Response.json({ contact: name, messages });
    }

    if (path === "/groups") {
      // Groups not supported in this lightweight version
      return Response.json([]);
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

console.log(`🌐 WhatsApp PAI API running on port ${PORT}`);
startWhatsApp();
