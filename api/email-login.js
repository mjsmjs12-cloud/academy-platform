// api/email-login.js: يرسل رمز دخول إلى بريد الطفلة ثم يتحقق منه
// المتغيرات المطلوبة: متجر Upstash (كما في api/family.js)، و RESEND_API_KEY، و MAIL_FROM مثل "أكاديمية <login@your-domain.com>"
const crypto = require('crypto');
const FAMILY_RE = /^[a-f0-9]{32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_TTL = 600;   // صلاحية الرمز: 10 دقائق
const MAX_SENDS = 3;    // أقصى عدد رسائل لكل بريد خلال 15 دقيقة
const MAX_TRIES = 5;    // أقصى عدد محاولات تحقق لكل رمز

const kvUrl = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const kvToken = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

// أوامر Upstash REST كمسارات: /get/key و /incr/key و /set/key/value/EX/600
async function kv(...parts) {
  const path = parts.map(x => encodeURIComponent(String(x))).join('/');
  const r = await fetch(kvUrl() + '/' + path, { headers: { Authorization: 'Bearer ' + kvToken() } });
  if (!r.ok) throw new Error('kv ' + r.status);
  return (await r.json()).result;
}

// إرسال الرسالة عبر Resend
async function sendCode(to, code) {
  const key = process.env.RESEND_API_KEY, from = process.env.MAIL_FROM;
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

module.exports = async (req, res) => {
  if (!kvUrl() || !kvToken()) return res.status(503).json({ error: 'التخزين السحابي غير مربوط بالمشروع' });
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'الطريقة غير مسموحة' }); }
  let body = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const f = String(body.f || ''), email = String(body.email || '').trim().toLowerCase();
  const action = String((req.query && req.query.action) || '');
  if (!FAMILY_RE.test(f)) return res.status(400).json({ error: 'رابط غير صالح' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'بريد غير صالح' });
  try {
    const raw = await kv('get', 'family:' + f);
    if (!raw) return res.status(404).json({ error: 'لا توجد بيانات لهذا الرابط' });
    const data = JSON.parse(raw);
    if (!data.settings || data.settings.emailLogin !== 'on') return res.status(403).json({ error: 'الدخول بالبريد غير مفعّل' });
    const child = (data.children || []).find(c => String(c.email || '').trim().toLowerCase() === email);
    const id = sha(f + ':' + email);

    if (action === 'send') {
      const sends = Number(await kv('incr', 'otpsend:' + id));
      if (sends === 1) await kv('expire', 'otpsend:' + id, 900);
      if (sends > MAX_SENDS) return res.status(429).json({ error: 'طلبات كثيرة، حاولي بعد 15 دقيقة' });
      // الرد واحد سواء كان البريد مسجلاً أم لا، حتى لا يُكشف ما هو مسجّل
      if (child) {
        const code = String(crypto.randomInt(100000, 1000000));
        await kv('set', 'otp:' + id, sha(f + email + code), 'EX', CODE_TTL);
        await kv('del', 'otptry:' + id);
        await sendCode(email, code);
      }
      return res.status(200).json({ ok: true });
    }

    if (action === 'verify') {
      const tries = Number(await kv('incr', 'otptry:' + id));
      if (tries === 1) await kv('expire', 'otptry:' + id, CODE_TTL);
      if (tries > MAX_TRIES) return res.status(429).json({ error: 'تجاوزت عدد المحاولات، اطلبي رمزاً جديداً' });
      const saved = await kv('get', 'otp:' + id);
      if (!saved || !child) return res.status(400).json({ error: 'انتهت صلاحية الرمز، اطلبي رمزاً جديداً' });
      const code = String(body.code || '').trim();
      if (saved !== sha(f + email + code)) return res.status(400).json({ error: 'الرمز غير صحيح' });
      await kv('del', 'otp:' + id); await kv('del', 'otptry:' + id); await kv('del', 'otpsend:' + id);
      return res.status(200).json({ ok: true, childId: child.id });
    }
    return res.status(400).json({ error: 'طلب غير معروف' });
  } catch (e) {
    if (e.status === 503) return res.status(503).json({ error: 'خدمة إرسال البريد غير مربوطة بالمشروع' });
    if (e.status === 502) return res.status(502).json({ error: 'تعذّر إرسال الرسالة، حاولي لاحقاً' });
    return res.status(500).json({ error: 'خطأ في الخادم' });
  }
};
