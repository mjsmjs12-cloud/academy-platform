// Service Worker لأكاديمية أبو نصره
// الصفحة الرئيسية: الشبكة أولاً (لتصل التحديثات فوراً)، والذاكرة المؤقتة عند انقطاع الاتصال
// باقي الملفات: الذاكرة المؤقتة أولاً (أسرع، وتتغير بتغيير اسم الإصدار)
const CACHE = 'academy-app';            // اسم ثابت: التحديث يستبدل الملف نفسه ولا يُنشئ نسخة جديدة
const PAGE = './index.html';
const SHELL = [PAGE, './manifest.json', './icon.svg', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  // حذف الإصدارات القديمة من الذاكرة المؤقتة
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  // واجهات الخادم تُطلب دائماً من الشبكة حتى لا تُقرأ بيانات قديمة من الذاكرة
  if (new URL(req.url).pathname.startsWith('/api/')) return;
  const isPage = req.mode === 'navigate' || /\.html(\?|$)/.test(req.url);
  if (isPage) {
    e.respondWith(fetch(req).then(res => {
      if (res && res.status === 200) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then(hit => hit || caches.match(PAGE))));
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
    if (res && res.status === 200) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  })));
});
