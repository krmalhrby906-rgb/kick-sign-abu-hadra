import { getStore } from "@netlify/blobs";

const ADMIN_PIN = process.env.ADMIN_PIN || "6868";
const CLIENT_ID = process.env.KICK_CLIENT_ID || "";
const CLIENT_SECRET = process.env.KICK_CLIENT_SECRET || "";
const CHANNEL_SLUG = (process.env.KICK_CHANNEL_SLUG || "").replace(/^@/, "").trim();

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function isAdmin(req) {
  return String(req.headers.get("x-admin-pin") || "") === String(ADMIN_PIN);
}

function store() {
  return getStore({ name: "mod-stream-attendance", consistency: "strong" });
}

async function getAppToken() {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });

  const response = await fetch("https://id.kick.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    throw new Error(payload?.error || payload?.message || "فشل الحصول على Kick App Token");
  }

  return payload.access_token;
}

async function getBroadcaster(token) {
  const response = await fetch(
    `https://api.kick.com/public/v1/channels?slug=${encodeURIComponent(CHANNEL_SLUG)}`,
    { headers: { authorization: `Bearer ${token}` } }
  );

  const payload = await response.json().catch(() => ({}));
  const channel = payload?.data?.[0];

  if (!response.ok || !channel?.broadcaster_user_id) {
    throw new Error("ما قدرت ألقى قناة Kick. تأكد من KICK_CHANNEL_SLUG.");
  }

  return channel;
}

async function subscribe(token, broadcasterUserId) {
  const response = await fetch("https://api.kick.com/public/v1/events/subscriptions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      broadcaster_user_id: Number(broadcasterUserId),
      events: [
        { name: "chat.message.sent", version: 1 },
        { name: "livestream.status.updated", version: 1 },
      ],
      method: "webhook",
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.message || payload?.error || "فشل الاشتراك بأحداث Kick");
  }

  return payload;
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!isAdmin(req)) return json({ error: "PIN الإدارة خطأ." }, 403);

  try {
    if (!CLIENT_ID || !CLIENT_SECRET || !CHANNEL_SLUG) {
      return json({
        error: "ناقص إعداد Kick في Netlify Environment Variables.",
        missing: {
          KICK_CLIENT_ID: !CLIENT_ID,
          KICK_CLIENT_SECRET: !CLIENT_SECRET,
          KICK_CHANNEL_SLUG: !CHANNEL_SLUG,
        },
      }, 400);
    }

    const token = await getAppToken();
    const channel = await getBroadcaster(token);
    const subscription = await subscribe(token, channel.broadcaster_user_id);

    const dbStore = store();
    const entry = await dbStore.get("database", { type: "json" });
    const db = entry || {};
    db.kickConnection ||= {};
    db.kickConnection.connected = true;
    db.kickConnection.channelSlug = CHANNEL_SLUG;
    db.kickConnection.broadcasterUserId = channel.broadcaster_user_id;
    db.kickConnection.checkedAt = Date.now();
    db.kickConnection.subscriptionResult = subscription;
    await dbStore.setJSON("database", db);

    return json({
      ok: true,
      channelSlug: CHANNEL_SLUG,
      broadcasterUserId: channel.broadcaster_user_id,
      subscriptions: subscription?.data || subscription,
    });
  } catch (error) {
    console.error("Kick setup error:", error);
    return json({ error: error?.message || "فشل ربط Kick" }, 400);
  }
};
