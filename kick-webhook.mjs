import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const STORE_NAME = "mod-stream-attendance";
const DB_KEY = "database";

let publicKeyCache = null;
let publicKeyFetchedAt = 0;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function normalize(db) {
  db ||= {};
  db.stream ||= { active: false, startedAt: null, endedAt: null, title: "", url: "", platform: "" };
  db.mods ||= [];
  db.sessions ||= [];
  db.logs ||= [];
  db.kickWebhookIds ||= [];
  db.kickConnection ||= { connected: false, broadcasterUserId: null, channelSlug: "", checkedAt: null };
  return db;
}

function store() {
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

async function loadEntry() {
  const entry = await store().getWithMetadata(DB_KEY, { type: "json" });
  if (!entry) {
    return {
      db: normalize({
        stream: { active: false, startedAt: null, endedAt: null, title: "", url: "", platform: "" },
        mods: [], sessions: [], logs: [], kickWebhookIds: [],
      }),
      etag: null,
    };
  }
  return { db: normalize(entry.data), etag: entry.etag };
}

async function mutate(fn) {
  for (let attempt = 0; attempt < 7; attempt++) {
    const { db, etag } = await loadEntry();
    const result = await fn(db);
    const options = etag ? { onlyIfMatch: etag } : { onlyIfNew: true };
    const saved = await store().setJSON(DB_KEY, db, options);
    if (saved.modified) return result;
  }
  throw new Error("Concurrent update failed");
}

function pushLog(db, type, message, meta = {}) {
  db.logs.unshift({
    id: crypto.randomUUID(),
    type,
    message,
    at: Date.now(),
    meta,
  });
  db.logs = db.logs.slice(0, 2500);
}

function activeSession(db, mod) {
  return mod.activeSessionId
    ? db.sessions.find((s) => s.id === mod.activeSessionId) || null
    : null;
}

async function getKickPublicKey() {
  if (publicKeyCache && Date.now() - publicKeyFetchedAt < 6 * 60 * 60 * 1000) {
    return publicKeyCache;
  }

  const response = await fetch("https://api.kick.com/public/v1/public-key");
  if (!response.ok) throw new Error("Could not fetch Kick public key");

  const payload = await response.json();
  const key = payload?.data?.public_key;
  if (!key) throw new Error("Kick public key missing");

  publicKeyCache = key;
  publicKeyFetchedAt = Date.now();
  return key;
}

async function verifyKick(req, rawBody) {
  const messageId = req.headers.get("kick-event-message-id") || "";
  const timestamp = req.headers.get("kick-event-message-timestamp") || "";
  const signature = req.headers.get("kick-event-signature") || "";

  if (!messageId || !timestamp || !signature) return false;

  const publicKey = await getKickPublicKey();
  const signedText = `${messageId}.${timestamp}.${rawBody}`;

  return crypto.verify(
    "RSA-SHA256",
    Buffer.from(signedText, "utf8"),
    publicKey,
    Buffer.from(signature, "base64")
  );
}

export default async (req) => {
  if (req.method !== "POST") return json({ ok: false }, 405);

  try {
    const rawBody = await req.text();
    const verified = await verifyKick(req, rawBody);

    if (!verified) return json({ error: "Invalid Kick signature" }, 401);

    const payload = JSON.parse(rawBody || "{}");
    const eventType = req.headers.get("kick-event-type") || "";
    const messageId = req.headers.get("kick-event-message-id") || "";

    await mutate((db) => {
      if (messageId && db.kickWebhookIds.includes(messageId)) {
        return { duplicate: true };
      }

      if (messageId) {
        db.kickWebhookIds.unshift(messageId);
        db.kickWebhookIds = db.kickWebhookIds.slice(0, 800);
      }

      if (eventType === "chat.message.sent") {
        const username = String(payload?.sender?.username || "").trim();
        const userId = payload?.sender?.user_id ?? null;
        const content = String(payload?.content || "").trim();
        const broadcasterId = payload?.broadcaster?.user_id ?? null;

        if (!username) return { ignored: true };

        const mod = db.mods.find((m) =>
          String(m.kickUsername || "").trim().toLowerCase() === username.toLowerCase()
        );

        if (!mod) return { ignored: true };

        const receivedAt = payload?.created_at ? Date.parse(payload.created_at) : Date.now();
        const at = Number.isFinite(receivedAt) ? receivedAt : Date.now();
        const excerpt = content.slice(0, 120);

        mod.lastKickMessageAt = at;
        mod.lastKickMessageExcerpt = excerpt;
        mod.kickUserId = userId;

        const session = activeSession(db, mod);
        if (session) {
          session.lastKickMessageAt = at;
          session.lastKickMessageExcerpt = excerpt;

          pushLog(
            db,
            "نشاط Kick",
            `${mod.name} كتب في شات Kick`,
            {
              modId: mod.id,
              kickUsername: username,
              kickUserId: userId,
              broadcasterUserId: broadcasterId,
              excerpt,
              messageId: payload?.message_id || null,
            }
          );
        }

        db.kickConnection.connected = true;
        db.kickConnection.checkedAt = Date.now();
        if (broadcasterId) db.kickConnection.broadcasterUserId = broadcasterId;
      }

      if (eventType === "livestream.status.updated") {
        const isLive = Boolean(payload?.is_live);
        const title = String(payload?.title || "Kick Stream").trim();
        const channelSlug = String(payload?.broadcaster?.channel_slug || "").trim();

        db.kickConnection.connected = true;
        db.kickConnection.checkedAt = Date.now();
        db.kickConnection.channelSlug = channelSlug || db.kickConnection.channelSlug || "";
        db.kickConnection.broadcasterUserId =
          payload?.broadcaster?.user_id ?? db.kickConnection.broadcasterUserId ?? null;

        if (isLive) {
          db.stream.active = true;
          db.stream.startedAt = payload?.started_at ? Date.parse(payload.started_at) : Date.now();
          db.stream.endedAt = null;
          db.stream.title = title || "Kick Stream";
          db.stream.platform = "Kick";
          if (channelSlug) db.stream.url = `https://kick.com/${channelSlug}`;

          pushLog(db, "Kick", `البث صار LIVE تلقائيًا: ${db.stream.title}`);
        } else {
          db.stream.active = false;
          db.stream.endedAt = payload?.ended_at ? Date.parse(payload.ended_at) : Date.now();
          pushLog(db, "Kick", "البث انتهى على Kick");
        }
      }

      return { ok: true };
    });

    return json({ ok: true });
  } catch (error) {
    console.error("Kick webhook error:", error);
    return json({ error: "Webhook error" }, 400);
  }
};
