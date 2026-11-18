// api/family.js: يحفظ بيانات الأكاديمية لعائلة واحدة في Vercel KV (Upstash)
// المعرّف السري (f) هو الرابط نفسه، ولا يصل إليه إلا من يملكه.
// المتغيّران KV_REST_API_URL و KV_REST_API_TOKEN يضيفهما Vercel عند ربط متجر KV بالمشروع.
const MAX_BYTES = 900 * 1024;     // حد أعلى لحجم البيانات (قيمة KV)
const FAMILY_RE = /^[a-f0-9]{32}$/;

// أسماء المتغيرات: تكفي إحدى المجموعتين (KV القديمة، أو Upstash Redis من سوق Vercel)
const kvUrl = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const kvToken = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function kv(path, method, body) {
  const url = kvUrl(), token = kvToken();
  const r = await fetch(url + path, { method, headers: { Authorization: 'Bearer ' + token }, body });
  if (!r.ok) throw new Error('kv ' + r.status);
  return r.json();
}

module.exports = async (req, res) => {
  // تحقّق من ربط التخزين، وإلا يظهر خطأ واضح بدل فشل صامت
  if (!kvUrl() || !kvToken()) {
    return res.status(503).json({ error: 'التخزين السحابي غير مربوط بالمشروع' });
  }
  const f = String((req.query && req.query.f) || '');
  if (!FAMILY_RE.test(f)) return res.status(400).json({ error: 'رابط غير صالح' });
  const key = encodeURIComponent('family:' + f);
  try {
    if (req.method === 'GET') {
      const out = await kv('/get/' + key, 'GET');
      if (out.result === null || out.result === undefined) return res.status(404).json({ error: 'لا توجد بيانات لهذا الرابط' });
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.status(200).send(out.result);
    }
    if (req.method === 'PUT') {
      const text = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
      if (Buffer.byteLength(text) > MAX_BYTES) return res.status(413).json({ error: 'البيانات أكبر من الحد المسموح' });
      let parsed;
      try { parsed = JSON.parse(text); } catch (e) { return res.status(400).json({ error: 'بيانات غير صالحة' }); }
      if (!parsed || !Array.isArray(parsed.children)) return res.status(400).json({ error: 'بيانات غير صالحة' });
      await kv('/set/' + key, 'POST', text);
      return res.status(200).json({ ok: true });
    }
    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ error: 'الطريقة غير مسموحة' });
  } catch (e) {
    // سبب واضح: رمز الاستجابة من Upstash إن وُجد (مثل 401 = الرمز غير صحيح)
    const m = /^kv (\d{3})$/.exec(e.message || '');
    const why = m ? 'خطأ في التخزين السحابي (رمز ' + m[1] + ')' : 'خطأ في الخادم';
    return res.status(500).json({ error: why });
  }
};
