# خادم طيف الخلفي

خادم Node.js يحوّل واجهة طيف من معاينة إلى منتج حقيقي:
مصادقة آمنة (كلمات مرور مُعمّاة + جلسات JWT)، حساب الرصيد على الخادم،
وتوليد فعلي للصور والفيديو عبر fal.ai.

## ما تحتاجه أنت

- **Node.js 18+**
- **مفتاح fal.ai**: من https://fal.ai/dashboard/keys — يتطلب بطاقة، والتوليد مدفوع بالثانية.
- **مفتاح Anthropic** (اختياري، لتحسين الوصف): من https://console.anthropic.com/

لا يمكنني إنشاء هذه الحسابات أو إدخال بيانات الدفع نيابةً عنك؛ أنشئها بنفسك ثم ضع المفاتيح في `.env`.

## التشغيل

```bash
cd tayf-backend
npm install
cp .env.example .env      # ثم املأ FAL_KEY و JWT_SECRET
npm start
```

يعمل الخادم على `http://localhost:8787`. تحقّق: `GET /api/health`.

## نقاط النهاية

| الطريقة | المسار | الوظيفة |
|--------|--------|---------|
| POST | `/api/signup` | إنشاء حساب + منح الرصيد المجاني (10) |
| POST | `/api/login` | تسجيل الدخول، يعيد JWT |
| GET  | `/api/me` | بيانات المستخدم والرصيد (يتطلب توكن) |
| POST | `/api/enhance` | تحسين الوصف بالذكاء الاصطناعي |
| POST | `/api/generate` | التوليد: يحسب التكلفة، يخصم الرصيد، يستدعي fal.ai |

التكلفة محسوبة على الخادم: **كل ثانية فيديو = عملة، كل صورة = عملة**. الخصم يحدث بعد نجاح التوليد فقط.

## ربط الواجهة (tayf-studio.jsx)

استبدل المنطق التجريبي داخل المتصفّح باستدعاءات الخادم:

```js
const API = "http://localhost:8787";

// تسجيل الدخول / إنشاء حساب
async function apiAuth(mode, body) {
  const r = await fetch(`${API}/api/${mode === "signup" ? "signup" : "login"}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw await r.json();
  const { token, user } = await r.json();
  localStorage.setItem("tayf_token", token); // أو في الذاكرة حسب بيئتك
  return user;
}

// التوليد الفعلي
async function apiGenerate(payload) {
  const r = await fetch(`${API}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json",
      Authorization: `Bearer ${localStorage.getItem("tayf_token")}` },
    body: JSON.stringify(payload),
  });
  if (r.status === 402) throw { code: "INSUFFICIENT_CREDITS" }; // اعرض الاشتراك
  if (!r.ok) throw await r.json();
  return r.json(); // { outputs:[urls], cost, creditsLeft }
}
```

ثم اعرض الروابط الناتجة في بطاقات النتائج بدل المربعات التوضيحية، وحدّث الرصيد من `creditsLeft`.

## ملاحظات مهمة

- **معاملات إدخال fal.ai تختلف بين النماذج.** راجع صفحة كل نموذج على fal.ai
  (Veo / Kling / Seedance / Flux) واضبط الحقول في `server.js` (`aspect_ratio`, `duration`, `num_images`...).
- **مخزن البيانات هنا ملف JSON للبداية فقط.** للإنتاج استخدم Postgres أو Supabase
  مع معاملات ذرّية على الرصيد لمنع التحايل عند التزامن.
- **الدفع**: عند نفاد الرصيد أعِد المستخدم إلى Stripe Checkout، وبعد نجاح الدفع
  زِد الرصيد عبر webhook يستدعي `addCredits`.
- **الأمان**: لا تضع أي مفتاح في الواجهة. كل المفاتيح تبقى في `.env` على الخادم.
