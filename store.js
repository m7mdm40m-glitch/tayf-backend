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
