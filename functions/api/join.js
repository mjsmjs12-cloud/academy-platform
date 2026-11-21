// functions/api/join.js: رمز دخول قصير للموقع يربط الجهاز بعائلة دون كتابة الرابط الكامل
// POST {action:'set', f, code}  ينشئ الرمز للعائلة ويلغي الرمز السابق لها (يتطلب معرّف العائلة f)
// POST {action:'revoke', f}      يلغي الرمز الحالي للعائلة
// POST {action:'join', code}     يعيد معرّف العائلة f لمن يكتب الرمز الصحيح (مع حد للمحاولات الخاطئة)
// المتغيرات (Secrets في Cloudflare): KV_REST_API_URL و KV_REST_API_TOKEN (أو UPSTASH_REDIS_REST_*)

const FAMILY_RE = /^[a-f0-9]{32}$/;
const CODE_RE = /^[a-hj-np-z2-9]{10}$/;   // بعد التطبيع: 10 أحرف بلا أحرف ملتبسة
const MAX_FAILS = 10;                       // أقصى محاولات خاطئة لكل جهاز خلال 15 دقيقة
const FAIL_TTL = 900;

const JSON_TYPE = 'application/json; charset=utf-8';
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': JSON_TYPE, 'Cache-Control': 'no-store' } });

async function sha(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// أوامر Upstash REST كمسارات
async function kv(cfg, ...parts) {
  const path = parts.map(x => encodeURIComponent(String(x))).join('/');
  const r = await fetch(cfg.url + '/' + path, { headers: { Authorization: 'Bearer ' + cfg.token } });
  if (!r.ok) throw new Error('kv ' + r.status);
  return (await r.json()).result;
}

// تطبيع الرمز: أحرف صغيرة بلا فراغات أو شرطات، فيقبل الرمز المكتوب بأي شكل
const normCode = c => String(c || '').toLowerCase().replace(/[^a-z0-9]/g, '');

export async function onRequest(context) {
  const { request, env } = context;
  const cfg = { url: env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL, token: env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN };
  if (!cfg.url || !cfg.token) return json({ error: 'التخزين السحابي غير مربوط بالمشروع' }, 503);
  if (request.method !== 'POST') return json({ error: 'الطريقة غير مسموحة' }, 405);

  let body = {};
  try { body = await request.json(); } catch (e) { body = {}; }
  const action = String(body.action || '');

  try {
    if (action === 'join') {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const failKey = 'joinfail:' + (await sha(ip));
      const fails = Number(await kv(cfg, 'get', failKey) || 0);
      if (fails >= MAX_FAILS) return json({ error: 'محاولات كثيرة، حاولي بعد 15 دقيقة' }, 429);
      const code = normCode(body.code);
      const f = CODE_RE.test(code) ? await kv(cfg, 'get', 'join:' + await sha(code)) : null;
      if (!f) {
        const n = Number(await kv(cfg, 'incr', failKey));
        if (n === 1) await kv(cfg, 'expire', failKey, FAIL_TTL);
        return json({ error: 'الرمز غير صحيح' }, 400);
      }
      return json({ f });
    }

    const f = String(body.f || '');
    if (!FAMILY_RE.test(f)) return json({ error: 'رابط غير صالح' }, 400);
    const raw = await kv(cfg, 'get', 'family:' + f);
    if (!raw) return json({ error: 'لا توجد بيانات لهذا الرابط' }, 404);

    // نتحقق من الرمز الجديد قبل إلغاء السابق، حتى لا تُفقد العائلة رمزها بسبب خطأ
    const newCode = action === 'set' ? normCode(body.code) : '';
    if (action === 'set' && !CODE_RE.test(newCode)) return json({ error: 'الرمز غير صالح' }, 400);

    // إلغاء الرمز السابق للعائلة قبل أي تغيير
    const prev = await kv(cfg, 'get', 'joinof:' + f);
    if (prev) await kv(cfg, 'del', 'join:' + prev);

    if (action === 'revoke') {
      await kv(cfg, 'del', 'joinof:' + f);
      return json({ ok: true });
    }
    if (action === 'set') {
      const h = await sha(newCode);
      await kv(cfg, 'set', 'join:' + h, f);
      await kv(cfg, 'set', 'joinof:' + f, h);
      return json({ ok: true });
    }
    return json({ error: 'طلب غير معروف' }, 400);
  } catch (e) {
    return json({ error: 'خطأ في الخادم' }, 500);
  }
}
