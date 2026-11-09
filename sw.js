// =============================================================
// サービスワーカー：アプリの画面をスマホに保存して、すぐ開けるようにする
// バージョンは version.js で管理（数字を上げるとスマホ側も更新されます）
// =============================================================
importScripts("version.js");
const APP_CACHE = "app-" + self.APP_VERSION;
const FILES = [
  "./", "index.html", "style.css", "config.js", "version.js", "manifest.webmanifest",
  "js/app.js", "js/drive.js", "js/parsers.js", "js/fiscal.js",
  "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(APP_CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: "reload" })))));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k.startsWith("app-") && k !== APP_CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Androidの「共有」で送られてきたファイルを一時保存して、アプリ画面へ
  if (e.request.method === "POST" && url.pathname.endsWith("/share-target")) {
    e.respondWith((async () => {
      const form = await e.request.formData();
      const cache = await caches.open("shared-files");
      for (const file of form.getAll("files")) {
        const key = `./shared/${crypto.randomUUID()}?name=${encodeURIComponent(file.name)}`;
        await cache.put(key, new Response(file, { headers: { "content-type": file.type } }));
      }
      return Response.redirect("./?shared=1", 303);
    })());
    return;
  }

  // 自分のサイトのファイルだけキャッシュ（Google API の通信は素通し）
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // 通信できればいつも最新（cache:"no-cache" でブラウザの古い保存を使わない）、
  // できなければ保存しておいた画面を表示。古いファイルと新しいファイルが混ざるのを防ぎます。
  e.respondWith(
    fetch(e.request.url, { cache: "no-cache" })
      .then((res) => {
        const copy = res.clone();
        caches.open(APP_CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
