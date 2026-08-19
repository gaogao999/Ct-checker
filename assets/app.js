/* ============================================================================
 * CT Checker — サイクルタイム測定
 * 依存ライブラリなし。ファイルを直接開いても動作します。
 * ==========================================================================*/
(function () {
  'use strict';

  var STORE_KEY = 'ct-checker:v1';
  var SESSION_KEY = 'ct-checker:sessions:v1';
  var THEME_KEY = 'ct-checker:theme';
  var MAX_ELEMENTS = 8;
  var SERIES_SLOTS = 8;

  /* ------------------------------------------------------------------ 汎用 */
  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /** ミリ秒 → 秒（数値文字列）。表・CSV用。 */
  function sec(ms, digits) {
    return (ms / 1000).toFixed(digits == null ? 2 : digits);
  }

  /** ミリ秒 → 読み上げやすい時間表記。60秒以上は m:ss.SS。 */
  function fmtTime(ms) {
    if (!isFinite(ms)) return '—';
    var neg = ms < 0;
    var v = Math.abs(ms);
    var out;
    if (v >= 60000) {
      var m = Math.floor(v / 60000);
      var s = (v % 60000) / 1000;
      out = m + ':' + (s < 10 ? '0' : '') + s.toFixed(2);
    } else {
      out = (v / 1000).toFixed(2);
    }
    return (neg ? '-' : '') + out;
  }

  function seriesVar(i) { return 'var(--series-' + (i % SERIES_SLOTS + 1) + ')'; }

  function nowIso() { return new Date().toISOString(); }

  function fmtDateTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d)) return '—';
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  var toastTimer = null;
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 2400);
  }

  /* ------------------------------------------------------------------ 状態 */
  function defaultState() {
    return {
      settings: {
        title: '', operator: '', memo: '', takt: null,
        elements: [{ id: uid(), name: '1サイクル' }]
      },
      cycles: [],     // { startAcc, marks:[acc,...], excluded, note, at }
      accBase: 0,     // 一時停止を除いた累積経過(ms)
      cycleStart: 0,  // 現在サイクルの開始累積(ms)
      pending: [],    // 現在サイクル内で確定した区切りの累積(ms)
      started: false,
      startedAt: null
    };
  }

  var state = defaultState();
  var runSince = null;             // 実行中のみ performance.now()
  var lastRenderedElapsed = -1;

  function elements() { return state.settings.elements; }
  function elemCount() { return Math.max(1, elements().length); }
  function running() { return runSince !== null; }
  function elapsed() {
    return state.accBase + (runSince !== null ? performance.now() - runSince : 0);
  }
  function cycleElapsed() { return elapsed() - state.cycleStart; }
  function elementElapsed() {
    var base = state.pending.length ? state.pending[state.pending.length - 1] : state.cycleStart;
    return elapsed() - base;
  }
  function totalOf(c) { return c.marks[c.marks.length - 1] - c.startAcc; }
  function durationsOf(c) {
    var out = [], prev = c.startAcc;
    for (var i = 0; i < c.marks.length; i++) { out.push(c.marks[i] - prev); prev = c.marks[i]; }
    return out;
  }
  function activeCycles() {
    return state.cycles.filter(function (c) { return !c.excluded; });
  }

  /* -------------------------------------------------------------- 統計計算 */
  function stats(values) {
    var n = values.length;
    if (!n) return { n: 0, mean: 0, median: 0, min: 0, max: 0, range: 0, sd: 0, cv: 0 };
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var sum = 0;
    for (var i = 0; i < n; i++) sum += values[i];
    var mean = sum / n;
    var mid = Math.floor(n / 2);
    var median = n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    var sd = 0;
    if (n > 1) {
      var acc = 0;
      for (var j = 0; j < n; j++) acc += Math.pow(values[j] - mean, 2);
      sd = Math.sqrt(acc / (n - 1));
    }
    return {
      n: n, mean: mean, median: median,
      min: sorted[0], max: sorted[n - 1], range: sorted[n - 1] - sorted[0],
      sd: sd, cv: mean > 0 ? (sd / mean) * 100 : 0
    };
  }

  function taktMs() {
    var t = state.settings.takt;
    return (typeof t === 'number' && isFinite(t) && t > 0) ? t * 1000 : null;
  }

  /* ------------------------------------------------------------------ 保存 */
  var saveTimer = null;
  function snapshot() {
    return {
      settings: state.settings,
      cycles: state.cycles,
      accBase: elapsed(),
      cycleStart: state.cycleStart,
      pending: state.pending,
      started: state.started,
      startedAt: state.startedAt
    };
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(snapshot())); } catch (e) { /* 保存不可でも続行 */ }
  }
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 300);
  }
  function load() {
    var raw;
    try { raw = localStorage.getItem(STORE_KEY); } catch (e) { return; }
    if (!raw) return;
    try {
      var d = JSON.parse(raw);
      if (!d || !d.settings) return;
      state = normalize(d);
    } catch (e) { /* 壊れたデータは無視 */ }
  }
  function normalize(d) {
    var s = defaultState();
    s.settings.title = String(d.settings.title || '');
    s.settings.operator = String(d.settings.operator || '');
    s.settings.memo = String(d.settings.memo || '');
    s.settings.takt = (typeof d.settings.takt === 'number' && d.settings.takt > 0) ? d.settings.takt : null;
    var els = Array.isArray(d.settings.elements) ? d.settings.elements : [];
    els = els.filter(function (e) { return e && e.name; }).slice(0, MAX_ELEMENTS)
      .map(function (e) { return { id: e.id || uid(), name: String(e.name) }; });
    s.settings.elements = els.length ? els : [{ id: uid(), name: '1サイクル' }];
    s.cycles = (Array.isArray(d.cycles) ? d.cycles : []).filter(function (c) {
      return c && Array.isArray(c.marks) && c.marks.length && typeof c.startAcc === 'number';
    }).map(function (c) {
      return {
        startAcc: c.startAcc, marks: c.marks.slice(),
        excluded: !!c.excluded, note: String(c.note || ''), at: c.at || null
      };
    });
    s.accBase = typeof d.accBase === 'number' ? d.accBase : 0;
    s.cycleStart = typeof d.cycleStart === 'number' ? d.cycleStart : 0;
    s.pending = Array.isArray(d.pending) ? d.pending.slice() : [];
    s.started = !!d.started;
    s.startedAt = d.startedAt || null;
    return s;
  }

  function loadSessions() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || []; } catch (e) { return []; }
  }
  function saveSessions(list) {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(list)); }
    catch (e) { toast('保存領域がいっぱいです'); }
  }

  /* ------------------------------------------------------------ 計測アクション */
  function startOrLap() {
    if (!state.started) {
      state.started = true;
      state.startedAt = nowIso();
      state.accBase = 0;
      state.cycleStart = 0;
      state.pending = [];
      runSince = performance.now();
      requestWakeLock();
      announce('計測を開始しました。');
    } else if (!running()) {
      resume();
      return;
    } else {
      var t = elapsed();
      state.pending.push(t);
      if (state.pending.length >= elemCount()) {
        state.cycles.push({
          startAcc: state.cycleStart, marks: state.pending.slice(),
          excluded: false, note: '', at: nowIso()
        });
        state.cycleStart = t;
        state.pending = [];
        var c = state.cycles[state.cycles.length - 1];
        announce('サイクル ' + state.cycles.length + ' 完了：' + fmtTime(totalOf(c)) + ' 秒');
      } else {
        announce(elements()[state.pending.length - 1].name + ' 完了：' +
          fmtTime(state.pending[state.pending.length - 1] -
            (state.pending.length > 1 ? state.pending[state.pending.length - 2] : state.cycleStart)) + ' 秒');
      }
    }
    if (navigator.vibrate) { try { navigator.vibrate(18); } catch (e) { /* noop */ } }
    render();
    save();
  }

  function pause() {
    if (!running()) return;
    state.accBase = elapsed();
    runSince = null;
    releaseWakeLock();
    announce('一時停止中。再開すると現在のサイクルの続きから計測します。');
    render();
    save();
  }

  function resume() {
    if (running() || !state.started) return;
    runSince = performance.now();
    requestWakeLock();
    announce('計測を再開しました。');
    render();
    save();
  }

  function undo() {
    if (state.pending.length) {
      state.pending.pop();
      announce('直前の区切りを取り消しました。');
    } else if (state.cycles.length) {
      var c = state.cycles.pop();
      state.cycleStart = c.startAcc;
      state.pending = c.marks.slice(0, -1);
      announce('サイクル ' + (state.cycles.length + 1) + ' を取り消しました。');
    } else {
      return;
    }
    render();
    save();
  }

  function discardCycle() {
    if (!state.started) return;
    state.pending = [];
    state.cycleStart = elapsed();
    announce('現在のサイクルを破棄しました。ここから測り直します。');
    render();
    save();
  }

  function resetAll() {
    if (state.cycles.length && !confirm('計測データをすべて消去します。よろしいですか？\n（「現在の測定を保存」で残せます）')) return;
    var settings = state.settings;
    state = defaultState();
    state.settings = settings;
    runSince = null;
    releaseWakeLock();
    announce('リセットしました。');
    render();
    save();
  }

  function announce(msg) { $('status-line').textContent = msg; }

  /* -------------------------------------------------------- 画面スリープ抑止 */
  var wakeLock = null;
  function requestWakeLock() {
    if (!navigator.wakeLock) return;
    navigator.wakeLock.request('screen').then(function (l) { wakeLock = l; }, function () { /* 失敗しても続行 */ });
  }
  function releaseWakeLock() {
    if (wakeLock) { try { wakeLock.release(); } catch (e) { /* noop */ } wakeLock = null; }
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && running()) requestWakeLock();
    if (document.visibilityState === 'hidden') save();
  });

  /* ============================================================== 描画：計測 */
  function renderReadout() {
    var e = state.started ? cycleElapsed() : 0;
    $('readout-cycle').textContent = fmtTime(e);
    $('readout-elem').textContent = state.started ? fmtTime(elementElapsed()) : '0.00';
    $('readout-total').textContent = fmtTime(elapsed());
  }

  function renderReadoutStatic() {
    var els = elements();
    var idx = Math.min(state.pending.length, els.length - 1);
    $('readout-elem-name').textContent = state.started ? els[idx].name : '—';
    $('readout-count').textContent = String(state.cycles.length);

    var last = state.cycles.length ? state.cycles[state.cycles.length - 1] : null;
    var lastEl = $('readout-last');
    var diffEl = $('readout-last-diff');
    if (!last) {
      lastEl.textContent = '—';
      diffEl.textContent = '';
      diffEl.className = 'delta';
    } else {
      var t = totalOf(last);
      lastEl.textContent = fmtTime(t);
      var base = taktMs();
      var baseLabel = 'TT比';
      if (base == null) {
        var act = activeCycles();
        if (act.length > 1) {
          var others = act.filter(function (c) { return c !== last; }).map(totalOf);
          base = stats(others).mean;
          baseLabel = '平均比';
        }
      }
      if (base) {
        var d = t - base;
        diffEl.textContent = (d >= 0 ? '▲ +' : '▼ ') + fmtTime(d) + '（' + baseLabel + '）';
        diffEl.className = 'delta ' + (d > 0 ? 'delta--up' : 'delta--down');
      } else {
        diffEl.textContent = '';
        diffEl.className = 'delta';
      }
    }
  }

  function renderSteps() {
    var host = $('steps');
    var els = elements();
    if (els.length < 2) { host.innerHTML = ''; host.hidden = true; return; }
    host.hidden = false;
    var html = els.map(function (el, i) {
      var cls = 'step';
      var time = '';
      if (state.started && i < state.pending.length) {
        cls += ' step--done';
        var prev = i ? state.pending[i - 1] : state.cycleStart;
        time = '<span class="step__time">' + fmtTime(state.pending[i] - prev) + '</span>';
      } else if (state.started && i === state.pending.length) {
        cls += ' step--current';
      }
      return '<span class="' + cls + '" role="listitem">' +
        '<span class="step__dot" style="background:' + seriesVar(i) + '"></span>' +
        '<span>' + esc(el.name) + '</span>' + time + '</span>';
    }).join('');
    host.innerHTML = html;
  }

  function renderControls() {
    var els = elements();
    var main = $('lap-btn-main');
    var sub = $('lap-btn-sub');
    var lapBtn = $('btn-lap');

    if (!state.started) {
      main.textContent = '計測開始';
      sub.textContent = 'Space キーでも操作できます';
      lapBtn.dataset.paused = 'false';
    } else if (!running()) {
      main.textContent = '再開';
      sub.textContent = '一時停止中';
      lapBtn.dataset.paused = 'true';
    } else {
      lapBtn.dataset.paused = 'false';
      var idx = state.pending.length;
      if (els.length < 2) {
        main.textContent = 'サイクル完了';
        sub.textContent = state.cycles.length + ' サイクル計測済み';
      } else if (idx === els.length - 1) {
        main.textContent = els[idx].name + ' 完了 → 1サイクル終了';
        sub.textContent = (idx + 1) + ' / ' + els.length + ' 番目の要素作業';
      } else {
        main.textContent = els[idx].name + ' 完了 → 次へ';
        sub.textContent = (idx + 1) + ' / ' + els.length + ' 番目の要素作業';
      }
    }

    $('btn-pause').disabled = !state.started;
    $('btn-pause').textContent = (state.started && !running()) ? '再開' : '一時停止';
    $('btn-undo').disabled = !(state.pending.length || state.cycles.length);
    $('btn-discard').disabled = !state.started;
    $('btn-reset').disabled = !state.started && !state.cycles.length;
  }

  /* ============================================================== 描画：集計 */
  function renderTiles() {
    var totals = activeCycles().map(totalOf);
    var s = stats(totals);
    var tt = taktMs();
    var host = $('tiles');

    function tile(label, value, unit, note, cls) {
      return '<div class="tile' + (cls ? ' ' + cls : '') + '">' +
        '<span class="tile__label">' + esc(label) + '</span>' +
        '<span class="tile__value">' + value + (unit ? '<small>' + unit + '</small>' : '') + '</span>' +
        (note ? '<span class="tile__note">' + note + '</span>' : '') + '</div>';
    }

    if (!s.n) {
      host.innerHTML = tile('平均サイクルタイム', '—', '', '計測データがありません', 'tile--hero');
      $('takt-bar').innerHTML = '';
      return;
    }

    var excluded = state.cycles.length - s.n;
    var over = tt ? totals.filter(function (v) { return v > tt; }).length : 0;

    var html = '';
    html += tile('平均サイクルタイム', fmtTime(s.mean), '秒',
      '有効 ' + s.n + ' サイクル' + (excluded ? '（除外 ' + excluded + '）' : ''), 'tile--hero');
    html += tile('中央値', fmtTime(s.median), '秒', '');
    html += tile('最小 / 最大', fmtTime(s.min) + ' <small>/</small> ' + fmtTime(s.max), '秒',
      'レンジ ' + fmtTime(s.range) + ' 秒');
    html += tile('標準偏差 σ', fmtTime(s.sd), '秒', 'ばらつき CV ' + s.cv.toFixed(1) + ' %');
    if (tt) {
      html += tile('タクト超過', over + ' <small>/ ' + s.n + '</small>', '回',
        (s.n ? (over / s.n * 100).toFixed(0) : '0') + ' % のサイクルが超過');
    } else {
      html += tile('合計観測時間', fmtTime(elapsed()), '秒', 'タクトタイム未設定');
    }
    host.innerHTML = html;
    renderTaktBar(s, tt);
  }

  function renderTaktBar(s, tt) {
    var host = $('takt-bar');
    if (!tt || !s.n) { host.innerHTML = ''; return; }
    var ratio = s.mean / tt;
    var stateName = ratio > 1 ? 'over' : (ratio > 0.95 ? 'near' : 'ok');
    var pct = Math.max(2, Math.min(100, ratio * 100));
    var diff = tt - s.mean;
    var judge = diff >= 0
      ? '<span class="judge judge--ok">✔ タクト内</span>'
      : '<span class="judge judge--ng">▲ タクト超過</span>';
    host.innerHTML =
      '<div class="takt-bar__track" role="img" aria-label="平均サイクルタイムはタクトタイムの ' +
        ratio.toFixed(2) + ' 倍">' +
        '<div class="takt-bar__fill" data-state="' + stateName + '" style="width:' + pct.toFixed(1) + '%"></div>' +
      '</div>' +
      '<div class="takt-bar__caption">' +
        '<span>' + judge + '　平均 ' + fmtTime(s.mean) + ' 秒 / タクト ' + fmtTime(tt) + ' 秒</span>' +
        '<span>' + (diff >= 0 ? '余裕 ' : '不足 ') + fmtTime(Math.abs(diff)) + ' 秒（タクト比 ' +
          (ratio * 100).toFixed(1) + ' %）</span>' +
      '</div>';
  }

  /* ============================================================== 描画：明細 */
  function renderTables() {
    var els = elements();
    var multi = els.length > 1;
    var tt = taktMs();
    var table = $('table-cycles');

    var head = '<thead><tr><th>No</th>';
    if (multi) {
      els.forEach(function (e, i) {
        head += '<th><span class="swatch-cell"><span class="swatch" style="background:' + seriesVar(i) +
          '"></span>' + esc(e.name) + '</span></th>';
      });
    }
    head += '<th>サイクル（秒）</th>' + (tt ? '<th>タクト差</th>' : '') +
      '<th>除外</th><th>メモ</th></tr></thead>';

    var body = '';
    if (!state.cycles.length) {
      body = '<tr class="empty-row"><td colspan="' + (3 + (multi ? els.length : 0) + (tt ? 1 : 0)) +
        '">まだ計測データがありません</td></tr>';
    } else {
      state.cycles.forEach(function (c, i) {
        var d = durationsOf(c);
        var total = totalOf(c);
        var row = '<tr data-excluded="' + (c.excluded ? 'true' : 'false') + '">';
        row += '<td>' + (i + 1) + '</td>';
        if (multi) {
          for (var k = 0; k < els.length; k++) {
            row += '<td class="num">' + (d[k] != null ? sec(d[k]) : '—') + '</td>';
          }
        }
        row += '<td class="num">' + sec(total) + '</td>';
        if (tt) {
          var diff = total - tt;
          row += '<td class="num">' + (diff > 0
            ? '<span class="flag flag--over">▲ +' + sec(diff) + '</span>'
            : sec(diff)) + '</td>';
        }
        row += '<td><input type="checkbox" data-act="exclude" data-i="' + i + '"' +
          (c.excluded ? ' checked' : '') + ' aria-label="サイクル ' + (i + 1) + ' を統計から除外"></td>';
        row += '<td><input class="note-input" type="text" data-act="note" data-i="' + i +
          '" value="' + esc(c.note) + '" placeholder="—" aria-label="サイクル ' + (i + 1) + ' のメモ"></td>';
        row += '</tr>';
        body += row;
      });
    }

    var foot = '';
    var act = activeCycles();
    if (act.length) {
      var s = stats(act.map(totalOf));
      foot = '<tfoot><tr><td>平均</td>';
      if (multi) {
        els.forEach(function (e, i) {
          var vals = act.map(function (c) { return durationsOf(c)[i]; })
            .filter(function (v) { return v != null; });
          foot += '<td class="num">' + (vals.length ? sec(stats(vals).mean) : '—') + '</td>';
        });
      }
      foot += '<td class="num">' + sec(s.mean) + '</td>';
      if (tt) foot += '<td class="num">' + sec(s.mean - tt) + '</td>';
      foot += '<td colspan="2">有効 ' + s.n + ' / ' + state.cycles.length + '</td></tr></tfoot>';
    }
    table.innerHTML = head + '<tbody>' + body + '</tbody>' + foot;

    // 要素別統計
    var wrap = $('table-elements-wrap');
    if (!multi || !act.length) { wrap.hidden = true; $('table-elements').innerHTML = ''; return; }
    wrap.hidden = false;
    var totalMean = stats(act.map(totalOf)).mean;
    var eh = '<thead><tr><th>要素作業</th><th>平均（秒）</th><th>最小</th><th>最大</th><th>σ</th><th>CV</th><th>構成比</th></tr></thead><tbody>';
    els.forEach(function (e, i) {
      var vals = act.map(function (c) { return durationsOf(c)[i]; }).filter(function (v) { return v != null; });
      var st = stats(vals);
      eh += '<tr><td><span class="swatch-cell"><span class="swatch" style="background:' + seriesVar(i) +
        '"></span>' + esc(e.name) + '</span></td>' +
        '<td class="num">' + sec(st.mean) + '</td>' +
        '<td class="num">' + sec(st.min) + '</td>' +
        '<td class="num">' + sec(st.max) + '</td>' +
        '<td class="num">' + sec(st.sd) + '</td>' +
        '<td class="num">' + st.cv.toFixed(1) + ' %</td>' +
        '<td class="num">' + (totalMean > 0 ? (st.mean / totalMean * 100).toFixed(1) : '0.0') + ' %</td></tr>';
    });
    $('table-elements').innerHTML = eh + '</tbody>';
  }

  /* ========================================================== 描画：設定・保存 */
  function renderElementsList() {
    var host = $('elements-list');
    var locked = state.started || state.cycles.length > 0;
    var els = elements();
    host.innerHTML = els.map(function (e, i) {
      return '<li class="elements__item">' +
        '<span class="elements__index">' + (i + 1) + '</span>' +
        '<span class="swatch" style="background:' + seriesVar(i) + '"></span>' +
        '<input type="text" value="' + esc(e.name) + '" data-act="rename" data-i="' + i +
          '" maxlength="24" aria-label="要素作業 ' + (i + 1) + ' の名前"' + (locked ? ' disabled' : '') + '>' +
        (locked ? '' : '<button type="button" class="btn btn--icon" data-act="del-element" data-i="' + i +
          '" aria-label="要素作業 ' + (i + 1) + ' を削除">✕</button>') +
        '</li>';
    }).join('');

    $('in-element').disabled = locked || els.length >= MAX_ELEMENTS;
    $('btn-add-element').disabled = locked || els.length >= MAX_ELEMENTS;
    var hint = $('elements-hint');
    if (locked) {
      hint.textContent = '計測中は要素作業を変更できません。変更するには「リセット」してください。';
      hint.className = 'hint hint--warn';
    } else if (els.length >= MAX_ELEMENTS) {
      hint.textContent = '要素作業は最大 ' + MAX_ELEMENTS + ' 個までです。';
      hint.className = 'hint hint--warn';
    } else {
      hint.textContent = '1サイクルを区切って観測したい単位を登録します（最大' + MAX_ELEMENTS +
        '個）。1つだけなら1サイクル1タップで計測します。';
      hint.className = 'hint';
    }
  }

  function renderSessions() {
    var list = loadSessions();
    var t = $('table-sessions');
    var head = '<thead><tr><th>名前</th><th>保存日時</th><th>サイクル</th><th>平均（秒）</th><th>操作</th></tr></thead>';
    if (!list.length) {
      t.innerHTML = head + '<tbody><tr class="empty-row"><td colspan="5">保存した測定はありません</td></tr></tbody>';
      return;
    }
    var body = list.map(function (s) {
      var cycles = (s.cycles || []).filter(function (c) { return !c.excluded; });
      var totals = cycles.map(function (c) { return c.marks[c.marks.length - 1] - c.startAcc; });
      var st = stats(totals);
      return '<tr><td>' + esc(s.name) + '</td>' +
        '<td>' + fmtDateTime(s.savedAt) + '</td>' +
        '<td class="num">' + (s.cycles || []).length + '</td>' +
        '<td class="num">' + (st.n ? sec(st.mean) : '—') + '</td>' +
        '<td><button type="button" class="btn btn--sm" data-act="load-session" data-id="' + esc(s.id) + '">読込</button> ' +
        '<button type="button" class="btn btn--sm" data-act="csv-session" data-id="' + esc(s.id) + '">CSV</button> ' +
        '<button type="button" class="btn btn--sm btn--danger" data-act="del-session" data-id="' + esc(s.id) + '">削除</button></td></tr>';
    }).join('');
    t.innerHTML = head + '<tbody>' + body + '</tbody>';
  }

  function syncSettingsInputs() {
    $('in-title').value = state.settings.title;
    $('in-operator').value = state.settings.operator;
    $('in-memo').value = state.settings.memo;
    $('in-takt').value = state.settings.takt == null ? '' : state.settings.takt;
  }

  /* ------------------------------------------------------------ 全体レンダリング */
  function render() {
    renderReadout();
    renderReadoutStatic();
    renderSteps();
    renderControls();
    renderTiles();
    renderTables();
    renderElementsList();
    renderCharts();
  }

  /* ============================================================== グラフ描画 */
  var TIPS = {};

  function nn(v) { return Math.round(v * 100) / 100; }
  function chartWidth(host) { return Math.max(300, Math.floor(host.clientWidth) || 640); }

  /** 目盛りを丸い数値に揃える（単位＝秒）。 */
  function niceScale(max, count) {
    if (!(max > 0)) return { ticks: [0, 1], max: 1 };
    var raw = max / count;
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag;
    var step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
    var top = Math.ceil(max / step) * step;
    var ticks = [];
    for (var v = 0; v <= top + step * 1e-6; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
    return { ticks: ticks, max: top };
  }

  function tickLabel(v) {
    return (Math.abs(v - Math.round(v)) < 1e-6) ? String(Math.round(v)) : String(nn(v));
  }

  function topRounded(x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h));
    return 'M' + nn(x) + ' ' + nn(y + h) + ' V ' + nn(y + r) +
      ' A ' + nn(r) + ' ' + nn(r) + ' 0 0 1 ' + nn(x + r) + ' ' + nn(y) +
      ' H ' + nn(x + w - r) +
      ' A ' + nn(r) + ' ' + nn(r) + ' 0 0 1 ' + nn(x + w) + ' ' + nn(y + r) +
      ' V ' + nn(y + h) + ' Z';
  }

  function rightRounded(x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w, h / 2));
    return 'M' + nn(x) + ' ' + nn(y) + ' H ' + nn(x + w - r) +
      ' A ' + nn(r) + ' ' + nn(r) + ' 0 0 1 ' + nn(x + w) + ' ' + nn(y + r) +
      ' V ' + nn(y + h - r) +
      ' A ' + nn(r) + ' ' + nn(r) + ' 0 0 1 ' + nn(x + w - r) + ' ' + nn(y + h) +
      ' H ' + nn(x) + ' Z';
  }

  function txt(x, y, s, opts) {
    opts = opts || {};
    return '<text x="' + nn(x) + '" y="' + nn(y) + '" fill="' + (opts.fill || 'var(--text-muted)') +
      '" font-size="' + (opts.size || 11) + '" text-anchor="' + (opts.anchor || 'start') +
      '" dominant-baseline="' + (opts.baseline || 'auto') + '"' +
      (opts.weight ? ' font-weight="' + opts.weight + '"' : '') +
      (opts.tabular ? ' style="font-variant-numeric:tabular-nums"' : '') +
      '>' + esc(s) + '</text>';
  }

  function clipName(name, maxChars) {
    var s = String(name);
    return s.length > maxChars ? s.slice(0, maxChars - 1) + '…' : s;
  }

  /* ---------------------------------------------- ① サイクルタイムの推移 */
  function renderCycleChart() {
    var host = $('chart-cycles');
    var legend = $('legend-1');
    var sub = $('fig1-sub');
    var cycles = state.cycles;
    var els = elements();
    var multi = els.length > 1;

    if (!cycles.length) {
      host.dataset.state = 'empty'; host.innerHTML = ''; legend.innerHTML = ''; sub.textContent = '';
      return;
    }
    host.dataset.state = '';

    var w = chartWidth(host), h = 300;
    var padL = 48, padR = 74, padT = 16, padB = 38;
    var plotW = w - padL - padR, plotH = h - padT - padB;

    var totals = cycles.map(totalOf);
    var tt = taktMs();
    var act = activeCycles().map(totalOf);
    var st = stats(act);
    var dataMax = Math.max.apply(null, totals);
    if (tt) dataMax = Math.max(dataMax, tt);
    var scale = niceScale(dataMax / 1000 * 1.02, 5);
    var yMax = scale.max * 1000;
    var yOf = function (v) { return padT + plotH - (v / yMax) * plotH; };

    var s = ['<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="サイクルごとのサイクルタイム推移">'];

    // グリッド
    scale.ticks.forEach(function (t) {
      var y = yOf(t * 1000);
      s.push('<line x1="' + padL + '" y1="' + nn(y) + '" x2="' + nn(padL + plotW) + '" y2="' + nn(y) +
        '" stroke="var(--grid)" stroke-width="1" />');
      s.push(txt(padL - 8, y, tickLabel(t), { anchor: 'end', baseline: 'middle', tabular: true }));
    });
    s.push('<line x1="' + padL + '" y1="' + nn(padT + plotH) + '" x2="' + nn(padL + plotW) +
      '" y2="' + nn(padT + plotH) + '" stroke="var(--axis)" stroke-width="1" />');

    // 棒
    var n = cycles.length;
    var band = plotW / n;
    var barW = Math.min(24, Math.max(3, band * 0.72));
    var labelEvery = Math.ceil(n / Math.max(1, Math.floor(plotW / 34)));
    var gap = barW > 8 ? 2 : 0;

    cycles.forEach(function (c, i) {
      var cx = padL + band * (i + 0.5);
      var x = cx - barW / 2;
      var d = durationsOf(c);
      var total = totalOf(c);
      var cum = 0;
      var segs = multi && !c.excluded ? d : [total];

      segs.forEach(function (v, j) {
        var yTop = yOf(cum + v);
        var yBot = yOf(cum);
        var isTop = (j === segs.length - 1);
        var hh = yBot - yTop - (isTop ? 0 : gap);
        if (hh < 1) hh = 1;
        var fill = c.excluded ? 'var(--axis)' : (multi ? seriesVar(j) : 'var(--series-1)');
        var op = c.excluded ? ' opacity="0.55"' : '';
        if (isTop) {
          s.push('<path d="' + topRounded(x, yTop, barW, hh, 4) + '" fill="' + fill + '"' + op + ' />');
        } else {
          s.push('<rect x="' + nn(x) + '" y="' + nn(yTop + gap) + '" width="' + nn(barW) +
            '" height="' + nn(hh) + '" fill="' + fill + '"' + op + ' />');
        }
        cum += v;
      });

      if (tt && !c.excluded && total > tt) {
        var ty = yOf(total) - 7;
        s.push('<path d="M ' + nn(cx - 4.5) + ' ' + nn(ty) + ' L ' + nn(cx + 4.5) + ' ' + nn(ty) +
          ' L ' + nn(cx) + ' ' + nn(ty - 6) + ' Z" fill="var(--critical)" />');
      }

      if (i % labelEvery === 0 || i === n - 1) {
        s.push(txt(cx, padT + plotH + 16, String(i + 1), { anchor: 'middle' }));
      }

      // ホバー用（マークより広い当たり判定）
      var key = 'c1-' + i;
      TIPS[key] = tipCycle(c, i, d, total, tt, multi, els);
      s.push('<rect class="hit" x="' + nn(padL + band * i) + '" y="' + padT + '" width="' + nn(band) +
        '" height="' + nn(plotH) + '" fill="transparent" data-tip="' + key + '" />');
    });

    // 平均線・タクト線
    var lines = [];
    if (st.n) lines.push({ v: st.mean, color: 'var(--text-secondary)', dash: '', label: '平均 ' + fmtTime(st.mean), width: 1.5 });
    if (tt) lines.push({ v: tt, color: 'var(--critical)', dash: '6 4', label: 'TT ' + fmtTime(tt), width: 2 });
    lines.sort(function (a, b) { return b.v - a.v; });
    var prevY = -99;
    lines.forEach(function (L) {
      var y = yOf(L.v);
      if (y > yMax) return;
      s.push('<line x1="' + padL + '" y1="' + nn(y) + '" x2="' + nn(padL + plotW) + '" y2="' + nn(y) +
        '" stroke="' + L.color + '" stroke-width="' + L.width + '"' +
        (L.dash ? ' stroke-dasharray="' + L.dash + '"' : '') + ' />');
      var ly = y;
      if (Math.abs(ly - prevY) < 13) ly = prevY + 13;
      prevY = ly;
      s.push(txt(padL + plotW + 7, ly, L.label, {
        baseline: 'middle', fill: 'var(--text-secondary)', size: 11, tabular: true
      }));
    });

    s.push('</svg>');
    host.innerHTML = s.join('');

    // 凡例
    var lg = [];
    if (multi) {
      els.forEach(function (e, i) {
        lg.push('<span class="legend__item"><span class="legend__swatch" style="background:' + seriesVar(i) +
          '"></span>' + esc(e.name) + '</span>');
      });
    }
    if (st.n) lg.push('<span class="legend__item" style="color:var(--text-secondary)"><span class="legend__swatch legend__swatch--line"></span>平均</span>');
    if (tt) {
      lg.push('<span class="legend__item" style="color:var(--critical)"><span class="legend__swatch legend__swatch--dash"></span><span style="color:var(--text-secondary)">タクトタイム</span></span>');
      lg.push('<span class="legend__item"><span style="color:var(--critical)">▲</span>タクト超過</span>');
    }
    if (state.cycles.length !== st.n) {
      lg.push('<span class="legend__item"><span class="legend__swatch" style="background:var(--axis);opacity:.55"></span>除外したサイクル</span>');
    }
    legend.innerHTML = lg.join('');
    sub.textContent = '縦軸：秒　横軸：サイクル No（全 ' + n + ' サイクル）';
  }

  function tipCycle(c, i, d, total, tt, multi, els) {
    var rows = '';
    if (multi) {
      els.forEach(function (e, j) {
        if (d[j] == null) return;
        rows += '<div class="tt-row"><span class="tt-key"><span class="tt-dot" style="background:' +
          seriesVar(j) + '"></span>' + esc(e.name) + '</span><span class="tt-val">' + fmtTime(d[j]) + '</span></div>';
      });
    }
    rows += '<div class="tt-row"><span class="tt-key">サイクル計</span><span class="tt-val">' + fmtTime(total) + ' 秒</span></div>';
    if (tt) {
      var diff = total - tt;
      rows += '<div class="tt-row"><span class="tt-key">タクト差</span><span class="tt-val" style="color:' +
        (diff > 0 ? 'var(--critical)' : 'var(--success-text)') + '">' + (diff > 0 ? '▲ +' : '') + fmtTime(diff) + '</span></div>';
    }
    if (c.note) rows += '<div class="tt-row"><span class="tt-key">メモ</span><span>' + esc(c.note) + '</span></div>';
    if (c.excluded) rows += '<div class="tt-row"><span class="tt-key">状態</span><span>統計から除外</span></div>';
    return '<strong>サイクル ' + (i + 1) + '</strong>' + rows;
  }

  /* ---------------------------------------------- ② サイクルタイムの分布 */
  function renderHistogram() {
    var host = $('chart-hist');
    var sub = $('fig2-sub');
    var totals = activeCycles().map(totalOf);
    if (totals.length < 3) {
      host.dataset.state = 'empty'; host.innerHTML = ''; sub.textContent = '';
      return;
    }
    host.dataset.state = '';

    var st = stats(totals);
    var tt = taktMs();
    var k = Math.min(12, Math.max(5, Math.ceil(Math.sqrt(totals.length))));
    var lo = st.min, hi = st.max;
    if (hi - lo < 1e-6) { lo = st.min - 500; hi = st.max + 500; }
    var bw = (hi - lo) / k;
    var counts = new Array(k).fill(0);
    totals.forEach(function (v) {
      var idx = Math.min(k - 1, Math.floor((v - lo) / bw));
      counts[idx]++;
    });
    var cMax = Math.max.apply(null, counts);

    var w = chartWidth(host), h = 260;
    var padL = 40, padR = 16, padT = 34, padB = 40;
    var plotW = w - padL - padR, plotH = h - padT - padB;
    var scale = niceScale(cMax, Math.min(5, cMax));
    var yOf = function (v) { return padT + plotH - (v / scale.max) * plotH; };
    var xOf = function (v) { return padL + ((v - lo) / (hi - lo)) * plotW; };

    var s = ['<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="サイクルタイムの度数分布">'];
    scale.ticks.forEach(function (t) {
      if (Math.abs(t - Math.round(t)) > 1e-6) return;
      var y = yOf(t);
      s.push('<line x1="' + padL + '" y1="' + nn(y) + '" x2="' + nn(padL + plotW) + '" y2="' + nn(y) +
        '" stroke="var(--grid)" stroke-width="1" />');
      s.push(txt(padL - 8, y, tickLabel(t), { anchor: 'end', baseline: 'middle', tabular: true }));
    });
    s.push('<line x1="' + padL + '" y1="' + nn(padT + plotH) + '" x2="' + nn(padL + plotW) +
      '" y2="' + nn(padT + plotH) + '" stroke="var(--axis)" stroke-width="1" />');

    var band = plotW / k;
    var barW = Math.min(40, Math.max(3, band - 2));
    counts.forEach(function (cnt, i) {
      var x = padL + band * i + (band - barW) / 2;
      var yTop = yOf(cnt);
      var hh = padT + plotH - yTop;
      if (cnt > 0) {
        s.push('<path d="' + topRounded(x, yTop, barW, Math.max(hh, 2), 4) + '" fill="var(--series-1)" />');
        if (band >= 24) {
          s.push(txt(x + barW / 2, Math.max(yTop - 6, padT - 6), String(cnt),
            { anchor: 'middle', fill: 'var(--text-secondary)', size: 11, weight: 600, tabular: true }));
        }
      }
      var from = lo + bw * i, to = from + bw;
      var key = 'c2-' + i;
      TIPS[key] = '<strong>' + sec(from) + ' 〜 ' + sec(to) + ' 秒</strong>' +
        '<div class="tt-row"><span class="tt-key">サイクル数</span><span class="tt-val">' + cnt + ' 回</span></div>' +
        '<div class="tt-row"><span class="tt-key">構成比</span><span class="tt-val">' +
        (cnt / totals.length * 100).toFixed(0) + ' %</span></div>';
      s.push('<rect class="hit" x="' + nn(padL + band * i) + '" y="' + padT + '" width="' + nn(band) +
        '" height="' + nn(plotH) + '" fill="transparent" data-tip="' + key + '" />');
      if (i % Math.ceil(k / 6) === 0) {
        s.push(txt(padL + band * i, padT + plotH + 16, sec(from, 1), { anchor: 'middle' }));
      }
    });
    s.push(txt(padL + plotW, padT + plotH + 16, sec(hi, 1), { anchor: 'end' }));

    // 平均線・タクト線（縦）
    var vlines = [{ v: st.mean, color: 'var(--text-secondary)', dash: '', label: '平均 ' + sec(st.mean), width: 1.5, side: -1 }];
    if (tt && tt >= lo && tt <= hi) {
      vlines.push({ v: tt, color: 'var(--critical)', dash: '6 4', label: 'TT ' + sec(tt), width: 2, side: 1 });
    }
    vlines.forEach(function (L) {
      var x = xOf(L.v);
      s.push('<line x1="' + nn(x) + '" y1="' + nn(padT - 4) + '" x2="' + nn(x) + '" y2="' + nn(padT + plotH) +
        '" stroke="' + L.color + '" stroke-width="' + L.width + '"' +
        (L.dash ? ' stroke-dasharray="' + L.dash + '"' : '') + ' />');
      s.push(txt(x + L.side * 5, padT - 20, L.label,
        { anchor: L.side < 0 ? 'end' : 'start', fill: 'var(--text-secondary)', size: 11, tabular: true }));
    });

    s.push('</svg>');
    host.innerHTML = s.join('');
    sub.textContent = '縦軸：サイクル数　横軸：秒（有効 ' + totals.length + ' サイクル / ' + k + '区間）';
  }

  /* ---------------------------------------------- ③ 要素作業ごとの平均時間 */
  function renderElementChart() {
    var fig = $('fig-elements');
    var host = $('chart-elements');
    var sub = $('fig3-sub');
    var els = elements();
    var act = activeCycles();
    if (els.length < 2 || !act.length) { fig.hidden = true; host.innerHTML = ''; return; }
    fig.hidden = false;

    var rows = els.map(function (e, i) {
      var vals = act.map(function (c) { return durationsOf(c)[i]; }).filter(function (v) { return v != null; });
      return { name: e.name, i: i, st: stats(vals) };
    });
    var maxV = Math.max.apply(null, rows.map(function (r) { return r.st.max; }));
    var scale = niceScale(maxV / 1000 * 1.02, 4);

    var w = chartWidth(host);
    var rowH = 34;
    var padT = 10, padB = 30;
    var labelW = Math.min(150, Math.max(70, Math.floor(w * 0.26)));
    var padL = labelW + 8, padR = 72;
    var plotW = w - padL - padR;
    var h = padT + rows.length * rowH + padB;
    var xOf = function (v) { return padL + (v / (scale.max * 1000)) * plotW; };
    var totalMean = stats(act.map(totalOf)).mean;

    var s = ['<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="要素作業ごとの平均時間">'];
    scale.ticks.forEach(function (t) {
      var x = xOf(t * 1000);
      s.push('<line x1="' + nn(x) + '" y1="' + padT + '" x2="' + nn(x) + '" y2="' + nn(padT + rows.length * rowH) +
        '" stroke="var(--grid)" stroke-width="1" />');
      s.push(txt(x, padT + rows.length * rowH + 16, tickLabel(t), { anchor: 'middle', tabular: true }));
    });
    s.push('<line x1="' + padL + '" y1="' + padT + '" x2="' + padL + '" y2="' +
      nn(padT + rows.length * rowH) + '" stroke="var(--axis)" stroke-width="1" />');

    var barH = Math.min(24, rowH - 12);
    rows.forEach(function (r, i) {
      var cy = padT + rowH * i + rowH / 2;
      var y = cy - barH / 2;
      var bw = Math.max(2, xOf(r.st.mean) - padL);
      s.push(txt(padL - 10, cy, clipName(r.name, Math.max(4, Math.floor(labelW / 13))),
        { anchor: 'end', baseline: 'middle', fill: 'var(--text-primary)', size: 12 }));
      s.push('<path d="' + rightRounded(padL, y, bw, barH, 4) + '" fill="' + seriesVar(r.i) + '" />');
      // 最小〜最大のひげ
      if (r.st.max > r.st.min) {
        var x1 = xOf(r.st.min), x2 = xOf(r.st.max);
        s.push('<line x1="' + nn(x1) + '" y1="' + nn(cy) + '" x2="' + nn(x2) + '" y2="' + nn(cy) +
          '" stroke="var(--surface-1)" stroke-width="4" />');
        s.push('<line x1="' + nn(x1) + '" y1="' + nn(cy) + '" x2="' + nn(x2) + '" y2="' + nn(cy) +
          '" stroke="var(--text-secondary)" stroke-width="1.5" />');
        [x1, x2].forEach(function (xx) {
          s.push('<line x1="' + nn(xx) + '" y1="' + nn(cy - 5) + '" x2="' + nn(xx) + '" y2="' + nn(cy + 5) +
            '" stroke="var(--text-secondary)" stroke-width="1.5" />');
        });
      }
      s.push(txt(Math.max(xOf(r.st.max), padL + bw) + 8, cy, sec(r.st.mean) + ' 秒',
        { baseline: 'middle', fill: 'var(--text-primary)', size: 12, weight: 600, tabular: true }));

      var key = 'c3-' + i;
      TIPS[key] = '<strong>' + esc(r.name) + '</strong>' +
        '<div class="tt-row"><span class="tt-key">平均</span><span class="tt-val">' + fmtTime(r.st.mean) + ' 秒</span></div>' +
        '<div class="tt-row"><span class="tt-key">最小 / 最大</span><span class="tt-val">' + fmtTime(r.st.min) + ' / ' + fmtTime(r.st.max) + '</span></div>' +
        '<div class="tt-row"><span class="tt-key">σ / CV</span><span class="tt-val">' + fmtTime(r.st.sd) + ' / ' + r.st.cv.toFixed(1) + ' %</span></div>' +
        '<div class="tt-row"><span class="tt-key">構成比</span><span class="tt-val">' +
        (totalMean > 0 ? (r.st.mean / totalMean * 100).toFixed(1) : '0.0') + ' %</span></div>';
      s.push('<rect class="hit" x="0" y="' + nn(padT + rowH * i) + '" width="' + w + '" height="' + rowH +
        '" fill="transparent" data-tip="' + key + '" />');
    });
    s.push('</svg>');
    host.innerHTML = s.join('');
    sub.textContent = '横棒＝平均、細線＝最小〜最大（単位：秒）';
  }

  function renderCharts() {
    TIPS = {};
    renderCycleChart();
    renderHistogram();
    renderElementChart();
  }

  /* ------------------------------------------------------------ ツールチップ */
  (function initTooltip() {
    var tip = $('tooltip');
    var current = null;

    function show(key, x, y) {
      if (!TIPS[key]) return;
      if (current !== key) { tip.innerHTML = TIPS[key]; current = key; }
      tip.dataset.show = 'true';
      tip.setAttribute('aria-hidden', 'false');
      var r = tip.getBoundingClientRect();
      var left = Math.min(Math.max(8, x + 14), window.innerWidth - r.width - 8);
      var top = y - r.height - 14;
      if (top < 8) top = y + 20;
      tip.style.left = left + 'px';
      tip.style.top = top + 'px';
    }
    function hide() {
      tip.dataset.show = 'false';
      tip.setAttribute('aria-hidden', 'true');
      current = null;
    }

    document.addEventListener('mousemove', function (e) {
      var t = e.target.closest ? e.target.closest('[data-tip]') : null;
      if (t) show(t.getAttribute('data-tip'), e.clientX, e.clientY); else hide();
    });
    document.addEventListener('touchstart', function (e) {
      var t = e.target.closest ? e.target.closest('[data-tip]') : null;
      if (t) {
        var p = e.touches[0];
        show(t.getAttribute('data-tip'), p.clientX, p.clientY);
      } else hide();
    }, { passive: true });
    window.addEventListener('scroll', hide, { passive: true });
  })();

  /* ============================================================ 書き出し / 読込 */
  function csvCell(v) {
    var s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function csvRow(arr) { return arr.map(csvCell).join(','); }

  function buildCsv(data) {
    var settings = data.settings;
    var cycles = data.cycles;
    var els = settings.elements;
    var multi = els.length > 1;
    var tt = (typeof settings.takt === 'number' && settings.takt > 0) ? settings.takt * 1000 : null;
    var lines = [];
    lines.push(csvRow(['CT Checker サイクルタイム測定']));
    lines.push(csvRow(['工程名/品名', settings.title]));
    lines.push(csvRow(['作業者', settings.operator]));
    lines.push(csvRow(['タクトタイム(秒)', settings.takt == null ? '' : settings.takt]));
    lines.push(csvRow(['備考', settings.memo]));
    lines.push(csvRow(['書き出し日時', fmtDateTime(nowIso())]));
    lines.push('');

    var header = ['No', '記録時刻'];
    if (multi) els.forEach(function (e) { header.push(e.name + '(秒)'); });
    header.push('サイクル(秒)');
    if (tt) header.push('タクト差(秒)');
    header.push('除外', 'メモ');
    lines.push(csvRow(header));

    cycles.forEach(function (c, i) {
      var prev = c.startAcc, d = [];
      c.marks.forEach(function (m) { d.push(m - prev); prev = m; });
      var total = c.marks[c.marks.length - 1] - c.startAcc;
      var row = [i + 1, c.at ? fmtDateTime(c.at) : ''];
      if (multi) els.forEach(function (_, j) { row.push(d[j] != null ? sec(d[j]) : ''); });
      row.push(sec(total));
      if (tt) row.push(sec(total - tt));
      row.push(c.excluded ? '除外' : '', c.note || '');
      lines.push(csvRow(row));
    });

    var totals = cycles.filter(function (c) { return !c.excluded; })
      .map(function (c) { return c.marks[c.marks.length - 1] - c.startAcc; });
    var st = stats(totals);
    lines.push('');
    lines.push(csvRow(['項目', '有効サイクル数', '平均(秒)', '中央値(秒)', '最小(秒)', '最大(秒)', 'レンジ(秒)', '標準偏差(秒)', 'CV(%)']));
    lines.push(csvRow(['サイクル計', st.n, sec(st.mean), sec(st.median), sec(st.min), sec(st.max),
      sec(st.range), sec(st.sd), st.cv.toFixed(1)]));
    if (multi) {
      els.forEach(function (e, j) {
        var vals = cycles.filter(function (c) { return !c.excluded; }).map(function (c) {
          var prev = c.startAcc, dd = [];
          c.marks.forEach(function (m) { dd.push(m - prev); prev = m; });
          return dd[j];
        }).filter(function (v) { return v != null; });
        var es = stats(vals);
        lines.push(csvRow([e.name, es.n, sec(es.mean), sec(es.median), sec(es.min), sec(es.max),
          sec(es.range), sec(es.sd), es.cv.toFixed(1)]));
      });
    }
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  function download(filename, text, mime) {
    var blob = new Blob([text], { type: mime + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function safeName(s) {
    return String(s || '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
  }
  function stamp() {
    var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes());
  }
  function fileBase(settings) {
    return 'CT_' + (safeName(settings.title) || 'measure') + '_' + stamp();
  }

  function exportCsv(data) {
    if (!data.cycles.length) { toast('計測データがありません'); return; }
    download(fileBase(data.settings) + '.csv', buildCsv(data), 'text/csv');
    toast('CSVを書き出しました');
  }

  function exportJson() {
    var payload = {
      app: 'ct-checker', version: 1, exportedAt: nowIso(),
      settings: state.settings, cycles: state.cycles, accBase: elapsed(),
      cycleStart: state.cycleStart, pending: state.pending,
      started: state.started, startedAt: state.startedAt
    };
    download(fileBase(state.settings) + '.json', JSON.stringify(payload, null, 2), 'application/json');
    toast('JSONを書き出しました');
  }

  function importJson(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var d;
      try { d = JSON.parse(reader.result); } catch (e) { toast('JSONを読み込めませんでした'); return; }
      if (!d || !d.settings) { toast('CT Checker の JSON ではありません'); return; }
      if (state.cycles.length && !confirm('現在の計測データを破棄して読み込みます。よろしいですか？')) return;
      state = normalize(d);
      runSince = null;
      syncSettingsInputs();
      render();
      save();
      toast('読み込みました');
    };
    reader.readAsText(file);
  }

  /* ---------------------------------------------------------------- 保存測定 */
  function saveSession() {
    if (!state.cycles.length) { toast('計測データがありません'); return; }
    var def = (state.settings.title || '測定') + ' ' + fmtDateTime(nowIso());
    var name = prompt('保存名を入力してください', def);
    if (name === null) return;
    var list = loadSessions();
    list.unshift({
      id: uid(), name: name || def, savedAt: nowIso(),
      settings: JSON.parse(JSON.stringify(state.settings)),
      cycles: JSON.parse(JSON.stringify(state.cycles))
    });
    saveSessions(list.slice(0, 50));
    renderSessions();
    toast('測定を保存しました');
  }

  function loadSession(id) {
    var s = loadSessions().filter(function (x) { return x.id === id; })[0];
    if (!s) return;
    if (state.cycles.length && !confirm('現在の計測データを破棄して「' + s.name + '」を読み込みます。よろしいですか？')) return;
    var last = s.cycles.length ? s.cycles[s.cycles.length - 1] : null;
    state = normalize({
      settings: s.settings, cycles: s.cycles,
      accBase: last ? last.marks[last.marks.length - 1] : 0,
      cycleStart: last ? last.marks[last.marks.length - 1] : 0,
      pending: [], started: true, startedAt: s.savedAt
    });
    runSince = null;
    syncSettingsInputs();
    render();
    save();
    announce('「' + s.name + '」を読み込みました。続きから計測もできます。');
    toast('読み込みました');
  }

  /* ------------------------------------------------------------------ イベント */
  function bind() {
    $('btn-lap').addEventListener('click', startOrLap);
    $('btn-pause').addEventListener('click', function () { running() ? pause() : resume(); });
    $('btn-undo').addEventListener('click', undo);
    $('btn-discard').addEventListener('click', discardCycle);
    $('btn-reset').addEventListener('click', resetAll);

    document.addEventListener('keydown', function (e) {
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === 'Space' || e.key === ' ' || e.key === 'Enter') { e.preventDefault(); startOrLap(); }
      else if (e.key === 'p' || e.key === 'P') { e.preventDefault(); running() ? pause() : resume(); }
      else if (e.key === 'z' || e.key === 'Z') { e.preventDefault(); undo(); }
    });

    // 設定
    $('in-title').addEventListener('input', function () { state.settings.title = this.value; saveSoon(); });
    $('in-operator').addEventListener('input', function () { state.settings.operator = this.value; saveSoon(); });
    $('in-memo').addEventListener('input', function () { state.settings.memo = this.value; saveSoon(); });
    $('in-takt').addEventListener('input', function () {
      var v = parseFloat(this.value);
      state.settings.takt = (isFinite(v) && v > 0) ? v : null;
      renderReadoutStatic(); renderTiles(); renderTables(); renderCharts();
      saveSoon();
    });

    $('btn-add-element').addEventListener('click', addElement);
    $('in-element').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); addElement(); }
    });

    $('elements-list').addEventListener('click', function (e) {
      var b = e.target.closest('[data-act="del-element"]');
      if (!b) return;
      var i = +b.getAttribute('data-i');
      var els = elements();
      if (els.length <= 1) { toast('要素作業は1つ以上必要です'); return; }
      els.splice(i, 1);
      render(); save();
    });
    $('elements-list').addEventListener('input', function (e) {
      var inp = e.target.closest('[data-act="rename"]');
      if (!inp) return;
      elements()[+inp.getAttribute('data-i')].name = inp.value;
      renderSteps(); renderControls(); renderTables(); renderCharts(); saveSoon();
    });

    // 明細（除外・メモ）
    $('table-cycles').addEventListener('change', function (e) {
      var box = e.target.closest('[data-act="exclude"]');
      if (!box) return;
      state.cycles[+box.getAttribute('data-i')].excluded = box.checked;
      render(); save();
    });
    $('table-cycles').addEventListener('input', function (e) {
      var inp = e.target.closest('[data-act="note"]');
      if (!inp) return;
      state.cycles[+inp.getAttribute('data-i')].note = inp.value;
      saveSoon();
    });

    $('btn-outlier').addEventListener('click', function () {
      var all = state.cycles.map(totalOf);
      if (all.length < 3) { toast('3サイクル以上必要です'); return; }
      var st = stats(all);
      var hit = 0;
      state.cycles.forEach(function (c, i) {
        var out = st.sd > 0 && Math.abs(all[i] - st.mean) > 2 * st.sd;
        c.excluded = out;
        if (out) hit++;
      });
      render(); save();
      toast(hit ? hit + ' サイクルを除外しました' : '±2σを超えるサイクルはありません');
    });
    $('btn-include-all').addEventListener('click', function () {
      state.cycles.forEach(function (c) { c.excluded = false; });
      render(); save();
      toast('除外を解除しました');
    });

    // 書き出し / 読込
    $('btn-csv').addEventListener('click', function () {
      exportCsv({ settings: state.settings, cycles: state.cycles });
    });
    $('btn-json').addEventListener('click', exportJson);
    $('file-json').addEventListener('change', function () {
      if (this.files && this.files[0]) importJson(this.files[0]);
      this.value = '';
    });

    // 保存測定
    $('btn-save-session').addEventListener('click', saveSession);
    $('table-sessions').addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      var id = b.getAttribute('data-id');
      var act = b.getAttribute('data-act');
      if (act === 'load-session') loadSession(id);
      else if (act === 'del-session') {
        var s = loadSessions().filter(function (x) { return x.id === id; })[0];
        if (!s || !confirm('「' + s.name + '」を削除します。よろしいですか？')) return;
        saveSessions(loadSessions().filter(function (x) { return x.id !== id; }));
        renderSessions();
        toast('削除しました');
      } else if (act === 'csv-session') {
        var t = loadSessions().filter(function (x) { return x.id === id; })[0];
        if (t) exportCsv({ settings: normalize({ settings: t.settings, cycles: [] }).settings, cycles: t.cycles });
      }
    });

    // ヘルプ・テーマ
    $('btn-help').addEventListener('click', function () {
      var help = $('help');
      help.hidden = !help.hidden;
      this.setAttribute('aria-expanded', String(!help.hidden));
    });
    $('btn-theme').addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme');
      var next = cur === 'dark' ? 'light' : (cur === 'light' ? '' : 'dark');
      if (next) document.documentElement.setAttribute('data-theme', next);
      else document.documentElement.removeAttribute('data-theme');
      try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* noop */ }
      toast(next === 'dark' ? 'ダークテーマ' : next === 'light' ? 'ライトテーマ' : '端末の設定に従います');
      renderCharts();
    });

    // 再描画（横幅変更）
    var rt = null;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(renderCharts, 150);
    });
    window.addEventListener('beforeunload', save);
  }

  function addElement() {
    var input = $('in-element');
    var name = input.value.trim();
    if (!name) { input.focus(); return; }
    var els = elements();
    if (els.length >= MAX_ELEMENTS) { toast('要素作業は最大 ' + MAX_ELEMENTS + ' 個までです'); return; }
    // 初期値の「1サイクル」しか無い状態なら置き換える
    if (els.length === 1 && els[0].name === '1サイクル' && !state.cycles.length && !state.started) {
      els[0] = { id: uid(), name: name };
    } else {
      els.push({ id: uid(), name: name });
    }
    input.value = '';
    input.focus();
    render(); save();
  }

  /* -------------------------------------------------------------------- 起動 */
  function tick() {
    if (running()) {
      var e = elapsed();
      if (e - lastRenderedElapsed >= 50 || e < lastRenderedElapsed) {
        lastRenderedElapsed = e;
        renderReadout();
      }
    }
    requestAnimationFrame(tick);
  }

  function initTheme() {
    var t;
    try { t = localStorage.getItem(THEME_KEY); } catch (e) { t = null; }
    if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);
  }

  function init() {
    initTheme();
    load();
    syncSettingsInputs();
    bind();
    render();
    renderSessions();
    if (state.started) {
      announce('前回のデータを復元しました（一時停止中）。「再開」で続きから計測できます。');
    }
    setInterval(function () { if (running()) save(); }, 5000);
    requestAnimationFrame(tick);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
