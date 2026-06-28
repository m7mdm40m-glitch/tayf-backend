import "dotenv/config";
import crypto from "crypto";
import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import Anthropic from "@anthropic-ai/sdk";
import { fal } from "@fal-ai/client";
import { getUser, createUser, addCredits, setCredits, updateUser, getUserByVerifyToken, addCreation, getCreations, deleteCreation, adminGetAllUsers, adminGetStats, adminDeleteUser } from "./store.js";

const PORT = process.env.PORT || 8787;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const FREE_CREDITS = Number(process.env.FREE_CREDITS || 3);
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
// إيميلات الأدمن (مفصولة بفاصلة). فقط هذه الحسابات تدخل لوحة التحكم.
const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS || "tayff.art@gmail.com")
    .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean)
);

fal.config({ credentials: process.env.FAL_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const DISPOSABLE = new Set([
  "tempmail.com", "temp-mail.org", "10minutemail.com", "guerrillamail.com",
  "mailinator.com", "yopmail.com", "throwawaymail.com", "getnada.com",
  "trashmail.com", "fakeinbox.com", "sharklasers.com", "maildrop.cc",
  "dispostable.com", "mintemail.com", "mohmal.com", "emailondeck.com",
]);
function isDisposable(email) {
  const domain = String(email).split("@")[1]?.toLowerCase() || "";
  return DISPOSABLE.has(domain);
}

async function sendVerifyEmail(email, link) {
  const RESEND_KEY = process.env.RESEND_API_KEY;
  const FROM = process.env.MAIL_FROM || "Tayf <no-reply@tayf.art>";
  // إن لم يوجد مفتاح Resend، اطبع الرابط في السجلّات (وضع التطوير)
  if (!RESEND_KEY) {
    console.log(`\n[تأكيد البريد] أرسل هذا الرابط إلى ${email}:\n${link}\n`);
    return;
  }
  const html = `<div dir="rtl" style="font-family:Arial,sans-serif;line-height:1.8;color:#111">
      <h2 style="color:#6b46c1">طيف</h2>
      <p>مرحباً،</p>
      <p>اضغط الزر لتفعيل حسابك والحصول على تجربتك المجانية في طيف:</p>
      <p style="margin:24px 0">
        <a href="${link}" style="background:#6b46c1;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold">تفعيل الحساب</a>
      </p>
      <p style="color:#666;font-size:13px">أو انسخ هذا الرابط في المتصفّح:<br>${link}</p>
    </div>`;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + RESEND_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM,
      to: email,
      subject: "أكّد بريدك لتفعيل تجربتك المجانية في طيف",
      html,
    }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error("Resend failed: " + r.status + " " + detail);
  }
}

const app = express();
app.use(express.json());
// Render يعمل خلف بروكسي — هذا ضروري حتى يقرأ rate-limit عنوان IP الحقيقي للمستخدم
app.set("trust proxy", 1);
const ALLOWED_ORIGINS = [
  "https://tayf.art",
  "https://www.tayf.art",
  "https://tayf-kohl.vercel.app",
];
app.use(cors({
  origin: function (origin, callback) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
}));

// ============ حدود معدّل الطلبات (Rate Limiting) — حماية من السبام وهدر الفلوس ============
// حدّ صارم لمحاولات تسجيل الدخول والتسجيل: يمنع تخمين كلمات السر وسبام الإيميلات.
// 10 محاولات لكل IP خلال 15 دقيقة.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "TOO_MANY_ATTEMPTS" },
});

// حدّ على التحسين والتوليد: يمنع حرق رصيد Anthropic / fal.
// 30 طلب لكل IP خلال 5 دقائق.
const aiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "TOO_MANY_REQUESTS" },
});

const VIDEO_ENDPOINTS = {
  "kling26": "fal-ai/kling-video/v2.6/pro/text-to-video",
  "veo3.1": "fal-ai/veo3.1/text-to-video",
  "kling3": "fal-ai/kling-video/v3.0/text-to-video",
  "seedance2": "fal-ai/bytedance/seedance-v2/text-to-video",
};
const IMAGE_ENDPOINT = "fal-ai/flux/dev";

const FREE_MODEL = "kling26";

const IMAGE_SIZE = {
  "9:16": "portrait_16_9",
  "1:1": "square_hd",
  "16:9": "landscape_16_9",
  "4:5": "portrait_4_3",
};

function sign(user) {
  return jwt.sign({ email: user.email, name: user.name }, JWT_SECRET, { expiresIn: "30d" });
}
function publicUser(u) {
  return { name: u.name, email: u.email, credits: u.credits, subscribed: u.subscribed };
}
async function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "NO_TOKEN" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const u = await getUser(payload.email);
    if (!u) return res.status(401).json({ error: "NO_USER" });
    req.user = u;
    next();
  } catch {
    return res.status(401).json({ error: "BAD_TOKEN" });
  }
}

// وسيط حماية الأدمن — يُستخدم بعد auth. يتأكد أن المستخدم من قائمة الأدمن.
function requireAdmin(req, res, next) {
  const email = (req.user?.email || "").toLowerCase();
  if (!ADMIN_EMAILS.has(email)) return res.status(403).json({ error: "NOT_ADMIN" });
  next();
}

app.post("/api/signup", authLimiter, async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: "MISSING_FIELDS" });
  const key = String(email).trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(key)) return res.status(400).json({ error: "INVALID_EMAIL" });
  if (isDisposable(key)) return res.status(400).json({ error: "DISPOSABLE_EMAIL" });
  if (await getUser(key)) return res.status(409).json({ error: "EMAIL_EXISTS" });

  const passHash = await bcrypt.hash(password, 10);
  const verifyToken = crypto.randomBytes(24).toString("hex");
  await createUser({ name: name.trim(), email: key, passHash, credits: 0, verified: false, verifyToken });

  const link = `${APP_URL}/api/verify?token=${verifyToken}`;
  try { await sendVerifyEmail(key, link); } catch (e) { console.error("mail error", e?.message); }

  res.json({ pending: true, message: "VERIFY_EMAIL_SENT" });
});

app.get("/api/verify", async (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).send("رابط غير صالح");
  const u = await getUserByVerifyToken(String(token));
  if (!u) return res.status(400).send("رابط منتهٍ أو غير صالح");
  if (u.verified) return res.send("تم تأكيد بريدك مسبقاً. يمكنك تسجيل الدخول.");
  await updateUser(u.email, { verified: true, verifyToken: null, credits: FREE_CREDITS });
  res.send("تم تأكيد بريدك بنجاح ✓ — حصلت على تجربتك المجانية. يمكنك الآن تسجيل الدخول.");
});

app.post("/api/login", authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "MISSING_FIELDS" });
  const u = await getUser(String(email).trim().toLowerCase());
  if (!u || !(await bcrypt.compare(password, u.passHash)))
    return res.status(401).json({ error: "BAD_CREDENTIALS" });
  if (!u.verified) return res.status(403).json({ error: "EMAIL_NOT_VERIFIED" });
  res.json({ token: sign(u), user: publicUser(u) });
});

app.get("/api/me", auth, (req, res) => res.json({ user: publicUser(req.user) }));

// تحديث الملف الشخصي: الاسم و/أو كلمة المرور.
// لتغيير كلمة المرور يجب إرسال كلمة المرور الحالية الصحيحة (حماية).
app.post("/api/profile", auth, async (req, res) => {
  const { name, currentPassword, newPassword } = req.body || {};
  const patch = {};

  // تغيير الاسم (اختياري)
  if (typeof name === "string" && name.trim()) {
    if (name.trim().length < 2) return res.status(400).json({ error: "NAME_TOO_SHORT" });
    patch.name = name.trim();
  }

  // تغيير كلمة المرور (اختياري) — يتطلب كلمة المرور الحالية
  if (newPassword) {
    if (!currentPassword) return res.status(400).json({ error: "CURRENT_PASSWORD_REQUIRED" });
    const ok = await bcrypt.compare(currentPassword, req.user.passHash);
    if (!ok) return res.status(403).json({ error: "WRONG_CURRENT_PASSWORD" });
    if (String(newPassword).length < 6) return res.status(400).json({ error: "PASSWORD_TOO_SHORT" });
    patch.passHash = await bcrypt.hash(newPassword, 10);
  }

  if (!Object.keys(patch).length) return res.status(400).json({ error: "NOTHING_TO_UPDATE" });

  const updated = await updateUser(req.user.email, patch);
  // إصدار توكن جديد (لأن الاسم قد يكون تغيّر)
  res.json({ token: sign(updated), user: publicUser(updated) });
});

app.post("/api/enhance", auth, aiLimiter, async (req, res) => {
  const { prompt, mode = "image", styleEn = "" } = req.body || {};
  if (!prompt) return res.status(400).json({ error: "NO_PROMPT" });
  const sys =
    `You are an expert prompt engineer for AI ${mode === "video" ? "video" : "image"} generation. ` +
    `The user writes an idea in ANY language — auto-detect it and rewrite it as ONE rich, vivid English ` +
    `generation prompt with concrete subject, composition, lighting, mood, color, lens/camera` +
    (mode === "video" ? ", and camera motion" : "") +
    `. Incorporate this style: '${styleEn}'. Return ONLY the final English prompt.`;
  try {
    const msg = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{ role: "user", content: sys + "\n\nThe idea: " + prompt }],
    });
    const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    res.json({ enhanced: text });
  } catch (e) {
    res.status(502).json({ error: "ENHANCE_FAILED", detail: String(e?.message || e) });
  }
});

app.post("/api/generate", auth, aiLimiter, async (req, res) => {
  const { mode = "image", model = "veo3.1", prompt, promptRaw, promptEn, ratio = "9:16", duration = 5, count = 1 } = req.body || {};
  if (!prompt) return res.status(400).json({ error: "NO_PROMPT" });

  const n = Math.max(1, Math.min(mode === "video" ? 2 : 4, Number(count)));
  const dur = Math.max(3, Math.min(15, Number(duration)));
  const cost = mode === "video" ? n * dur : n;

  if ((req.user.credits ?? 0) < cost)
    return res.status(402).json({ error: "INSUFFICIENT_CREDITS", credits: req.user.credits, cost });

  try {
    let outputs = [];
    if (mode === "video") {
      const useModel = req.user.subscribed ? model : FREE_MODEL;
      const endpoint = VIDEO_ENDPOINTS[useModel] || VIDEO_ENDPOINTS[FREE_MODEL];
      const r = await fal.subscribe(endpoint, {
        input: { prompt, aspect_ratio: ratio, duration: dur },
      });
      const v = r?.data?.video?.url || r?.data?.url;
      outputs = v ? [v] : [];
    } else {
      const r = await fal.subscribe(IMAGE_ENDPOINT, {
        input: { prompt, image_size: IMAGE_SIZE[ratio] || "portrait_16_9", num_images: n },
      });
      outputs = (r?.data?.images || []).map((im) => im.url).filter(Boolean);
    }

    if (!outputs.length) return res.status(502).json({ error: "NO_OUTPUT" });

    const creditsLeft = await addCredits(req.user.email, -cost);

    // حفظ الأعمال في الأرشيف تلقائياً (لا نوقف الرد إن فشل الحفظ)
    let saved = [];
    try {
      for (const url of outputs) {
        const c = await addCreation(req.user.email, {
          url, mode,
          prompt: promptRaw || null,   // الوصف الأصلي (بلغة المستخدم)
          promptEn: promptEn || prompt, // الوصف الإنجليزي المُرسل للتوليد
          ratio,
        });
        if (c) saved.push(c);
      }
    } catch (e) { console.error("archive save error", e?.message); }

    res.json({ outputs, cost, creditsLeft, saved });
  } catch (e) {
    res.status(502).json({ error: "GENERATION_FAILED", detail: String(e?.message || e) });
  }
});

// جلب أعمال المستخدم (الأرشيف) — الأحدث أولاً
app.get("/api/creations", auth, async (req, res) => {
  try {
    const items = await getCreations(req.user.email, 60);
    res.json({ creations: items });
  } catch (e) {
    res.status(500).json({ error: "LIST_FAILED", detail: String(e?.message || e) });
  }
});

// حذف عمل من الأرشيف (فقط لصاحبه)
app.delete("/api/creations/:id", auth, async (req, res) => {
  try {
    const ok = await deleteCreation(req.user.email, req.params.id);
    if (!ok) return res.status(404).json({ error: "NOT_FOUND" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "DELETE_FAILED", detail: String(e?.message || e) });
  }
});

// تنزيل آمن للملفات الناتجة (صور/فيديو) عبر الخادم — يضمن "الحفظ" بدل مجرّد الفتح،
// ويسمح فقط بجلب الملفات من نطاقات fal الموثوقة (حماية من إساءة الاستخدام).
app.get("/api/download", async (req, res) => {
  try {
    const fileUrl = String(req.query.url || "");
    const rawName = String(req.query.name || "tayf");
    const safeName = rawName.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 60) || "tayf";
    if (!fileUrl) return res.status(400).send("NO_URL");

    let u;
    try { u = new URL(fileUrl); } catch { return res.status(400).send("BAD_URL"); }
    const host = u.hostname.toLowerCase();
    const allowedHost =
      host === "fal.media" || host.endsWith(".fal.media") ||
      host === "fal.run" || host.endsWith(".fal.run") ||
      host.endsWith(".fal.ai") ||
      host.endsWith(".storage.googleapis.com");
    if (u.protocol !== "https:" || !allowedHost) return res.status(403).send("FORBIDDEN_HOST");

    const upstream = await fetch(fileUrl);
    if (!upstream.ok) return res.status(502).send("FETCH_FAILED");

    const ct = upstream.headers.get("content-type") || "application/octet-stream";
    const ext =
      ct.includes("mp4") || ct.includes("video") ? "mp4" :
      ct.includes("png") ? "png" :
      ct.includes("webp") ? "webp" :
      ct.includes("jpeg") || ct.includes("jpg") ? "jpg" : "";
    const filename = ext ? `${safeName}.${ext}` : safeName;

    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader("Content-Type", ct);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", buf.length);
    res.send(buf);
  } catch (e) {
    res.status(500).send("DOWNLOAD_ERROR");
  }
});

// ================= نقاط لوحة الأدمن =================
// كلها محمية: auth أولاً (تسجيل دخول صحيح) ثم requireAdmin (إيميل أدمن).

// التحقق: هل المستخدم الحالي أدمن؟ (تستخدمها الواجهة لإظهار/إخفاء زر اللوحة)
app.get("/api/admin/check", auth, (req, res) => {
  const isAdmin = ADMIN_EMAILS.has((req.user.email || "").toLowerCase());
  res.json({ isAdmin });
});

// إحصائيات عامة
app.get("/api/admin/stats", auth, requireAdmin, async (_req, res) => {
  try {
    const stats = await adminGetStats();
    res.json({ stats });
  } catch (e) {
    res.status(500).json({ error: "STATS_FAILED", detail: String(e?.message || e) });
  }
});

// قائمة كل المستخدمين
app.get("/api/admin/users", auth, requireAdmin, async (_req, res) => {
  try {
    const users = await adminGetAllUsers();
    res.json({ users });
  } catch (e) {
    res.status(500).json({ error: "USERS_FAILED", detail: String(e?.message || e) });
  }
});

// تعديل رصيد مستخدم: إما إضافة (delta) أو تعيين قيمة (set)
app.post("/api/admin/credits", auth, requireAdmin, async (req, res) => {
  const { email, delta, set } = req.body || {};
  if (!email) return res.status(400).json({ error: "MISSING_EMAIL" });
  const target = String(email).trim().toLowerCase();
  const u = await getUser(target);
  if (!u) return res.status(404).json({ error: "USER_NOT_FOUND" });
  try {
    let credits;
    if (typeof set === "number") {
      credits = await setCredits(target, Math.round(set));
    } else if (typeof delta === "number") {
      credits = await addCredits(target, Math.round(delta));
    } else {
      return res.status(400).json({ error: "NO_AMOUNT" });
    }
    res.json({ ok: true, email: target, credits });
  } catch (e) {
    res.status(500).json({ error: "CREDITS_FAILED", detail: String(e?.message || e) });
  }
});

// تبديل حالة الاشتراك لمستخدم
app.post("/api/admin/subscribe", auth, requireAdmin, async (req, res) => {
  const { email, subscribed } = req.body || {};
  if (!email) return res.status(400).json({ error: "MISSING_EMAIL" });
  const target = String(email).trim().toLowerCase();
  const u = await getUser(target);
  if (!u) return res.status(404).json({ error: "USER_NOT_FOUND" });
  try {
    const updated = await updateUser(target, { subscribed: !!subscribed });
    res.json({ ok: true, email: target, subscribed: updated.subscribed });
  } catch (e) {
    res.status(500).json({ error: "SUBSCRIBE_FAILED", detail: String(e?.message || e) });
  }
});

// حذف مستخدم نهائياً (مع أعماله). لا يمكن للأدمن حذف نفسه (حماية).
app.delete("/api/admin/users/:email", auth, requireAdmin, async (req, res) => {
  const target = String(req.params.email || "").trim().toLowerCase();
  if (!target) return res.status(400).json({ error: "MISSING_EMAIL" });
  if (ADMIN_EMAILS.has(target)) return res.status(403).json({ error: "CANNOT_DELETE_ADMIN" });
  try {
    const ok = await adminDeleteUser(target);
    if (!ok) return res.status(404).json({ error: "USER_NOT_FOUND" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "DELETE_FAILED", detail: String(e?.message || e) });
  }
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`طيف backend on http://localhost:${PORT}`));
