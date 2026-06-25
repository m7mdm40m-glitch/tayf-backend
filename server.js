import "dotenv/config";
import crypto from "crypto";
import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import nodemailer from "nodemailer";
import Anthropic from "@anthropic-ai/sdk";
import { fal } from "@fal-ai/client";
import { getUser, createUser, addCredits, updateUser, getUserByVerifyToken } from "./store.js";

const PORT = process.env.PORT || 8787;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const FREE_CREDITS = Number(process.env.FREE_CREDITS || 3);
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

fal.config({ credentials: process.env.FAL_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---- حظر خدمات البريد المؤقت ----
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

// ---- إرسال بريد التأكيد (يستخدم SMTP إن وُجد، وإلا يطبع الرابط للتطوير) ----
let mailer = null;
if (process.env.SMTP_HOST) {
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}
async function sendVerifyEmail(email, link) {
  if (!mailer) {
    console.log(`\n[تأكيد البريد] أرسل هذا الرابط إلى ${email}:\n${link}\n`);
    return;
  }
  await mailer.sendMail({
    from: process.env.SMTP_FROM || "Tayf <no-reply@tayf.app>",
    to: email,
    subject: "أكّد بريدك لتفعيل تجربتك المجانية في طيف",
    html: `<p>مرحباً،</p><p>اضغط الرابط لتفعيل حسابك والحصول على تجربتك المجانية:</p>
           <p><a href="${link}">${link}</a></p>`,
  });
}

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.CLIENT_ORIGIN || "*" }));

// ---- خرائط النماذج على fal.ai (راجع صفحة كل نموذج للمعاملات الدقيقة) ----
const VIDEO_ENDPOINTS = {
  "kling26": "fal-ai/kling-video/v2.6/pro/text-to-video",
  "veo3.1": "fal-ai/veo3.1/text-to-video",
  "kling3": "fal-ai/kling-video/v3.0/text-to-video",
  "seedance2": "fal-ai/bytedance/seedance-v2/text-to-video",
};
const IMAGE_ENDPOINT = "fal-ai/flux/dev";

// نموذج التجربة المجانية (الأرخص) — غير المشتركين مقيّدون به
const FREE_MODEL = "kling26";

// نِسب الأبعاد إلى مقاسات الصور
const IMAGE_SIZE = {
  "9:16": "portrait_16_9",
  "1:1": "square_hd",
  "16:9": "landscape_16_9",
  "4:5": "portrait_4_3",
};

// ---- أدوات المصادقة ----
function sign(user) {
  return jwt.sign({ email: user.email, name: user.name }, JWT_SECRET, { expiresIn: "30d" });
}
function publicUser(u) {
  return { name: u.name, email: u.email, credits: u.credits };
}
function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "NO_TOKEN" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const u = getUser(payload.email);
    if (!u) return res.status(401).json({ error: "NO_USER" });
    req.user = u;
    next();
  } catch {
    return res.status(401).json({ error: "BAD_TOKEN" });
  }
}

// ---- إنشاء حساب: يرفض البريد المؤقت ويتطلب تأكيداً قبل منح الرصيد ----
app.post("/api/signup", async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: "MISSING_FIELDS" });
  const key = String(email).trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(key)) return res.status(400).json({ error: "INVALID_EMAIL" });
  if (isDisposable(key)) return res.status(400).json({ error: "DISPOSABLE_EMAIL" });
  if (getUser(key)) return res.status(409).json({ error: "EMAIL_EXISTS" });

  const passHash = await bcrypt.hash(password, 10);
  const verifyToken = crypto.randomBytes(24).toString("hex");
  // الحساب يبدأ غير مفعّل وبرصيد صفر — الرصيد المجاني يُمنح بعد التأكيد فقط
  createUser({ name: name.trim(), email: key, passHash, credits: 0, verified: false, verifyToken });

  const link = `${APP_URL}/api/verify?token=${verifyToken}`;
  try { await sendVerifyEmail(key, link); } catch (e) { console.error("mail error", e?.message); }

  res.json({ pending: true, message: "VERIFY_EMAIL_SENT" });
});

// ---- تأكيد البريد: يفعّل الحساب ويمنح الرصيد المجاني مرة واحدة ----
app.get("/api/verify", (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).send("رابط غير صالح");
  const u = getUserByVerifyToken(String(token));
  if (!u) return res.status(400).send("رابط منتهٍ أو غير صالح");
  if (u.verified) return res.send("تم تأكيد بريدك مسبقاً. يمكنك تسجيل الدخول.");
  updateUser(u.email, { verified: true, verifyToken: null, credits: FREE_CREDITS });
  res.send("تم تأكيد بريدك بنجاح ✓ — حصلت على تجربتك المجانية. يمكنك الآن تسجيل الدخول.");
});

// ---- تسجيل الدخول ----
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "MISSING_FIELDS" });
  const u = getUser(String(email).trim().toLowerCase());
  if (!u || !(await bcrypt.compare(password, u.passHash)))
    return res.status(401).json({ error: "BAD_CREDENTIALS" });
  if (!u.verified) return res.status(403).json({ error: "EMAIL_NOT_VERIFIED" });
  res.json({ token: sign(u), user: publicUser(u) });
});

// ---- بيانات المستخدم الحالي (الرصيد) ----
app.get("/api/me", auth, (req, res) => res.json({ user: publicUser(req.user) }));

// ---- تحسين الوصف بالذكاء الاصطناعي (يفهم أي لغة) ----
app.post("/api/enhance", async (req, res) => {
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

// ---- التوليد الفعلي: يحسب التكلفة، يخصم الرصيد، يستدعي fal.ai ----
app.post("/api/generate", auth, async (req, res) => {
  const { mode = "image", model = "veo3.1", prompt, ratio = "9:16", duration = 5, count = 1 } = req.body || {};
  if (!prompt) return res.status(400).json({ error: "NO_PROMPT" });

  const n = Math.max(1, Math.min(mode === "video" ? 2 : 4, Number(count)));
  const dur = Math.max(3, Math.min(15, Number(duration)));
  // التكلفة: كل ثانية فيديو = عملة، كل صورة = عملة
  const cost = mode === "video" ? n * dur : n;

  if ((req.user.credits ?? 0) < cost)
    return res.status(402).json({ error: "INSUFFICIENT_CREDITS", credits: req.user.credits, cost });

  try {
    let outputs = [];
    if (mode === "video") {
      // غير المشتركين مقيّدون بالنموذج الأرخص
      const useModel = req.user.subscribed ? model : FREE_MODEL;
      const endpoint = VIDEO_ENDPOINTS[useModel] || VIDEO_ENDPOINTS[FREE_MODEL];
      // ملاحظة: أسماء معاملات الإدخال تختلف بين النماذج — راجع صفحة النموذج على fal.ai
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

    // الخصم بعد نجاح التوليد فقط
    const creditsLeft = addCredits(req.user.email, -cost);
    res.json({ outputs, cost, creditsLeft });
  } catch (e) {
    res.status(502).json({ error: "GENERATION_FAILED", detail: String(e?.message || e) });
  }
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`طيف backend on http://localhost:${PORT}`));
