// مخزن البيانات باستخدام PostgreSQL (دائم — لا يُمسح مع إعادة النشر).
import pg from "pg";
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false },
});
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      email TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      pass_hash TEXT NOT NULL,
      credits INTEGER NOT NULL DEFAULT 0,
      verified BOOLEAN NOT NULL DEFAULT false,
      verify_token TEXT,
      subscribed BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // جدول أعمال المستخدم (الأرشيف)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS creations (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
      url TEXT NOT NULL,
      mode TEXT NOT NULL,
      prompt TEXT,
      prompt_en TEXT,
      ratio TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // إضافة عمود الوصف الإنجليزي للجداول القديمة (إن لم يكن موجوداً)
  await pool.query(`ALTER TABLE creations ADD COLUMN IF NOT EXISTS prompt_en TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS creations_email_idx ON creations(email, created_at DESC)`);
}
await ensureSchema();
function rowToUser(row) {
  if (!row) return null;
  return {
    email: row.email,
    name: row.name,
    passHash: row.pass_hash,
    credits: row.credits,
    verified: row.verified,
    verifyToken: row.verify_token,
    subscribed: row.subscribed,
  };
}
export async function getUser(email) {
  const r = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
  return rowToUser(r.rows[0]);
}
export async function getUserByVerifyToken(token) {
  const r = await pool.query("SELECT * FROM users WHERE verify_token = $1", [token]);
  return rowToUser(r.rows[0]);
}
export async function createUser(user) {
  await pool.query(
    `INSERT INTO users (email, name, pass_hash, credits, verified, verify_token)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [user.email, user.name, user.passHash, user.credits ?? 0, user.verified ?? false, user.verifyToken ?? null]
  );
  return user;
}
export async function updateUser(email, patch) {
  const fields = [];
  const values = [];
  let i = 1;
  const map = {
    name: "name",
    passHash: "pass_hash",
    credits: "credits",
    verified: "verified",
    verifyToken: "verify_token",
    subscribed: "subscribed",
  };
  for (const key of Object.keys(patch)) {
    if (map[key]) {
      fields.push(`${map[key]} = $${i++}`);
      values.push(patch[key]);
    }
  }
  if (!fields.length) return await getUser(email);
  values.push(email);
  const r = await pool.query(
    `UPDATE users SET ${fields.join(", ")} WHERE email = $${i} RETURNING *`,
    values
  );
  return rowToUser(r.rows[0]);
}
export async function addCredits(email, delta) {
  const r = await pool.query(
    `UPDATE users SET credits = GREATEST(0, credits + $1) WHERE email = $2 RETURNING credits`,
    [delta, email]
  );
  return r.rows[0]?.credits ?? null;
}
export async function setCredits(email, value) {
  const r = await pool.query(
    `UPDATE users SET credits = GREATEST(0, $1) WHERE email = $2 RETURNING credits`,
    [value, email]
  );
  return r.rows[0]?.credits ?? null;
}

// ---- أعمال المستخدم (الأرشيف) ----
function rowToCreation(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    url: row.url,
    mode: row.mode,
    prompt: row.prompt,
    promptEn: row.prompt_en,
    ratio: row.ratio,
    createdAt: row.created_at,
  };
}
// حفظ عمل واحد في الأرشيف
export async function addCreation(email, item) {
  const r = await pool.query(
    `INSERT INTO creations (email, url, mode, prompt, prompt_en, ratio)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [email, item.url, item.mode, item.prompt ?? null, item.promptEn ?? null, item.ratio ?? null]
  );
  return rowToCreation(r.rows[0]);
}
// جلب أعمال مستخدم (الأحدث أولاً) مع حد أقصى
export async function getCreations(email, limit = 60) {
  const r = await pool.query(
    `SELECT * FROM creations WHERE email = $1 ORDER BY created_at DESC LIMIT $2`,
    [email, limit]
  );
  return r.rows.map(rowToCreation);
}
// حذف عمل واحد (فقط إن كان يخص نفس المستخدم)
export async function deleteCreation(email, id) {
  const r = await pool.query(
    `DELETE FROM creations WHERE id = $1 AND email = $2 RETURNING id`,
    [id, email]
  );
  return r.rowCount > 0;
}

// ================= دوال لوحة الأدمن =================

// جلب كل المستخدمين مع عدد أعمالهم (الأحدث تسجيلاً أولاً)
export async function adminGetAllUsers() {
  const r = await pool.query(`
    SELECT u.email, u.name, u.credits, u.verified, u.subscribed, u.created_at,
           COUNT(c.id) AS creations_count
    FROM users u
    LEFT JOIN creations c ON c.email = u.email
    GROUP BY u.email
    ORDER BY u.created_at DESC
  `);
  return r.rows.map((row) => ({
    email: row.email,
    name: row.name,
    credits: row.credits,
    verified: row.verified,
    subscribed: row.subscribed,
    createdAt: row.created_at,
    creationsCount: Number(row.creations_count),
  }));
}

// إحصائيات عامة للموقع
export async function adminGetStats() {
  const usersR = await pool.query(`
    SELECT
      COUNT(*) AS total_users,
      COUNT(*) FILTER (WHERE verified = true) AS verified_users,
      COUNT(*) FILTER (WHERE subscribed = true) AS subscribed_users,
      COALESCE(SUM(credits), 0) AS total_credits
    FROM users
  `);
  const creationsR = await pool.query(`
    SELECT
      COUNT(*) AS total_creations,
      COUNT(*) FILTER (WHERE mode = 'image') AS total_images,
      COUNT(*) FILTER (WHERE mode = 'video') AS total_videos
    FROM creations
  `);
  const u = usersR.rows[0];
  const c = creationsR.rows[0];
  return {
    totalUsers: Number(u.total_users),
    verifiedUsers: Number(u.verified_users),
    subscribedUsers: Number(u.subscribed_users),
    totalCredits: Number(u.total_credits),
    totalCreations: Number(c.total_creations),
    totalImages: Number(c.total_images),
    totalVideos: Number(c.total_videos),
  };
}

// حذف مستخدم نهائياً (مع كل أعماله عبر ON DELETE CASCADE)
export async function adminDeleteUser(email) {
  const r = await pool.query(`DELETE FROM users WHERE email = $1 RETURNING email`, [email]);
  return r.rowCount > 0;
}
