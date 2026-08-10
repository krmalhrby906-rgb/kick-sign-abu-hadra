import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const STORE_NAME = "mod-stream-attendance";
const DB_KEY = "database";
const ADMIN_PIN = process.env.ADMIN_PIN || "6868";
const WEEKLY_TARGET = Number(process.env.WEEKLY_TARGET || "60");

const pointsConfig = {
  checkIn: 5,
  per30Minutes: 2,
  finishBonus: 10,
  lateAfterMinutes: 15,
  latePenalty: 2,
};

function emptyDB() {
  return {
    stream: { active: false, startedAt: null, endedAt: null },
    mods: [],
    sessions: [],
    logs: [],
    weeklyTarget: WEEKLY_TARGET,
    createdAt: Date.now(),
  };
}

function normalize(db) {
  db ||= emptyDB();
  db.stream ||= { active: false, startedAt: null, endedAt: null };
  db.mods ||= [];
  db.sessions ||= [];
  db.logs ||= [];
  db.weeklyTarget = Number(db.weeklyTarget || WEEKLY_TARGET);
  for (const mod of db.mods) {
    mod.totalPoints = Number(mod.totalPoints || 0);
    mod.weekPoints = Number(mod.weekPoints || 0);
    mod.totalMinutes = Number(mod.totalMinutes || 0);
    mod.streamsAttended = Number(mod.streamsAttended || 0);
    mod.activeSessionId ||= null;
  }
  return db;
}

function store() {
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

async function loadEntry() {
  const entry = await store().getWithMetadata(DB_KEY, { type: "json" });
  if (!entry) return { db: emptyDB(), etag: null };
  return { db: normalize(entry.data), etag: entry.etag };
}

async function mutate(fn) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const { db, etag } = await loadEntry();
    const result = await fn(db);
    const options = etag ? { onlyIfMatch: etag } : { onlyIfNew: true };
    const saved = await store().setJSON(DB_KEY, db, options);
    if (saved.modified) return result;
  }
  throw new Error("حصل تعارض بسيط، حاول مرة ثانية.");
}

function id() {
  return crypto.randomUUID();
}
function now() {
  return Date.now();
}
function minutes(ms) {
  return Math.max(0, Math.floor(ms / 60000));
}
function clean(v, max = 80) {
  return String(v ?? "").trim().slice(0, max);
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
function isAdmin(req) {
  return String(req.headers.get("x-admin-pin") || "") === String(ADMIN_PIN);
}
function activeSession(db, mod) {
  return mod.activeSessionId
    ? db.sessions.find((s) => s.id === mod.activeSessionId) || null
    : null;
}
function previewPoints(session) {
  if (!session) return 0;
  const end = session.checkedOutAt || now();
  const durationMinutes = minutes(end - session.checkedInAt);
  return (
    Number(session.basePoints || 0) +
    Math.floor(durationMinutes / 30) * pointsConfig.per30Minutes
  );
}
function pushLog(db, type, message, meta = {}) {
  db.logs.unshift({
    id: id(),
    type,
    message,
    at: now(),
    meta,
  });
  db.logs = db.logs.slice(0, 2000);
}
function publicState(db) {
  const active = db.mods
    .filter((m) => m.activeSessionId)
    .map((m) => {
      const s = activeSession(db, m);
      return {
        id: m.id,
        name: m.name,
        checkedInAt: s?.checkedInAt || null,
        durationMs: s ? (s.checkedOutAt || now()) - s.checkedInAt : 0,
        livePoints: previewPoints(s),
      };
    });

  const leaderboard = db.mods
    .map((m) => {
      const s = activeSession(db, m);
      const live = s ? previewPoints(s) : 0;
      return {
        id: m.id,
        name: m.name,
        role: m.role || "Moderator",
        totalPoints: m.totalPoints + live,
        weekPoints: m.weekPoints + live,
        totalMinutes:
          m.totalMinutes +
          (s ? minutes((s.checkedOutAt || now()) - s.checkedInAt) : 0),
        streamsAttended: m.streamsAttended,
      };
    })
    .sort((a, b) => b.weekPoints - a.weekPoints || b.totalPoints - a.totalPoints);

  return {
    stream: db.stream,
    active,
    leaderboard,
    weeklyTarget: db.weeklyTarget,
  };
}
function adminState(db) {
  return {
    ...publicState(db),
    mods: db.mods.map((m) => ({
      id: m.id,
      name: m.name,
      role: m.role || "Moderator",
      totalPoints: m.totalPoints,
      weekPoints: m.weekPoints,
      totalMinutes: m.totalMinutes,
      streamsAttended: m.streamsAttended,
      active: !!m.activeSessionId,
    })),
  };
}

export default async (req) => {
  try {
    const url = new URL(req.url);
    const action = url.searchParams.get("action") || "state";

    if (req.method === "GET" && action === "state") {
      const { db } = await loadEntry();
      return json(publicState(db));
    }

    if (req.method === "POST" && action === "checkin") {
      const body = await req.json();
      const result = await mutate((db) => {
        if (!db.stream.active) throw new Error("البث غير شغال الآن.");

        const name = clean(body.name).toLowerCase();
        const pin = clean(body.pin);
        const mod = db.mods.find(
          (m) => String(m.name).trim().toLowerCase() === name
        );

        if (!mod || String(mod.pin) !== pin)
          throw new Error("الاسم أو PIN غير صحيح.");
        if (mod.activeSessionId)
          throw new Error("أنت مسجل دخول بالفعل.");

        const lateMinutes = db.stream.startedAt
          ? minutes(now() - db.stream.startedAt)
          : 0;
        let basePoints = pointsConfig.checkIn;
        let latePenalty = 0;

        if (lateMinutes > pointsConfig.lateAfterMinutes) {
          latePenalty = pointsConfig.latePenalty;
          basePoints -= latePenalty;
        }

        const session = {
          id: id(),
          modId: mod.id,
          checkedInAt: now(),
          checkedOutAt: null,
          basePoints,
          latePenalty,
          awarded: false,
        };

        db.sessions.push(session);
        mod.activeSessionId = session.id;
        pushLog(
          db,
          "تسجيل دخول",
          `${mod.name} سجل دخول`,
          { modId: mod.id, lateMinutes, basePoints }
        );
        return { ok: true };
      });
      return json(result);
    }

    if (req.method === "POST" && action === "checkout") {
      const body = await req.json();
      const result = await mutate((db) => {
        const name = clean(body.name).toLowerCase();
        const pin = clean(body.pin);
        const mod = db.mods.find(
          (m) => String(m.name).trim().toLowerCase() === name
        );

        if (!mod || String(mod.pin) !== pin)
          throw new Error("الاسم أو PIN غير صحيح.");

        const session = activeSession(db, mod);
        if (!session) throw new Error("أنت غير مسجل دخول.");

        session.checkedOutAt = now();
        const earned = previewPoints(session);
        const durationMinutes = minutes(
          session.checkedOutAt - session.checkedInAt
        );

        mod.totalPoints += earned;
        mod.weekPoints += earned;
        mod.totalMinutes += durationMinutes;
        mod.streamsAttended += 1;
        mod.activeSessionId = null;

        session.awarded = true;
        session.awardedPoints = earned;

        pushLog(
          db,
          "تسجيل خروج",
          `${mod.name} سجل خروج (+${earned} نقطة)`,
          { modId: mod.id, durationMinutes, earned }
        );

        return { ok: true, earned };
      });
      return json(result);
    }

    if (req.method === "POST" && action === "admin-login") {
      if (!isAdmin(req)) return json({ error: "PIN الإدارة خطأ." }, 403);
      return json({ ok: true });
    }

    if (action.startsWith("admin-")) {
      if (!isAdmin(req)) return json({ error: "PIN الإدارة خطأ." }, 403);

      if (req.method === "GET" && action === "admin-state") {
        const { db } = await loadEntry();
        return json(adminState(db));
      }

      if (req.method === "GET" && action === "admin-logs") {
        const { db } = await loadEntry();
        return json({ logs: db.logs.slice(0, 500) });
      }

      if (req.method === "POST" && action === "admin-stream-start") {
        const result = await mutate((db) => {
          if (db.stream.active) throw new Error("البث شغال بالفعل.");
          db.stream = { active: true, startedAt: now(), endedAt: null };
          pushLog(db, "البث", "تم بدء البث");
          return { ok: true };
        });
        return json(result);
      }

      if (req.method === "POST" && action === "admin-stream-end") {
        const result = await mutate((db) => {
          if (!db.stream.active) throw new Error("ما فيه بث شغال.");

          const end = now();

          for (const mod of db.mods) {
            const session = activeSession(db, mod);
            if (!session) continue;

            session.checkedOutAt = end;
            const earned =
              previewPoints(session) + pointsConfig.finishBonus;
            const durationMinutes = minutes(
              end - session.checkedInAt
            );

            mod.totalPoints += earned;
            mod.weekPoints += earned;
            mod.totalMinutes += durationMinutes;
            mod.streamsAttended += 1;
            mod.activeSessionId = null;

            session.awarded = true;
            session.awardedPoints = earned;
            session.finishBonus = pointsConfig.finishBonus;

            pushLog(
              db,
              "خروج تلقائي",
              `${mod.name} أنهى البث (+${earned} نقطة)`,
              { modId: mod.id, durationMinutes, earned }
            );
          }

          db.stream.active = false;
          db.stream.endedAt = end;
          pushLog(db, "البث", "تم إنهاء البث");
          return { ok: true };
        });
        return json(result);
      }

      if (req.method === "POST" && action === "admin-mod-add") {
        const body = await req.json();
        const result = await mutate((db) => {
          const name = clean(body.name);
          const pin = clean(body.pin);
          const role = clean(body.role) || "Moderator";

          if (!name || !pin) throw new Error("اكتب اسم المود وPIN.");
          if (
            db.mods.some(
              (m) => m.name.trim().toLowerCase() === name.toLowerCase()
            )
          )
            throw new Error("هذا الاسم موجود بالفعل.");

          db.mods.push({
            id: id(),
            name,
            role,
            pin,
            totalPoints: 0,
            weekPoints: 0,
            totalMinutes: 0,
            streamsAttended: 0,
            activeSessionId: null,
          });

          pushLog(db, "إدارة", `تمت إضافة المود ${name}`);
          return { ok: true };
        });
        return json(result);
      }

      if (req.method === "POST" && action === "admin-mod-delete") {
        const body = await req.json();
        const result = await mutate((db) => {
          const mod = db.mods.find((m) => m.id === body.id);
          if (!mod) throw new Error("المود غير موجود.");
          if (mod.activeSessionId)
            throw new Error("المود مسجل دخول الآن.");

          db.mods = db.mods.filter((m) => m.id !== body.id);
          pushLog(db, "إدارة", `تم حذف المود ${mod.name}`);
          return { ok: true };
        });
        return json(result);
      }

      if (req.method === "POST" && action === "admin-points") {
        const body = await req.json();
        const result = await mutate((db) => {
          const mod = db.mods.find((m) => m.id === body.id);
          const amount = Number(body.amount);

          if (!mod) throw new Error("المود غير موجود.");
          if (!Number.isFinite(amount) || amount === 0)
            throw new Error("اكتب عدد نقاط صحيح.");

          mod.totalPoints += amount;
          mod.weekPoints += amount;

          pushLog(
            db,
            "تعديل نقاط",
            `${amount > 0 ? "تمت إضافة" : "تم خصم"} ${Math.abs(amount)} نقطة ${
              amount > 0 ? "لـ" : "من"
            } ${mod.name}`,
            { modId: mod.id, amount }
          );
          return { ok: true };
        });
        return json(result);
      }

      if (req.method === "POST" && action === "admin-week-reset") {
        const result = await mutate((db) => {
          for (const mod of db.mods) mod.weekPoints = 0;
          pushLog(db, "أسبوع جديد", "تم تصفير النقاط الأسبوعية لجميع المودات");
          return { ok: true };
        });
        return json(result);
      }
    }

    return json({ error: "Not found" }, 404);
  } catch (error) {
    console.error(error);
    return json({ error: error?.message || "حدث خطأ غير متوقع." }, 400);
  }
};
