// functions/api/email-login.js: نسخة Cloudflare Pages من api/email-login.js بالمنطق والمسار نفسهما (/api/email-login)
// يرسل رمز دخول إلى البريد ثم يتحقق منه. يدعم: دخول الطفل بالبريد، ودخول ولي الأمر بالبريد، وتسجيل ولي أمر جديد بالبريد
// المتغيرات (Secrets في Cloudflare): KV_REST_API_URL و KV_REST_API_TOKEN (أو UPSTASH_REDIS_REST_*)، و RESEND_API_KEY، و MAIL_FROM مثل "أكاديمية <login@your-domain.com>"

const FAMILY_RE = /^[a-f0-9]{32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_TTL = 600;   // صلاحية الرمز: 10 دقائق
const MAX_SENDS = 3;    // أقصى عدد رسائل لكل بريد خلال 15 دقيقة
const MAX_TRIES = 5;    // أقصى عدد محاولات تحقق لكل رمز

const JSON_TYPE = 'application/json; charset=utf-8';
const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': JSON_TYPE, ...headers } });

// تجزئة SHA-256 بصيغة Hex باستخدام Web Crypto (المتاح في Cloudflare Workers)
async function sha(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// رمز من 6 أرقام بلا انحياز: نعيد السحب إذا وقعت القيمة في الجزء غير المتساوٍ
function sixDigitCode() {
  const range = 900000, limit = Math.floor(0x100000000 / range) * range;
  for (;;) {
    const v = crypto.getRandomValues(new Uint32Array(1))[0];
    if (v < limit) return String(100000 + (v % range));
  }
}

// إعدادات التخزين: تكفي إحدى المجموعتين من المتغيرات
const kvConfig = env => ({
  url: env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL,
  token: env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN,
});

// أوامر Upstash REST كمسارات: /get/key و /incr/key و /set/key/value/EX/600
async function kv(cfg, ...parts) {
  const path = parts.map(x => encodeURIComponent(String(x))).join('/');
  const r = await fetch(cfg.url + '/' + path, { headers: { Authorization: 'Bearer ' + cfg.token } });
  if (!r.ok) throw new Error('kv ' + r.status);
  return (await r.json()).result;
}

// إرسال الرسالة عبر Resend
async function sendCode(env, to, code) {
  const key = env.RESEND_API_KEY, from = env.MAIL_FROM;
  if (!key || !from) { const e = new Error('mail-config'); e.status = 503; throw e; }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from, to: [to], subject: 'رمز الدخول إلى أكاديمية أبو نصره',
      html: `<div dir="rtl" style="font-family:sans-serif"><p>رمز الدخول:</p><p style="font-size:28px;letter-spacing:6px"><b>${code}</b></p><p>صالح لمدة 10 دقائق. إن لم تطلبي الرمز فتجاهليه.</p></div>`
    })
  });
  if (!r.ok) { const e = new Error('mail-send'); e.status = 502; throw e; }
}

const sameMail = (a, b) => String(a || '').trim().toLowerCase() === b;
// وكيل مفعّل: غير موقوف، وغير منتهية مدته
const agentActive = a => !a.off && (!a.until || a.until >= new Date().toISOString().slice(0, 10));

// يحدد الهدف حسب الغرض: الطفل أو ولي الأمر للدخول، ولا شيء للتسجيل (الهدف يُنشأ في التطبيق)
function resolveLogin(data, email) {
  const kid = (data.children || []).find(c => sameMail(c.email, email));
  if (kid) return { childId: kid.id };
  const ag = ((data.settings && data.settings.agents) || []).find(a => sameMail(a.email, email) && agentActive(a));
  if (ag) return { agentId: ag.id };
  return null;
}
// البريد مستخدم إن وُجد لدى طفل أو وكيل (حتى لو موقوف)
const emailUsed = (data, email) =>
  (data.children || []).some(c => sameMail(c.email, email)) ||
  ((data.settings && data.settings.agents) || []).some(a => sameMail(a.email, email));

export async function onRequest(context) {
  const { request, env } = context;
  const cfg = kvConfig(env);

  if (!cfg.url || !cfg.token) return json({ error: 'التخزين السحابي غير مربوط بالمشروع' }, 503);
  if (request.method !== 'POST') return json({ error: 'الطريقة غير مسموحة' }, 405, { Allow: 'POST' });

  let body = {};
  try { body = await request.json(); } catch (e) { body = {}; }
  if (!body || typeof body !== 'object') body = {};

  const url = new URL(request.url);
  const f = String(body.f || ''), email = String(body.email || '').trim().toLowerCase();
  const action = String(url.searchParams.get('action') || '');
  const purpose = body.purpose === 'register' ? 'register' : 'login';
  if (!FAMILY_RE.test(f)) return json({ error: 'رابط غير صالح' }, 400);
  if (!EMAIL_RE.test(email)) return json({ error: 'بريد غير صالح' }, 400);

  try {
    const raw = await kv(cfg, 'get', 'family:' + f);
    if (!raw) return json({ error: 'لا توجد بيانات لهذا الرابط' }, 404);
    const data = JSON.parse(raw);
    const settings = data.settings || {};
    const id = await sha(f + ':' + email);

    // الغرض "دخول": يتطلب تفعيل الدخول بالبريد. الغرض "تسجيل": يتطلب تفعيل تسجيل ولي الأمر
    if (purpose === 'login' && settings.emailLogin !== 'on') return json({ error: 'الدخول بالبريد غير مفعّل' }, 403);
    if (purpose === 'register' && settings.guardReg !== 'on') return json({ error: 'التسجيل بالبريد غير مفعّل' }, 403);
    if (purpose === 'register' && emailUsed(data, email)) return json({ error: 'هذا البريد مسجّل مسبقاً، استخدميه للدخول' }, 409);
    const target = purpose === 'login' ? resolveLogin(data, email) : { reg: true };

    if (action === 'send') {
      const sends = Number(await kv(cfg, 'incr', 'otpsend:' + id));
      if (sends === 1) await kv(cfg, 'expire', 'otpsend:' + id, 900);
      if (sends > MAX_SENDS) return json({ error: 'طلبات كثيرة، حاولي بعد 15 دقيقة' }, 429);
      // الرد واحد سواء كان البريد مسجلاً أم لا في الدخول، حتى لا يُكشف ما هو مسجّل
      if (target) {
        const code = sixDigitCode();
        await kv(cfg, 'set', 'otp:' + id, await sha(f + email + code), 'EX', CODE_TTL);
        await kv(cfg, 'del', 'otptry:' + id);
        await sendCode(env, email, code);
      }
      return json({ ok: true });
    }

    if (action === 'verify') {
      const tries = Number(await kv(cfg, 'incr', 'otptry:' + id));
      if (tries === 1) await kv(cfg, 'expire', 'otptry:' + id, CODE_TTL);
      if (tries > MAX_TRIES) return json({ error: 'تجاوزت عدد المحاولات، اطلبي رمزاً جديداً' }, 429);
      const saved = await kv(cfg, 'get', 'otp:' + id);
      if (!saved || !target) return json({ error: 'انتهت صلاحية الرمز، اطلبي رمزاً جديداً' }, 400);
      const code = String(body.code || '').trim();
      if (saved !== await sha(f + email + code)) return json({ error: 'الرمز غير صحيح' }, 400);
      await kv(cfg, 'del', 'otp:' + id); await kv(cfg, 'del', 'otptry:' + id); await kv(cfg, 'del', 'otpsend:' + id);
      return json(Object.assign({ ok: true }, target));
    }
    return json({ error: 'طلب غير معروف' }, 400);
  } catch (e) {
    if (e.status === 503) return json({ error: 'خدمة إرسال البريد غير مربوطة بالمشروع' }, 503);
    if (e.status === 502) return json({ error: 'تعذّر إرسال الرسالة، حاولي لاحقاً' }, 502);
    return json({ error: 'خطأ في الخادم' }, 500);
  }
}
