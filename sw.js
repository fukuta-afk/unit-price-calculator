/*
 * 単価比較電卓 sw.js
 * 更新時は VERSION と app.js の ASSET_VERSION、index.html の asset-version を必ず同時に上げる。
 * 自動 skipWaiting はしない（旧版が制御している間は旧版で動き、全画面を閉じて再起動すると新版へ移る）。
 */
'use strict';

var APP_ID = 'tanka-hikaku';
var VERSION = '1.0.2';

// 配置ディレクトリ（sw.js と同じ階層）を基準にする
var BASE_URL = new URL('./', self.location.href);
var BASE_PATH = BASE_URL.pathname;
var CACHE_PREFIX = APP_ID + '|' + encodeURIComponent(BASE_PATH) + '|';
var CACHE_NAME = CACHE_PREFIX + VERSION;
// 配信版をSWのプロセス寿命に依存させず、開いている画面の間は固定する。
var SESSION_CACHE = CACHE_PREFIX + 'session';
var SESSION_KEY = new URL('./', BASE_URL).href;

var ASSETS = ['./', './index.html', './app.js', './manifest.webmanifest', './icon.svg'];
var ASSET_URLS = ASSETS.map(function (p) { return new URL(p, BASE_URL).href; });
var ROOT_URL = new URL('./', BASE_URL).href;
var INDEX_URL = new URL('./index.html', BASE_URL).href;

// 版の一致を確かめる資産と、その中に含まれるべき版表記
function markersFor(version) {
  return [
    { url: ROOT_URL, text: 'name="asset-version" content="' + version + '"' },
    { url: INDEX_URL, text: 'name="asset-version" content="' + version + '"' },
    { url: new URL('./app.js', BASE_URL).href, text: "ASSET_VERSION = '" + version + "'" }
  ];
}

// ネットワーク応答の本文を先に読み切り、未読本文のまま次の取得を待たない。
// リダイレクト済み応答も、ナビゲーションに使えるResponseへ詰め直す。
function cleanResponse(res) {
  return res.blob().then(function (body) {
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  });
}

// 版表記の確認（install時の取得結果と、保存済みキャッシュの両方で使う）
// readText(url) は本文文字列の Promise を返す。version 省略時はこの版。
function versionMarkersOk(readText, version) {
  return Promise.all(markersFor(version || VERSION).map(function (m) {
    return Promise.resolve(readText(m.url)).then(function (t) {
      return typeof t === 'string' && t.indexOf(m.text) >= 0;
    });
  })).then(function (results) {
    return results.every(Boolean);
  });
}

// 必須資産をすべて取得し、成功応答と版の一致を確認する（保存はしない）
function fetchVerifiedAssets() {
  return Promise.all(ASSET_URLS.map(function (url) {
    return fetch(new Request(url, { cache: 'reload', credentials: 'same-origin' })).then(function (res) {
      if (!res || !res.ok || res.type !== 'basic') {
        throw new Error('asset fetch failed: ' + url);
      }
      return cleanResponse(res);
    });
  })).then(function (responses) {
    return versionMarkersOk(function (url) {
      return responses[ASSET_URLS.indexOf(url)].clone().text();
    }).then(function (ok) {
      if (!ok) throw new Error('asset version mismatch');
      return responses;
    });
  });
}

function putAll(responses) {
  return caches.open(CACHE_NAME).then(function (cache) {
    return Promise.all(responses.map(function (res, i) {
      return cache.put(ASSET_URLS[i], res);
    }));
  });
}

function ensureComplete() {
  return checkReady().then(function (r) {
    if (!r.complete) throw new Error('cache incomplete');
  });
}

// 検証済みの一式でこの版のキャッシュを作り直す（未検証の部分上書きはしない）
function storeVerified() {
  return fetchVerifiedAssets().then(putAll).then(ensureComplete);
}

// 同じアプリ・同じ配置の旧版キャッシュを削除する（この版の完全性を確認できた場合だけ呼ぶ）
function deleteOldCaches() {
  return caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (key) {
      return key.indexOf(CACHE_PREFIX) === 0 && key !== CACHE_NAME && key !== SESSION_CACHE;
    }).map(function (key) {
      return caches.delete(key);
    }));
  });
}

// セッション開始時の配信候補：この版が完全ならこの版、欠けていれば完全な旧版。
// 選んだ版はSession cacheに保持し、ページ使用中の修復で切り替えない。
var servingPromise = null;

function findServing() {
  return checkReady().then(function (r) {
    if (r.complete) return { name: CACHE_NAME, version: VERSION };
    return caches.keys().then(function (keys) {
      var olds = keys.filter(function (key) {
        return key.indexOf(CACHE_PREFIX) === 0 && key !== CACHE_NAME && key !== SESSION_CACHE;
      }).reverse();
      var i = 0;
      function next() {
        if (i >= olds.length) return null;
        var name = olds[i++];
        var version = name.slice(CACHE_PREFIX.length);
        return checkCache(name, version).then(function (o) {
          return o.complete ? { name: name, version: version } : next();
        });
      }
      return next();
    });
  }).catch(function () {
    return null;
  });
}

function getServing() {
  if (!servingPromise) {
    servingPromise = caches.open(SESSION_CACHE).then(function (cache) {
      return cache.match(SESSION_KEY);
    }).then(function (res) {
      return res ? res.text() : '';
    }).then(function (html) {
      var marker = /name="asset-version" content="([^"]+)"/.exec(html);
      return marker ? { name: CACHE_PREFIX + marker[1], version: marker[1] } : null;
    }).then(function (s) {
      if (!s || s.name !== CACHE_PREFIX + s.version || s.name === SESSION_CACHE) {
        return findServing().then(pinServing);
      }
      // 記録した版が壊れているとき、使用中のページを別の版へ黙って切り替えない。
      return checkCache(s.name, s.version).then(function (r) { return r.complete ? s : null; });
    }).catch(function () { return null; });
  }
  return servingPromise;
}

function pinServing(s) {
  if (!s) return null;
  // 選択用の記録も配信済みの静的HTMLだけにし、入力や結果は保存しない。
  return matchIn(s.name, [ROOT_URL, INDEX_URL]).then(function (html) {
    if (!html) throw new Error('selected HTML missing');
    return caches.open(SESSION_CACHE).then(function (cache) {
      return cache.put(SESSION_KEY, html);
    });
  }).then(function () {
    servingPromise = Promise.resolve(s);
    return s;
  });
}

// 新しい画面のナビゲーションだけでセッション境界を確認する。
// 他のアプリ画面が残る間は、修復が完了していても配信版と旧資産を保持する。
function navigationServing(event) {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clients) {
    var open = clients.some(function (client) {
      if (client.id === event.resultingClientId) return false;
      try {
        var url = new URL(client.url);
        return url.origin === BASE_URL.origin && url.pathname.indexOf(BASE_PATH) === 0;
      } catch (_) { return false; }
    });
    if (open) return getServing();
    return findServing().then(pinServing).then(function (s) {
      if (s && s.name === CACHE_NAME) return deleteOldCaches().then(function () { return s; });
      return s;
    });
  });
}

// この版が欠けている場合の修復（通信復帰後に正常な新版へ移るため）。同時に一つだけ実行する。
var repairPromise = null;

function repairCurrent() {
  if (repairPromise) return repairPromise;
  repairPromise = checkReady().then(function (r) {
    if (r.complete) return true;
    // 保存だけを行う。使用中の配信版と旧版キャッシュには触らない。
    return storeVerified().then(function () { return true; });
  }).catch(function () {
    return false;
  }).then(function (ok) {
    repairPromise = null;
    return ok;
  });
  return repairPromise;
}

self.addEventListener('install', function (event) {
  // 取得・成功・版一致をすべて確認してから保存し、保存後も完全性を確認する。
  // どこかで失敗したらインストール失敗とし、この版で新たに作ったキャッシュだけを破棄する。
  event.waitUntil(
    caches.has(CACHE_NAME).then(function (existed) {
      if (existed) {
        // 同じ版のキャッシュが既にある（稼働中の可能性あり）。完全なら一切上書きしない。
        return checkReady().then(function (r) {
          if (r.complete) return;
          // 既に欠けている場合だけ、検証済みの一式で修復する
          return storeVerified();
        });
      }
      return storeVerified().catch(function (err) {
        return caches.delete(CACHE_NAME).then(function () { throw err; }, function () { throw err; });
      });
    })
  );
});

self.addEventListener('activate', function (event) {
  // 新版キャッシュの完全性を確認できた場合だけ、同じアプリ・同じ配置の旧版キャッシュを削除する。
  // 欠けていた場合は旧版を残し、配信は完全な旧版キャッシュから行う（修復は準備確認時に試みる）。
  event.waitUntil(
    findServing().then(pinServing).then(function (s) {
      if (!s) throw new Error('no complete asset version');
      if (s.name === CACHE_NAME) return deleteOldCaches();
    }).then(function () {
      return self.clients.claim();
    })
  );
});

// 要求URLを保存済み資産のキーへ解決する（クエリは無視）。対象外は null。
function resolveAsset(request) {
  var url = new URL(request.url);
  if (url.origin !== BASE_URL.origin) return null;
  if (url.pathname.indexOf(BASE_PATH) !== 0) return null;
  url.search = '';
  url.hash = '';
  var href = url.href;
  if (ASSET_URLS.indexOf(href) < 0) return null;
  return href;
}

function matchIn(name, keys) {
  return caches.open(name).then(function (cache) {
    var i = 0;
    function next() {
      if (i >= keys.length) return undefined;
      return cache.match(keys[i++]).then(function (res) { return res || next(); });
    }
    return next();
  });
}

// 固定した配信用キャッシュから応答する。欠損時に別版へ黙って切り替えない。
function fromCache(keys, serving) {
  return (serving || getServing()).then(function (s) {
    return s ? matchIn(s.name, keys) : undefined;
  }).catch(function () { return undefined; });
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;
  var key = resolveAsset(request);
  if (!key) return; // 配布ディレクトリ外・他オリジン・未知URLには介入しない

  var keys = [key];
  // ナビゲーションの代替HTMLはルートと index.html の相互だけ
  if (request.mode === 'navigate') {
    if (key === ROOT_URL) keys.push(INDEX_URL);
    else if (key === INDEX_URL) keys.push(ROOT_URL);
  }

  event.respondWith(
    fromCache(keys, request.mode === 'navigate' ? navigationServing(event) : null).then(function (cached) {
      return cached || fetch(request);
    })
  );
});

// 指定キャッシュに必須資産がそろい、指定版の表記と一致するか
function checkCache(name, version) {
  return caches.has(name).then(function (exists) {
    if (!exists) return { complete: false, missing: ASSET_URLS.slice() };
    return caches.open(name).then(function (cache) {
      return Promise.all(ASSET_URLS.map(function (url) {
        return cache.match(url).then(function (res) { return res && res.ok ? null : url; });
      })).then(function (missing) {
        missing = missing.filter(Boolean);
        if (missing.length) return { complete: false, missing: missing };
        return versionMarkersOk(function (url) {
          return cache.match(url).then(function (res) { return res ? res.text() : null; });
        }, version).then(function (versionOk) {
          return { complete: versionOk, missing: [], versionMismatch: !versionOk };
        });
      });
    });
  }).catch(function () {
    return { complete: false, missing: [], error: true };
  });
}

// この版のキャッシュの完全性
function checkReady() {
  return checkCache(CACHE_NAME, VERSION);
}

// ページからの準備確認：実際に配信するキャッシュが完全か、その版を返す。
// ページ側はこの版と自身の資産版の一致を確かめてから完了表示にする。
self.addEventListener('message', function (event) {
  var data = event.data;
  var port = event.ports && event.ports[0];
  if (!data || data.type !== 'check-ready' || !port) return;
  event.waitUntil(getServing().then(function (s) {
    var r = s ? checkCache(s.name, s.version) : checkReady();
    return r.then(function (res) {
      port.postMessage({
        type: 'ready-status',
        complete: !!s && res.complete,
        version: s ? s.version : VERSION,
        missing: res.missing,
        versionMismatch: !!res.versionMismatch
      });
      // この版が欠けている場合は、応答後に通信があれば修復する（失敗しても旧版は残す）
      if (!s || s.name !== CACHE_NAME) return repairCurrent();
    });
  }));
});
