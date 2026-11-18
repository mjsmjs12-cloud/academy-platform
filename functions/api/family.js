// functions/api/family.js: نسخة Cloudflare Pages من api/family.js بالمنطق والمسار نفسهما (/api/family)
// يحفظ بيانات الأكاديمية لعائلة واحدة في Upstash Redis عبر REST
// المعرّف السري (f) هو الرابط نفسه، ولا يصل إليه إلا من يملكه.
// المتغيرات (Secrets في Cloudflare): KV_REST_API_URL و KV_REST_API_TOKEN، أو UPSTASH_REDIS_REST_URL و UPSTASH_REDIS_REST_TOKEN

const MAX_BYTES = 900 * 1024;     // حد أعلى لحجم البيانات (قيمة KV)
const FAMILY_RE = /^[a-f0-9]{32}$/;
const VOICE_RE = /^chat_[a-z0-9]{1,20}$/;  // مفتاح الرسالة الصوتية كما يُنشأ على الجهاز
const VOICE_MAX = 400 * 1024;              // حد الصوت بعد ترميزه Base64 (نحو 30 ثانية)
const VOICE_TTL = 24 * 60 * 60;            // ثوانٍ: الصوت يُحذف بعد 24 ساعة لتوفير المساحة

const JSON_TYPE = 'application/json; charset=utf-8';
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': JSON_TYPE } });
// رد خام بنص JSON المخزَّن كما هو، بدون تخزين مؤقت
const raw = text => new Response(text, { status: 200, headers: { 'Content-Type': JSON_TYPE, 'Cache-Control': 'no-store' } });
const methodNotAllowed = () => new Response(JSON.stringify({ error: 'الطريقة غير مسموحة' }), { status: 405, headers: { 'Content-Type': JSON_TYPE, Allow: 'GET, PUT' } });

// إعدادات التخزين: تكفي إحدى المجموعتين من المتغيرات
function kvConfig(env) {
  return {
    url: env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL,
    token: env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN,
  };
}

// طلب إلى Upstash REST: يُرجع ردّه كما هو، ويرفع خطأ يحمل رمز الحالة
async function kv(cfg, path, method, body) {
  const r = await fetch(cfg.url + path, { method, headers: { Authorization: 'Bearer ' + cfg.token }, body });
  if (!r.ok) throw new Error('kv ' + r.status);
  return r.json();
}

// تخزين صوت رسالة واحدة (v) ضمن العائلة نفسها، ويُحذف تلقائياً بعد VOICE_TTL
async function voice(request, cfg, f, vk) {
  if (!VOICE_RE.test(vk)) return json({ error: 'مفتاح الصوت غير صالح' }, 400);
  const key = 'voice:' + f + ':' + vk;

  if (request.method === 'GET') {
    const out = await kv(cfg, '/get/' + encodeURIComponent(key), 'GET');
    if (out.result === null || out.result === undefined) return json({ error: 'الصوت غير موجود' }, 404);
    return raw(out.result);
  }
  if (request.method === 'PUT') {
    const text = await request.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { return json({ error: 'بيانات غير صالحة' }, 400); }
    if (!parsed || typeof parsed.d !== 'string' || !parsed.d || parsed.d.length > VOICE_MAX) {
      return json({ error: 'الصوت غير صالح أو أكبر من الحد المسموح' }, 413);
    }
    // أمر SET مع مدة صلاحية، يُرسل إلى جذر الخدمة بصيغة JSON
    await kv(cfg, '/', 'POST', JSON.stringify(['SET', key, text, 'EX', VOICE_TTL]));
    return json({ ok: true });
  }
  return methodNotAllowed();
}

export async function onRequest(context) {
  const { request, env } = context;
  const cfg = kvConfig(env);

  // تحقّق من ربط التخزين، وإلا يظهر خطأ واضح بدل فشل صامت
  if (!cfg.url || !cfg.token) {
    return json({ error: 'التخزين السحابي غير مربوط بالمشروع' }, 503);
  }

  const url = new URL(request.url);
  const f = String(url.searchParams.get('f') || '');
  if (!FAMILY_RE.test(f)) return json({ error: 'رابط غير صالح' }, 400);
  const vk = String(url.searchParams.get('v') || '');
  const key = encodeURIComponent('family:' + f);

  try {
    if (vk) return await voice(request, cfg, f, vk);

    if (request.method === 'GET') {
      const out = await kv(cfg, '/get/' + key, 'GET');
      if (out.result === null || out.result === undefined) return json({ error: 'لا توجد بيانات لهذا الرابط' }, 404);
      return raw(out.result);
    }
    if (request.method === 'PUT') {
      const text = await request.text();
      if (new TextEncoder().encode(text).length > MAX_BYTES) return json({ error: 'البيانات أكبر من الحد المسموح' }, 413);
      let parsed;
      try { parsed = JSON.parse(text); } catch (e) { return json({ error: 'بيانات غير صالحة' }, 400); }
      if (!parsed || !Array.isArray(parsed.children)) return json({ error: 'بيانات غير صالحة' }, 400);
      await kv(cfg, '/set/' + key, 'POST', text);
      return json({ ok: true });
    }
    return methodNotAllowed();
  } catch (e) {
    // سبب واضح: رمز الاستجابة من Upstash إن وُجد (مثل 401 = الرمز غير صحيح)
    const m = /^kv (\d{3})$/.exec(e.message || '');
    const why = m ? 'خطأ في التخزين السحابي (رمز ' + m[1] + ')' : 'خطأ في الخادم';
    return json({ error: why }, 500);
  }
}
