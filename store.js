// مخزن بسيط بملف JSON — للبداية فقط.
// في الإنتاج استبدله بقاعدة بيانات حقيقية (Postgres / Supabase) مع معاملات آمنة.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";

const DB_PATH = "./data/db.json";

function load() {
  if (!existsSync(DB_PATH)) return { users: {} };
  try { return JSON.parse(readFileSync(DB_PATH, "utf8")); }
  catch { return { users: {} }; }
}

function save(db) {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

export function getUser(email) {
  return load().users[email] || null;
}

export function getUserByVerifyToken(token) {
  const db = load();
  return Object.values(db.users).find((u) => u.verifyToken === token) || null;
}

export function updateUser(email, patch) {
  const db = load();
  const u = db.users[email];
  if (!u) return null;
  Object.assign(u, patch);
  save(db);
  return u;
}

export function createUser(user) {
  const db = load();
  db.users[user.email] = user;
  save(db);
  return user;
}

// تعديل الرصيد بشكل آمن نسبياً (read-modify-write).
// ملاحظة: مع تزامن عالٍ استخدم قاعدة بيانات تدعم المعاملات الذرّية.
export function addCredits(email, delta) {
  const db = load();
  const u = db.users[email];
  if (!u) return null;
  u.credits = Math.max(0, (u.credits ?? 0) + delta);
  save(db);
  return u.credits;
}

export function setCredits(email, value) {
  const db = load();
  const u = db.users[email];
  if (!u) return null;
  u.credits = Math.max(0, value);
  save(db);
  return u.credits;
}
