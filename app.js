/*
 * 単価比較電卓 app.js
 * - UnitCalc：入力検証・正確な十進計算・判定（DOM非依存。Node等から直接検証可能）
 * - 画面処理：入力、表示更新、消去、種類切替
 * - オフライン準備：Service Worker登録と準備状態の確認
 */
'use strict';

// 資産版。更新時は index.html の asset-version と sw.js の VERSION を必ず同時に上げる。
var ASSET_VERSION = '1.0.2';

var UnitCalc = (function () {
  var KINDS = {
    weight: {
      label: '重さ',
      units: [{ id: 'g', label: 'g', factor: 1n }, { id: 'kg', label: 'kg', factor: 1000n }],
      defaultUnit: 'g',
      base: 100n,
      perLabel: '円/100g'
    },
    volume: {
      label: '容量',
      units: [{ id: 'mL', label: 'mL', factor: 1n }, { id: 'L', label: 'L', factor: 1000n }],
      defaultUnit: 'mL',
      base: 100n,
      perLabel: '円/100mL'
    },
    count: {
      label: '個数',
      units: [{ id: 'pc', label: '個', factor: 1n }],
      defaultUnit: 'pc',
      base: 1n,
      perLabel: '円/個'
    }
  };

  var MESSAGES = {
    emptyPrice: '価格を入力してください',
    emptyAmount: '内容量を入力してください',
    comma: 'カンマを使わず数字で入力してください',
    negativePrice: '価格は0以上にしてください',
    nonPositiveAmount: '内容量は0より大きい数にしてください',
    tooLarge: '数が大きすぎます',
    tooSmall: '数が小さすぎます',
    format: '数字と小数点で入力してください'
  };

  var DECIMAL_RE = /^(?:[0-9]+\.?[0-9]*|\.[0-9]+)$/;
  var MINUS_RE = /^[-−－]/;

  // 前後の空白を除き、全角数字・全角ピリオドを半角にする（表示中の入力欄は書き換えない）
  function normalize(raw) {
    return String(raw == null ? '' : raw)
      .trim()
      .replace(/[０-９]/g, function (c) {
        return String.fromCharCode(c.charCodeAt(0) - 0xFF10 + 0x30);
      })
      .replace(/．/g, '.');
  }

  // 十進表記を「整数 ÷ 10^scale」に変換する
  function toDecimal(s) {
    var dot = s.indexOf('.');
    var intPart = dot < 0 ? s : s.slice(0, dot);
    var fracPart = dot < 0 ? '' : s.slice(dot + 1);
    var digits = (intPart + fracPart) || '0';
    return { int: BigInt(digits), scale: fracPart.length };
  }

  // field: 'price' | 'amount'
  // 戻り値: { ok: true, value: {int, scale} } または { ok: false, empty: bool, message }
  function parseField(raw, field) {
    var isPrice = field === 'price';
    var s = normalize(raw);
    if (s === '') {
      return { ok: false, empty: true, message: isPrice ? MESSAGES.emptyPrice : MESSAGES.emptyAmount };
    }
    if (s.indexOf(',') >= 0 || s.indexOf('，') >= 0) {
      return { ok: false, empty: false, message: MESSAGES.comma };
    }
    if (MINUS_RE.test(s)) {
      var rest = s.slice(1);
      if (DECIMAL_RE.test(rest)) {
        var neg = toDecimal(rest);
        if (neg.int !== 0n) {
          return { ok: false, empty: false, message: isPrice ? MESSAGES.negativePrice : MESSAGES.nonPositiveAmount };
        }
        if (!isPrice) {
          return { ok: false, empty: false, message: MESSAGES.nonPositiveAmount };
        }
      }
      return { ok: false, empty: false, message: MESSAGES.format };
    }
    if (!DECIMAL_RE.test(s)) {
      return { ok: false, empty: false, message: MESSAGES.format };
    }
    var dec = toDecimal(s);
    var num = Number(s);
    if (!isFinite(num)) {
      return { ok: false, empty: false, message: MESSAGES.tooLarge };
    }
    if (dec.int !== 0n && num === 0) {
      return { ok: false, empty: false, message: MESSAGES.tooSmall };
    }
    if (!isPrice && dec.int === 0n) {
      return { ok: false, empty: false, message: MESSAGES.nonPositiveAmount };
    }
    return { ok: true, value: dec };
  }

  function pow10(n) {
    return 10n ** BigInt(n);
  }

  function unitFactor(kind, unitId) {
    var k = KINDS[kind];
    for (var i = 0; i < k.units.length; i++) {
      if (k.units[i].id === unitId) return k.units[i].factor;
    }
    throw new Error('unknown unit');
  }

  // 単価 = 価格 × 基準量 ÷ (内容量 × 換算係数) を 分子/分母 の整数で表す
  function unitPrice(price, amount, kind, unitId) {
    var k = KINDS[kind];
    var factor = unitFactor(kind, unitId);
    return {
      num: price.int * k.base * pow10(amount.scale),
      den: pow10(price.scale) * amount.int * factor
    };
  }

  // 戻り値: 負=Aが安い、0=同じ、正=Bが安い（たすき掛けで厳密比較）
  function compare(a, b) {
    var left = a.num * b.den;
    var right = b.num * a.den;
    return left < right ? -1 : (left > right ? 1 : 0);
  }

  // 非負の単価を小数第3位で四捨五入し、小数2桁の文字列にする
  function format2(r) {
    var scaled = r.num * 100n;
    var q = scaled / r.den;
    var rem = scaled % r.den;
    if (rem * 2n >= r.den) q += 1n;
    var s = q.toString();
    while (s.length < 3) s = '0' + s;
    return s.slice(0, -2) + '.' + s.slice(-2);
  }

  // 1商品分の評価。input: { price, amount, unit }
  function evaluateItem(input, kind) {
    var p = parseField(input.price, 'price');
    var a = parseField(input.amount, 'amount');
    var result = { price: p, amount: a, valid: p.ok && a.ok, ratio: null, display: null };
    if (result.valid) {
      result.ratio = unitPrice(p.value, a.value, kind, input.unit);
      result.display = format2(result.ratio);
    }
    return result;
  }

  // 両商品の評価と判定。verdict: 'A' | 'B' | 'same' | 'one' | 'none'
  function evaluate(state) {
    var a = evaluateItem(state.A, state.kind);
    var b = evaluateItem(state.B, state.kind);
    var verdict;
    if (a.valid && b.valid) {
      var c = compare(a.ratio, b.ratio);
      verdict = c < 0 ? 'A' : (c > 0 ? 'B' : 'same');
    } else if (a.valid || b.valid) {
      verdict = 'one';
    } else {
      verdict = 'none';
    }
    return { A: a, B: b, verdict: verdict };
  }

  var VERDICT_TEXT = {
    A: 'Aが安い',
    B: 'Bが安い',
    same: '同じ単価',
    one: 'もう一方の価格と内容量を確認してください',
    none: '価格と内容量を入力してください'
  };

  return {
    KINDS: KINDS,
    MESSAGES: MESSAGES,
    VERDICT_TEXT: VERDICT_TEXT,
    normalize: normalize,
    parseField: parseField,
    unitPrice: unitPrice,
    compare: compare,
    format2: format2,
    evaluateItem: evaluateItem,
    evaluate: evaluate
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { UnitCalc: UnitCalc, ASSET_VERSION: ASSET_VERSION };
}

/* ---------------- 画面処理 ---------------- */

if (typeof document !== 'undefined') {
  (function () {
    var ITEMS = ['A', 'B'];
    var state = { kind: 'weight', A: null, B: null };
    var touched = { A: { price: false, amount: false }, B: { price: false, amount: false } };
    var el = {};

    function $(id) { return document.getElementById(id); }

    function emptyItem(kind) {
      return { price: '', amount: '', unit: UnitCalc.KINDS[kind].defaultUnit };
    }

    function fillUnitOptions(id) {
      var kind = UnitCalc.KINDS[state.kind];
      var sel = el[id].unit;
      while (sel.firstChild) sel.removeChild(sel.firstChild);
      kind.units.forEach(function (u) {
        var opt = document.createElement('option');
        opt.value = u.id;
        opt.textContent = u.label;
        sel.appendChild(opt);
      });
      sel.value = state[id].unit;
      var fixed = kind.units.length === 1;
      sel.hidden = fixed;
      el[id].unitFixed.hidden = !fixed;
      el[id].unitFixed.textContent = kind.units[0].label;
      el[id].unitLabel.htmlFor = fixed ? '' : sel.id;
    }

    function resetItem(id) {
      state[id] = emptyItem(state.kind);
      touched[id].price = false;
      touched[id].amount = false;
      el[id].price.value = '';
      el[id].amount.value = '';
      fillUnitOptions(id);
    }

    function showFieldMessage(input, msgEl, parsed, isTouched) {
      if (parsed.ok) {
        msgEl.textContent = '';
        msgEl.className = 'msg';
        input.removeAttribute('aria-invalid');
        return;
      }
      msgEl.textContent = parsed.message;
      if (isTouched || !parsed.empty) {
        msgEl.className = 'msg error';
        input.setAttribute('aria-invalid', 'true');
      } else {
        msgEl.className = 'msg hint';
        input.removeAttribute('aria-invalid');
      }
    }

    function render() {
      var result = UnitCalc.evaluate(state);
      var per = UnitCalc.KINDS[state.kind].perLabel;
      ITEMS.forEach(function (id) {
        var r = result[id];
        var e = el[id];
        showFieldMessage(e.price, e.priceMsg, r.price, touched[id].price);
        showFieldMessage(e.amount, e.amountMsg, r.amount, touched[id].amount);
        e.unitPrice.textContent = r.valid ? r.display + ' ' + per : '—';
        var win = result.verdict === id;
        e.card.classList.toggle('winner', win);
        e.badge.hidden = !win;
      });
      var v = result.verdict;
      el.result.className = 'result ' + (v === 'A' || v === 'B' ? 'decided' : (v === 'same' ? 'same' : 'pending'));
      el.verdict.textContent = UnitCalc.VERDICT_TEXT[v];
      if (v === 'A' || v === 'B' || v === 'same') {
        el.detail.textContent = 'A：' + result.A.display + ' ' + per + '　B：' + result.B.display + ' ' + per;
      } else {
        el.detail.textContent = '';
      }
    }

    function onInput(id, field) {
      return function () {
        state[id][field] = el[id][field].value;
        touched[id][field] = true;
        render();
      };
    }

    function clearItem(id) {
      resetItem(id);
      render();
      el[id].price.focus();
    }

    function clearAll() {
      ITEMS.forEach(resetItem);
      render();
      el.A.price.focus();
    }

    function changeKind(kind) {
      if (kind === state.kind || !UnitCalc.KINDS[kind]) return;
      state.kind = kind;
      ITEMS.forEach(function (id) {
        state[id].amount = '';
        state[id].unit = UnitCalc.KINDS[kind].defaultUnit;
        touched[id].amount = false;
        el[id].amount.value = '';
        fillUnitOptions(id);
      });
      render();
    }

    function resetAll() {
      state.kind = 'weight';
      el.kindRadios.forEach(function (r) { r.checked = r.value === 'weight'; });
      ITEMS.forEach(resetItem);
      render();
    }

    function init() {
      ITEMS.forEach(function (id) {
        var p = id.toLowerCase();
        el[id] = {
          card: $('card-' + p),
          price: $(p + '-price'),
          amount: $(p + '-amount'),
          unit: $(p + '-unit'),
          unitLabel: $(p + '-unit-label'),
          unitFixed: $(p + '-unit-fixed'),
          priceMsg: $(p + '-price-msg'),
          amountMsg: $(p + '-amount-msg'),
          unitPrice: $(p + '-unit-price'),
          badge: $(p + '-badge'),
          clear: $(p + '-clear')
        };
        el[id].price.addEventListener('input', onInput(id, 'price'));
        el[id].amount.addEventListener('input', onInput(id, 'amount'));
        el[id].unit.addEventListener('change', function () {
          state[id].unit = el[id].unit.value;
          render();
        });
        el[id].clear.addEventListener('click', function () { clearItem(id); });
      });
      el.kindRadios = Array.prototype.slice.call(document.querySelectorAll('input[name="kind"]'));
      el.kindRadios.forEach(function (r) {
        r.addEventListener('change', function () {
          if (r.checked) changeKind(r.value);
        });
      });
      el.result = $('result');
      el.verdict = $('verdict');
      el.detail = $('verdict-detail');
      el.status = $('offline-status');
      $('clear-all').addEventListener('click', clearAll);
      $('calc-form').addEventListener('submit', function (ev) { ev.preventDefault(); });

      resetAll();
      // 戻る操作（bfcache）やフォーム復元で前回入力を再表示しない
      window.addEventListener('pageshow', function (ev) {
        if (ev.persisted) resetAll();
      });

      Offline.start(el.status);
    }

    /* ---------------- オフライン準備 ---------------- */

    var Offline = (function () {
      var TEXT = {
        preparing: 'オフライン利用の準備中…',
        ready: 'オフライン利用の準備ができました',
        failed: '準備に失敗しました。通信を確認して再読込してください',
        unsupported: 'この環境ではオフライン準備ができません。HTTPSのSafariで開いてください'
      };
      var CHECK_TIMEOUT = 10000;
      var OVERALL_TIMEOUT = 30000;
      var statusEl = null;
      var current = null;
      var overallTimer = null;
      var checkSeq = 0;

      function set(name) {
        if (current === name) return;
        current = name;
        statusEl.textContent = TEXT[name];
        statusEl.className = 'status status-' + name;
        if (name === 'ready' && overallTimer) {
          clearTimeout(overallTimer);
          overallTimer = null;
        }
      }

      function supported() {
        if (!('serviceWorker' in navigator) || typeof MessageChannel === 'undefined' || typeof caches === 'undefined') return false;
        if (location.protocol === 'https:') return true;
        if (location.protocol === 'http:') {
          var h = location.hostname;
          return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
        }
        return false;
      }

      function pageVersion() {
        var meta = document.querySelector('meta[name="asset-version"]');
        return meta ? meta.getAttribute('content') : null;
      }

      // ページを制御しているSWに、現行キャッシュの必須資産と版を問い合わせる。
      // 確認のたびに以前の結果を無効にし、最新の確認（同じ制御SW）の結果だけを反映する。
      function check() {
        var seq = ++checkSeq;
        var ctrl = navigator.serviceWorker.controller;
        set('preparing');
        if (!ctrl) {
          set('failed');
          return;
        }
        function latest() {
          return seq === checkSeq && navigator.serviceWorker.controller === ctrl;
        }
        var channel = new MessageChannel();
        var done = false;
        var timer = setTimeout(function () {
          if (done) return;
          done = true;
          channel.port1.close();
          if (latest()) set('failed');
        }, CHECK_TIMEOUT);
        channel.port1.onmessage = function (ev) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          channel.port1.close();
          if (!latest()) return;
          var d = ev.data || {};
          var ok = d.type === 'ready-status' && d.complete === true &&
            d.version === ASSET_VERSION && pageVersion() === ASSET_VERSION;
          set(ok ? 'ready' : 'failed');
        };
        try {
          ctrl.postMessage({ type: 'check-ready', version: ASSET_VERSION }, [channel.port2]);
        } catch (e) {
          done = true;
          clearTimeout(timer);
          channel.port1.close();
          if (seq === checkSeq) set('failed');
        }
      }

      function watchInstall(worker) {
        if (!worker) return;
        worker.addEventListener('statechange', function () {
          if (worker.state === 'redundant' && current !== 'ready' && !navigator.serviceWorker.controller) {
            set('failed');
          }
        });
      }

      function start(elStatus) {
        statusEl = elStatus;
        if (!supported()) {
          set('unsupported');
          return;
        }
        set('preparing');
        overallTimer = setTimeout(function () {
          overallTimer = null;
          if (current !== 'ready') set('failed');
        }, OVERALL_TIMEOUT);

        var sw = navigator.serviceWorker;
        sw.addEventListener('controllerchange', check);
        sw.register('./sw.js', { scope: './', updateViaCache: 'none' }).then(function (reg) {
          watchInstall(reg.installing);
          reg.addEventListener('updatefound', function () { watchInstall(reg.installing); });
          if (sw.controller) {
            check();
          } else {
            sw.ready.then(function () { if (sw.controller) check(); });
          }
        }).catch(function () {
          set('failed');
        });
      }

      return { start: start };
    })();

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  })();
}
