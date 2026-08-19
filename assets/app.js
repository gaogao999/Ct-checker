/* ============================================================================
 * CT Checker — サイクルタイム測定
 * 依存ライブラリなし。ファイルを直接開いても動作します。
 *
 * データモデル
 *   state.processes[]  … 工程。複数登録すると同時計測になる
 *     .elements[]      … 1サイクルを分割する要素作業（1個なら分割なし）
 *     .cycles[]        … { startAcc, marks[], excluded, note, at }
 *   時刻はすべて「計測開始からの累積経過(ms)」。区切り位置だけを持つので
 *   取り消し操作をしても時間のつじつまが合わなくなりません。
 * ==========================================================================*/
(function () {
  'use strict';

  var STORE_KEY = 'ct-checker:v1';
  var SESSION_KEY = 'ct-checker:sessions:v1';
  var THEME_KEY = 'ct-checker:theme';
  var MAX_ELEMENTS = 8;
  var MAX_PROCESSES = 6;
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

  function announce(msg) { $('status-line').textContent = msg; }

  /* ------------------------------------------------------------------ 状態 */
  function newProcess(name) {
    return {
      id: uid(), name: name || '工程1',
      elements: [{ id: uid(), name: '1サイクル' }],
      cycles: [], cycleStart: 0, pending: []
    };
  }

  function defaultState() {
    return {
      settings: { title: '', operator: '', memo: '', takt: null },
      processes: [newProcess('工程1')],
      accBase: 0,
      started: false,
      startedAt: null,
      view: 'all'   // 'all' またはプロセスID
    };
  }

  var state = defaultState();
  var runSince = null;             // 実行中のみ performance.now()
  var lastTickAt = -1;

  function procs() { return state.processes; }
  function multi() { return state.processes.length > 1; }
  function running() { return runSince !== null; }
  function elapsed() {
    return state.accBase + (runSince !== null ? performance.now() - runSince : 0);
  }

  /** 集計・グラフ・明細の表示対象。単一工程なら常にその工程。 */
  function viewAll() { return multi() && state.view === 'all'; }
  function viewProc() {
    if (!multi()) return procs()[0];
    var p = procs().filter(function (x) { return x.id === state.view; })[0];
    return p || procs()[0];
  }
  function procIndex(p) { return procs().indexOf(p); }

  function pElements(p) { return p.elements; }
  function pElemCount(p) { return Math.max(1, p.elements.length); }
  function pCycleElapsed(p) { return elapsed() - p.cycleStart; }
  function pElementElapsed(p) {
    var base = p.pending.length ? p.pending[p.pending.length - 1] : p.cycleStart;
    return elapsed() - base;
  }
  function totalOf(c) { return c.marks[c.marks.length - 1] - c.startAcc; }
  function durationsOf(c) {
    var out = [], prev = c.startAcc;
    for (var i = 0; i < c.marks.length; i++) { out.push(c.marks[i] - prev); prev = c.marks[i]; }
    return out;
  }
  function pActive(p) { return p.cycles.filter(function (c) { return !c.excluded; }); }
  function pTotals(p) { return pActive(p).map(totalOf); }
  function pStats(p) { return stats(pTotals(p)); }

  /** ネック工程（平均が最長の工程）。データが無ければ null。 */
  function neckProcess() {
    var best = null, bestV = -1;
    procs().forEach(function (p) {
      var st = pStats(p);
      if (st.n && st.mean > bestV) { bestV = st.mean; best = p; }
    });
    return best;
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

  /** ラインバランス効率＝各工程の平均の合計 ÷（工程数 × ネック工程の平均） */
  function balanceRate() {
    var means = procs().map(function (p) { return pStats(p); })
      .filter(function (s) { return s.n; }).map(function (s) { return s.mean; });
    if (means.length < 2) return null;
    var max = Math.max.apply(null, means);
    var sum = means.reduce(function (a, b) { return a + b; }, 0);
    return max > 0 ? (sum / (means.length * max)) * 100 : null;
  }

  /* ------------------------------------------------------------------ 保存 */
  var saveTimer = null;
  function snapshot() {
    return {
      version: 2,
      settings: state.settings,
      processes: state.processes,
      accBase: elapsed(),
      started: state.started,
      startedAt: state.startedAt,
      view: state.view
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
      if (d && d.settings) state = normalize(d);
    } catch (e) { /* 壊れたデータは無視 */ }
  }

  function normCycles(list) {
    return (Array.isArray(list) ? list : []).filter(function (c) {
      return c && Array.isArray(c.marks) && c.marks.length && typeof c.startAcc === 'number';
    }).map(function (c) {
      return {
        startAcc: c.startAcc, marks: c.marks.slice(),
        excluded: !!c.excluded, note: String(c.note || ''), at: c.at || null
      };
    });
  }

  function normElements(list) {
    var els = (Array.isArray(list) ? list : []).filter(function (e) { return e && e.name; })
      .slice(0, MAX_ELEMENTS)
      .map(function (e) { return { id: e.id || uid(), name: String(e.name) }; });
    return els.length ? els : [{ id: uid(), name: '1サイクル' }];
  }

  /** v1（単一工程）と v2（複数工程）の両方を受け付ける。 */
  function normalize(d) {
    var s = defaultState();
    var set = d.settings || {};
    s.settings.title = String(set.title || '');
    s.settings.operator = String(set.operator || '');
    s.settings.memo = String(set.memo || '');
    s.settings.takt = (typeof set.takt === 'number' && set.takt > 0) ? set.takt : null;

    var list = Array.isArray(d.processes) ? d.processes : null;
    if (!list) {
      // v1: settings.elements + cycles を 1 工程として取り込む
      list = [{
        id: uid(), name: set.title || '工程1',
        elements: set.elements, cycles: d.cycles,
        cycleStart: d.cycleStart, pending: d.pending
      }];
    }
    s.processes = list.slice(0, MAX_PROCESSES).map(function (p, i) {
      return {
        id: p.id || uid(),
        name: String(p.name || ('工程' + (i + 1))),
        elements: normElements(p.elements),
        cycles: normCycles(p.cycles),
        cycleStart: typeof p.cycleStart === 'number' ? p.cycleStart : 0,
        pending: Array.isArray(p.pending) ? p.pending.slice() : []
      };
    });
    if (!s.processes.length) s.processes = [newProcess('工程1')];

    s.accBase = typeof d.accBase === 'number' ? d.accBase : 0;
    s.started = !!d.started;
    s.startedAt = d.startedAt || null;
    var ids = s.processes.map(function (p) { return p.id; });
    s.view = (d.view === 'all' || ids.indexOf(d.view) >= 0) ? d.view : 'all';
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
  function startMeasure() {
    state.started = true;
    state.startedAt = nowIso();
    state.accBase = 0;
    procs().forEach(function (p) { p.cycleStart = 0; p.pending = []; });
    runSince = performance.now();
    requestWakeLock();
    announce(multi() ? '計測を開始しました。各工程のボタンを押してください。' : '計測を開始しました。');
  }

  /** 工程 p のラップ。未開始なら計測開始、一時停止中なら再開。 */
  function lap(p) {
    if (!state.started) { startMeasure(); }
    else if (!running()) { resume(); return; }
    else {
      var t = elapsed();
      p.pending.push(t);
      if (p.pending.length >= pElemCount(p)) {
        p.cycles.push({
          startAcc: p.cycleStart, marks: p.pending.slice(),
          excluded: false, note: '', at: nowIso()
        });
        p.cycleStart = t;
        p.pending = [];
        var c = p.cycles[p.cycles.length - 1];
        announce((multi() ? p.name + '：' : '') + 'サイクル ' + p.cycles.length +
          ' 完了 ' + fmtTime(totalOf(c)) + ' 秒');
      } else {
        var i = p.pending.length - 1;
        var prev = i > 0 ? p.pending[i - 1] : p.cycleStart;
        announce((multi() ? p.name + '：' : '') + pElements(p)[i].name + ' 完了 ' +
          fmtTime(p.pending[i] - prev) + ' 秒');
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

  function undo(p) {
    if (p.pending.length) {
      p.pending.pop();
      announce((multi() ? p.name + '：' : '') + '直前の区切りを取り消しました。');
    } else if (p.cycles.length) {
      var c = p.cycles.pop();
      p.cycleStart = c.startAcc;
      p.pending = c.marks.slice(0, -1);
      announce((multi() ? p.name + '：' : '') + 'サイクル ' + (p.cycles.length + 1) + ' を取り消しました。');
    } else {
      return;
    }
    render();
    save();
  }

  function discardCycle(p) {
    if (!state.started) return;
    p.pending = [];
    p.cycleStart = elapsed();
    announce((multi() ? p.name + '：' : '') + '現在のサイクルを破棄しました。ここから測り直します。');
    render();
    save();
  }

  function hasData() {
    return procs().some(function (p) { return p.cycles.length > 0; });
  }

  function resetAll() {
    if (hasData() && !confirm('計測データをすべて消去します。よろしいですか？\n（「現在の測定を保存」で残せます）')) return;
    state.started = false;
    state.startedAt = null;
    state.accBase = 0;
    procs().forEach(function (p) { p.cycles = []; p.pending = []; p.cycleStart = 0; });
    runSince = null;
    releaseWakeLock();
    announce('リセットしました。');
    render();
    save();
  }

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
  /** 毎フレーム動かす数字だけを更新する。 */
  function renderReadout() {
    if (multi()) {
      $('multi-total').textContent = fmtTime(elapsed());
      procs().forEach(function (p, i) {
        var el = $('ptime-' + i);
        if (el) el.firstChild.nodeValue = state.started ? fmtTime(pCycleElapsed(p)) : '0.00';
      });
      return;
    }
    var p0 = procs()[0];
    $('readout-cycle').textContent = state.started ? fmtTime(pCycleElapsed(p0)) : '0.00';
    $('readout-elem').textContent = state.started ? fmtTime(pElementElapsed(p0)) : '0.00';
    $('readout-total').textContent = fmtTime(elapsed());
  }

  function renderMeasure() {
    var isMulti = multi();
    $('measure-single').hidden = isMulti;
    $('measure-multi').hidden = !isMulti;
    if (isMulti) renderCards(); else renderSingleMeasure();
    renderControls();
    renderReadout();
  }

  function renderSingleMeasure() {
    var p = procs()[0];
    var els = pElements(p);
    var idx = Math.min(p.pending.length, els.length - 1);
    $('readout-elem-name').textContent = state.started ? els[idx].name : '—';
    $('readout-count').textContent = String(p.cycles.length);

    var last = p.cycles.length ? p.cycles[p.cycles.length - 1] : null;
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
        var act = pActive(p);
        if (act.length > 1) {
          base = stats(act.filter(function (c) { return c !== last; }).map(totalOf)).mean;
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

    // 要素作業の進行
    var host = $('steps');
    if (els.length < 2) { host.innerHTML = ''; host.hidden = true; }
    else {
      host.hidden = false;
      host.innerHTML = els.map(function (el, i) {
        var cls = 'step', time = '';
        if (state.started && i < p.pending.length) {
          cls += ' step--done';
          var prev = i ? p.pending[i - 1] : p.cycleStart;
          time = '<span class="step__time">' + fmtTime(p.pending[i] - prev) + '</span>';
        } else if (state.started && i === p.pending.length) {
          cls += ' step--current';
        }
        return '<span class="' + cls + '" role="listitem">' +
          '<span class="step__dot" style="background:' + seriesVar(i) + '"></span>' +
          '<span>' + esc(el.name) + '</span>' + time + '</span>';
      }).join('');
    }

    // 大ボタン
    var main = $('lap-btn-main'), sub = $('lap-btn-sub'), btn = $('btn-lap');
    if (!state.started) {
      main.textContent = '計測開始';
      sub.textContent = 'Space キーでも操作できます';
      btn.dataset.paused = 'false';
    } else if (!running()) {
      main.textContent = '再開';
      sub.textContent = '一時停止中';
      btn.dataset.paused = 'true';
    } else {
      btn.dataset.paused = 'false';
      var i2 = p.pending.length;
      if (els.length < 2) {
        main.textContent = 'サイクル完了';
        sub.textContent = p.cycles.length + ' サイクル計測済み';
      } else {
        main.textContent = els[i2].name + (i2 === els.length - 1 ? ' 完了 → 1サイクル終了' : ' 完了 → 次へ');
        sub.textContent = (i2 + 1) + ' / ' + els.length + ' 番目の要素作業';
      }
    }
  }

  function renderCards() {
    var tt = taktMs();
    var neck = neckProcess();
    var html = procs().map(function (p, i) {
      var st = pStats(p);
      var els = pElements(p);
      var last = p.cycles.length ? totalOf(p.cycles[p.cycles.length - 1]) : null;
      var label;
      if (!state.started) label = '計測開始';
      else if (!running()) label = '再開';
      else if (els.length < 2) label = 'サイクル完了';
      else label = els[Math.min(p.pending.length, els.length - 1)].name + '完了';

      var badges = '';
      if (neck === p && st.n) badges += '<span class="badge">ネック</span>';
      if (tt && st.n && st.mean > tt) badges += '<span class="badge badge--muted">TT超過</span>';

      var elemLine = '';
      if (els.length > 1) {
        elemLine = '<div class="pcard__elem">' +
          (state.started ? (p.pending.length + 1) + '/' + els.length + '　' +
            esc(els[Math.min(p.pending.length, els.length - 1)].name) : '要素 ' + els.length + ' 個') +
          '</div>';
      }

      return '<div class="pcard" data-i="' + i + '" data-neck="' + (neck === p && st.n ? 'true' : 'false') +
        '" style="--pc:' + seriesVar(i) + '">' +
        '<div class="pcard__head">' +
          '<span class="pcard__name">' + esc(p.name) + '</span>' + badges +
          '<span class="pcard__key">' + (i + 1) + '</span>' +
        '</div>' +
        '<div class="pcard__time" id="ptime-' + i + '">0.00<small>秒</small></div>' +
        elemLine +
        '<button type="button" class="pcard__btn" data-act="lap" data-i="' + i + '"' +
          (state.started && running() ? '' : ' data-idle="true"') + '>' + esc(label) + '</button>' +
        '<div class="pcard__foot">' +
          '<span class="pcard__stat">' + st.n + ' 回</span>' +
          '<span class="pcard__stat">直前 <b>' + (last == null ? '—' : fmtTime(last)) + '</b></span>' +
          '<span class="pcard__stat">平均 <b>' + (st.n ? fmtTime(st.mean) : '—') + '</b></span>' +
          '<button type="button" class="btn btn--sm" data-act="undo" data-i="' + i + '">取消</button>' +
          '<button type="button" class="btn btn--sm" data-act="discard" data-i="' + i + '">破棄</button>' +
        '</div>' +
      '</div>';
    }).join('');
    $('pcards').innerHTML = html;
    $('multi-hint').textContent = state.started
      ? '各工程のボタン（またはキーボードの数字）を、その工程が1サイクル終わるたびに押してください。'
      : 'どれかのボタンを押すと全工程の時計が同時に動きだします。';
  }

  function renderControls() {
    var p0 = procs()[0];
    $('btn-pause').disabled = !state.started;
    $('btn-pause').textContent = (state.started && !running()) ? '再開' : '一時停止';
    $('btn-undo').hidden = multi();
    $('btn-discard').hidden = multi();
    $('btn-undo').disabled = !(p0.pending.length || p0.cycles.length);
    $('btn-discard').disabled = !state.started;
    $('btn-reset').disabled = !state.started && !hasData();
    $('controls').style.gridTemplateColumns = multi() ? 'repeat(2, minmax(0, 1fr))' : '';
  }

  /* ============================================================== 表示切替 */
  var SCOPE_IDS = ['scope-stats', 'scope-charts', 'scope-table'];
  function setScope(html) {
    SCOPE_IDS.forEach(function (id) { $(id).innerHTML = html; });
  }

  function renderViewSwitch() {
    var host = $('viewswitch');
    if (!multi()) {
      host.hidden = true;
      $('viewswitch-chips').innerHTML = '';
      setScope('');
      return;
    }
    host.hidden = false;
    var chips = ['<button type="button" class="chip" role="tab" data-view="all" aria-selected="' +
      (state.view === 'all') + '">ライン全体</button>'];
    procs().forEach(function (p, i) {
      chips.push('<button type="button" class="chip" role="tab" data-view="' + esc(p.id) +
        '" aria-selected="' + (state.view === p.id) + '">' +
        '<span class="swatch" style="background:' + seriesVar(i) + '"></span>' + esc(p.name) + '</button>');
    });
    $('viewswitch-chips').innerHTML = chips.join('');

    setScope(viewAll()
      ? 'ライン全体（' + procs().length + ' 工程）'
      : '<span class="swatch" style="background:' + seriesVar(procIndex(viewProc())) + '"></span>' +
        esc(viewProc().name));
  }

  /* ============================================================== 描画：集計 */
  function tile(label, value, unit, note, cls) {
    return '<div class="tile' + (cls ? ' ' + cls : '') + '">' +
      '<span class="tile__label">' + esc(label) + '</span>' +
      '<span class="tile__value">' + value + (unit ? '<small>' + unit + '</small>' : '') + '</span>' +
      (note ? '<span class="tile__note">' + note + '</span>' : '') + '</div>';
  }

  function renderTiles() {
    $('stats-actions').hidden = viewAll();
    if (viewAll()) renderLineTiles(); else renderProcTiles(viewProc());
  }

  /** ライン全体：ネック工程とバランスを主役にする。 */
  function renderLineTiles() {
    var host = $('tiles');
    var tt = taktMs();
    var neck = neckProcess();
    if (!neck) {
      host.innerHTML = tile('ネック工程', '—', '', '計測データがありません', 'tile--hero');
      $('takt-bar').innerHTML = '';
      return;
    }
    var neckSt = pStats(neck);
    var withData = procs().filter(function (p) { return pStats(p).n; });
    var sumMean = withData.reduce(function (a, p) { return a + pStats(p).mean; }, 0);
    var over = tt ? withData.filter(function (p) { return pStats(p).mean > tt; }) : [];
    var bal = balanceRate();

    var html = '';
    html += tile('ネック工程（最長）', esc(neck.name), '',
      '平均 ' + fmtTime(neckSt.mean) + ' 秒／ラインの生産ペースを決めます', 'tile--hero');
    html += tile('ラインバランス効率', bal == null ? '—' : bal.toFixed(1), bal == null ? '' : '%',
      bal == null ? '2工程以上で算出' : '100 % に近いほど工数の偏りが小さい');
    html += tile('工程平均の合計', fmtTime(sumMean), '秒', withData.length + ' 工程の平均を合計');
    html += tile('工程間の差', fmtTime(neckSt.mean - Math.min.apply(null,
      withData.map(function (p) { return pStats(p).mean; }))), '秒', '最長工程 − 最短工程');
    if (tt) {
      html += tile('タクト超過の工程', over.length + ' <small>/ ' + withData.length + '</small>', '工程',
        over.length ? over.map(function (p) { return esc(p.name); }).join('、') : 'すべてタクト内');
    } else {
      html += tile('総観測時間', fmtTime(elapsed()), '秒', 'タクトタイム未設定');
    }
    host.innerHTML = html;
    renderTaktBar(neckSt, tt, 'ネック工程 ' + neck.name);
  }

  function renderProcTiles(p) {
    var host = $('tiles');
    var s = pStats(p);
    var tt = taktMs();
    if (!s.n) {
      host.innerHTML = tile('平均サイクルタイム', '—', '', '計測データがありません', 'tile--hero');
      $('takt-bar').innerHTML = '';
      return;
    }
    var totals = pTotals(p);
    var excluded = p.cycles.length - s.n;
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
    renderTaktBar(s, tt, multi() ? p.name : null);
  }

  function renderTaktBar(s, tt, label) {
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
        '<span>' + judge + '　' + (label ? esc(label) + ' の' : '') + '平均 ' + fmtTime(s.mean) +
          ' 秒 / タクト ' + fmtTime(tt) + ' 秒</span>' +
        '<span>' + (diff >= 0 ? '余裕 ' : '不足 ') + fmtTime(Math.abs(diff)) + ' 秒（タクト比 ' +
          (ratio * 100).toFixed(1) + ' %）</span>' +
      '</div>';
  }

  /* ============================================================== 描画：明細 */
  function renderTables() {
    var all = viewAll();
    $('table-summary-wrap').hidden = !all;
    $('table-matrix-wrap').hidden = !all;
    $('table-cycles-wrap').hidden = all;
    if (all) { renderSummaryTable(); renderMatrixTable(); $('table-elements-wrap').hidden = true; }
    else renderCycleTable(viewProc());
  }

  function renderSummaryTable() {
    var tt = taktMs();
    var neck = neckProcess();
    var head = '<thead><tr><th>工程</th><th>サイクル</th><th>平均（秒）</th><th>中央値</th><th>最小</th><th>最大</th>' +
      '<th>σ</th><th>CV</th>' + (tt ? '<th>タクト差</th><th>判定</th>' : '') + '</tr></thead>';
    var body = procs().map(function (p, i) {
      var s = pStats(p);
      var cells = '<td><span class="swatch-cell"><span class="swatch" style="background:' + seriesVar(i) +
        '"></span>' + esc(p.name) + (neck === p && s.n ? ' <span class="badge">ネック</span>' : '') + '</span></td>';
      if (!s.n) {
        cells += '<td class="num">0</td><td colspan="' + (6 + (tt ? 2 : 0)) + '">—</td>';
        return '<tr>' + cells + '</tr>';
      }
      cells += '<td class="num">' + s.n + '</td>' +
        '<td class="num">' + sec(s.mean) + '</td><td class="num">' + sec(s.median) + '</td>' +
        '<td class="num">' + sec(s.min) + '</td><td class="num">' + sec(s.max) + '</td>' +
        '<td class="num">' + sec(s.sd) + '</td><td class="num">' + s.cv.toFixed(1) + ' %</td>';
      if (tt) {
        var d = s.mean - tt;
        cells += '<td class="num">' + (d > 0 ? '<span class="flag flag--over">▲ +' + sec(d) + '</span>' : sec(d)) + '</td>' +
          '<td>' + (d > 0 ? '<span class="judge judge--ng">▲ 超過</span>' : '<span class="judge judge--ok">✔ 可</span>') + '</td>';
      }
      return '<tr>' + cells + '</tr>';
    }).join('');
    $('table-summary').innerHTML = head + '<tbody>' + body + '</tbody>';
  }

  function renderMatrixTable() {
    var maxN = Math.max.apply(null, procs().map(function (p) { return p.cycles.length; }).concat([0]));
    var head = '<thead><tr><th>No</th>' + procs().map(function (p, i) {
      return '<th><span class="swatch-cell"><span class="swatch" style="background:' + seriesVar(i) +
        '"></span>' + esc(p.name) + '（秒）</span></th>';
    }).join('') + '</tr></thead>';
    var body = '';
    if (!maxN) {
      body = '<tr class="empty-row"><td colspan="' + (procs().length + 1) + '">まだ計測データがありません</td></tr>';
    } else {
      for (var r = 0; r < maxN; r++) {
        body += '<tr><td>' + (r + 1) + '</td>' + procs().map(function (p) {
          var c = p.cycles[r];
          if (!c) return '<td class="num">—</td>';
          return '<td class="num"' + (c.excluded ? ' style="color:var(--text-muted);text-decoration:line-through"' : '') +
            '>' + sec(totalOf(c)) + '</td>';
        }).join('') + '</tr>';
      }
      body += '<tr><td>平均</td>' + procs().map(function (p) {
        var s = pStats(p);
        return '<td class="num">' + (s.n ? sec(s.mean) : '—') + '</td>';
      }).join('') + '</tr>';
    }
    $('table-matrix').innerHTML = head + '<tbody>' + body + '</tbody>';
  }

  function renderCycleTable(p) {
    var els = pElements(p);
    var multiEl = els.length > 1;
    var tt = taktMs();

    var head = '<thead><tr><th>No</th>';
    if (multiEl) {
      els.forEach(function (e, i) {
        head += '<th><span class="swatch-cell"><span class="swatch" style="background:' + seriesVar(i) +
          '"></span>' + esc(e.name) + '</span></th>';
      });
    }
    head += '<th>サイクル（秒）</th>' + (tt ? '<th>タクト差</th>' : '') + '<th>除外</th><th>メモ</th></tr></thead>';

    var body = '';
    if (!p.cycles.length) {
      body = '<tr class="empty-row"><td colspan="' + (3 + (multiEl ? els.length : 0) + (tt ? 1 : 0)) +
        '">まだ計測データがありません</td></tr>';
    } else {
      p.cycles.forEach(function (c, i) {
        var d = durationsOf(c);
        var total = totalOf(c);
        var row = '<tr data-excluded="' + (c.excluded ? 'true' : 'false') + '"><td>' + (i + 1) + '</td>';
        if (multiEl) {
          for (var k = 0; k < els.length; k++) row += '<td class="num">' + (d[k] != null ? sec(d[k]) : '—') + '</td>';
        }
        row += '<td class="num">' + sec(total) + '</td>';
        if (tt) {
          var diff = total - tt;
          row += '<td class="num">' + (diff > 0
            ? '<span class="flag flag--over">▲ +' + sec(diff) + '</span>' : sec(diff)) + '</td>';
        }
        row += '<td><input type="checkbox" data-act="exclude" data-i="' + i + '"' +
          (c.excluded ? ' checked' : '') + ' aria-label="サイクル ' + (i + 1) + ' を統計から除外"></td>';
        row += '<td><input class="note-input" type="text" data-act="note" data-i="' + i +
          '" value="' + esc(c.note) + '" placeholder="—" aria-label="サイクル ' + (i + 1) + ' のメモ"></td></tr>';
        body += row;
      });
    }

    var foot = '';
    var act = pActive(p);
    if (act.length) {
      var s = stats(act.map(totalOf));
      foot = '<tfoot><tr><td>平均</td>';
      if (multiEl) {
        els.forEach(function (e, i) {
          var vals = act.map(function (c) { return durationsOf(c)[i]; })
            .filter(function (v) { return v != null; });
          foot += '<td class="num">' + (vals.length ? sec(stats(vals).mean) : '—') + '</td>';
        });
      }
      foot += '<td class="num">' + sec(s.mean) + '</td>';
      if (tt) foot += '<td class="num">' + sec(s.mean - tt) + '</td>';
      foot += '<td colspan="2">有効 ' + s.n + ' / ' + p.cycles.length + '</td></tr></tfoot>';
    }
    $('table-cycles').innerHTML = head + '<tbody>' + body + '</tbody>' + foot;

    // 要素別統計
    var wrap = $('table-elements-wrap');
    if (!multiEl || !act.length) { wrap.hidden = true; $('table-elements').innerHTML = ''; return; }
    wrap.hidden = false;
    var totalMean = stats(act.map(totalOf)).mean;
    var eh = '<thead><tr><th>要素作業</th><th>平均（秒）</th><th>最小</th><th>最大</th><th>σ</th><th>CV</th><th>構成比</th></tr></thead><tbody>';
    els.forEach(function (e, i) {
      var vals = act.map(function (c) { return durationsOf(c)[i]; }).filter(function (v) { return v != null; });
      var st = stats(vals);
      eh += '<tr><td><span class="swatch-cell"><span class="swatch" style="background:' + seriesVar(i) +
        '"></span>' + esc(e.name) + '</span></td>' +
        '<td class="num">' + sec(st.mean) + '</td><td class="num">' + sec(st.min) + '</td>' +
        '<td class="num">' + sec(st.max) + '</td><td class="num">' + sec(st.sd) + '</td>' +
        '<td class="num">' + st.cv.toFixed(1) + ' %</td>' +
        '<td class="num">' + (totalMean > 0 ? (st.mean / totalMean * 100).toFixed(1) : '0.0') + ' %</td></tr>';
    });
    $('table-elements').innerHTML = eh + '</tbody>';
  }

  /* ========================================================== 描画：設定・保存 */
  function renderProcList() {
    var locked = state.started || hasData();
    var list = procs();
    $('proc-list').innerHTML = list.map(function (p, i) {
      var els = pElements(p);
      var elemHtml = els.map(function (e, j) {
        return '<li class="elements__item">' +
          '<span class="elements__index">' + (j + 1) + '</span>' +
          '<span class="swatch" style="background:' + seriesVar(j) + '"></span>' +
          '<input type="text" value="' + esc(e.name) + '" data-act="rename-element" data-p="' + i +
            '" data-i="' + j + '" maxlength="24" aria-label="' + esc(p.name) + ' の要素作業 ' + (j + 1) + '"' +
            (locked ? ' disabled' : '') + '>' +
          (locked ? '' : '<button type="button" class="btn btn--icon" data-act="del-element" data-p="' + i +
            '" data-i="' + j + '" aria-label="要素作業を削除">✕</button>') +
          '</li>';
      }).join('');

      return '<div class="proc" style="--pc:' + seriesVar(i) + '">' +
        '<div class="proc__head">' +
          '<span class="elements__index">' + (i + 1) + '</span>' +
          '<input type="text" value="' + esc(p.name) + '" data-act="rename-proc" data-p="' + i +
            '" maxlength="20" aria-label="工程 ' + (i + 1) + ' の名前"' + (locked ? ' disabled' : '') + '>' +
          (locked || list.length < 2 ? '' :
            '<button type="button" class="btn btn--icon" data-act="del-proc" data-p="' + i +
            '" aria-label="工程を削除">✕</button>') +
        '</div>' +
        '<div class="proc__body">' +
          '<span class="proc__label">要素作業（' + els.length + '）— 1個なら1タップで1サイクル</span>' +
          '<ul class="elements__list">' + elemHtml + '</ul>' +
          (locked ? '' :
            '<div class="elements__add">' +
              '<input type="text" data-act="new-element" data-p="' + i +
                '" placeholder="要素作業名を追加（例）部品セット" maxlength="24"' +
                (els.length >= MAX_ELEMENTS ? ' disabled' : '') + '>' +
              '<button type="button" class="btn" data-act="add-element" data-p="' + i + '"' +
                (els.length >= MAX_ELEMENTS ? ' disabled' : '') + '>追加</button>' +
            '</div>') +
        '</div>' +
      '</div>';
    }).join('');

    $('in-proc').disabled = locked || list.length >= MAX_PROCESSES;
    $('btn-add-proc').disabled = locked || list.length >= MAX_PROCESSES;
    var hint = $('proc-hint');
    if (locked) {
      hint.textContent = '計測データがあるため工程構成は変更できません。変更するには「リセット」してください。';
      hint.className = 'hint hint--warn';
    } else if (list.length >= MAX_PROCESSES) {
      hint.textContent = '工程は最大 ' + MAX_PROCESSES + ' 個までです。';
      hint.className = 'hint hint--warn';
    } else {
      hint.textContent = '工程を2つ以上登録すると、1画面で同時に計測してネック工程を比較できます。' +
        '1工程だけなら要素作業に分けた時間観測になります。';
      hint.className = 'hint';
    }
  }

  function renderSessions() {
    var list = loadSessions();
    var t = $('table-sessions');
    var head = '<thead><tr><th>名前</th><th>保存日時</th><th>工程</th><th>サイクル</th><th>ネック工程の平均（秒）</th><th>操作</th></tr></thead>';
    if (!list.length) {
      t.innerHTML = head + '<tbody><tr class="empty-row"><td colspan="6">保存した測定はありません</td></tr></tbody>';
      return;
    }
    var body = list.map(function (s) {
      var st = normalize(s.data || s);
      var total = 0, neckMean = 0, neckName = '—';
      st.processes.forEach(function (p) {
        total += p.cycles.length;
        var ps = stats(p.cycles.filter(function (c) { return !c.excluded; }).map(totalOf));
        if (ps.n && ps.mean > neckMean) { neckMean = ps.mean; neckName = p.name; }
      });
      return '<tr><td>' + esc(s.name) + '</td><td>' + fmtDateTime(s.savedAt) + '</td>' +
        '<td class="num">' + st.processes.length + '</td><td class="num">' + total + '</td>' +
        '<td class="num">' + (neckMean ? esc(neckName) + ' ' + sec(neckMean) : '—') + '</td>' +
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
    renderMeasure();
    renderViewSwitch();
    renderTiles();
    renderTables();
    renderProcList();
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

  function markEmpty(id) {
    var host = $(id);
    host.dataset.state = 'empty';
    host.innerHTML = '';
  }

  /* -------------------------------------------- ① 工程別の平均（山積み表） */
  function renderBalanceChart() {
    var host = $('chart-balance');
    var withData = procs().filter(function (p) { return pStats(p).n; });
    if (!withData.length) {
      markEmpty('chart-balance');
      $('legend-balance').innerHTML = ''; $('fig-balance-sub').textContent = '';
      return;
    }
    host.dataset.state = '';

    var tt = taktMs();
    var neck = neckProcess();
    var rows = procs().map(function (p, i) { return { p: p, i: i, st: pStats(p) }; });
    var dataMax = Math.max.apply(null, rows.map(function (r) { return r.st.max || 0; }).concat(tt ? [tt] : []));
    var scale = niceScale(dataMax / 1000 * 1.02, 5);
    var yMax = scale.max * 1000;

    var w = chartWidth(host), h = 300;
    var padL = 48, padR = 66, padT = 34, padB = 46;   // 上端はラベル帯として空ける
    var plotW = w - padL - padR, plotH = h - padT - padB;
    var yOf = function (v) { return padT + plotH - (v / yMax) * plotH; };

    var s = ['<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="工程ごとの平均サイクルタイム">'];
    scale.ticks.forEach(function (t) {
      var y = yOf(t * 1000);
      s.push('<line x1="' + padL + '" y1="' + nn(y) + '" x2="' + nn(padL + plotW) + '" y2="' + nn(y) +
        '" stroke="var(--grid)" stroke-width="1" />');
      s.push(txt(padL - 8, y, tickLabel(t), { anchor: 'end', baseline: 'middle', tabular: true }));
    });
    s.push('<line x1="' + padL + '" y1="' + nn(padT + plotH) + '" x2="' + nn(padL + plotW) +
      '" y2="' + nn(padT + plotH) + '" stroke="var(--axis)" stroke-width="1" />');

    var band = plotW / rows.length;
    var barW = Math.min(56, Math.max(10, band * 0.5));
    rows.forEach(function (r, k) {
      var cx = padL + band * (k + 0.5);
      var x = cx - barW / 2;
      if (r.st.n) {
        var yTop = yOf(r.st.mean);
        s.push('<path d="' + topRounded(x, yTop, barW, padT + plotH - yTop, 4) +
          '" fill="' + seriesVar(r.i) + '" />');
        // 最小〜最大のひげ
        if (r.st.max > r.st.min) {
          var y1 = yOf(r.st.min), y2 = yOf(r.st.max);
          s.push('<line x1="' + nn(cx) + '" y1="' + nn(y1) + '" x2="' + nn(cx) + '" y2="' + nn(y2) +
            '" stroke="var(--surface-1)" stroke-width="4" />');
          s.push('<line x1="' + nn(cx) + '" y1="' + nn(y1) + '" x2="' + nn(cx) + '" y2="' + nn(y2) +
            '" stroke="var(--text-secondary)" stroke-width="1.5" />');
          [y1, y2].forEach(function (yy) {
            s.push('<line x1="' + nn(cx - 5) + '" y1="' + nn(yy) + '" x2="' + nn(cx + 5) + '" y2="' + nn(yy) +
              '" stroke="var(--text-secondary)" stroke-width="1.5" />');
          });
        }
        var labelY = Math.max(yOf(r.st.max) - 10, 24);
        s.push(txt(cx, labelY, sec(r.st.mean),
          { anchor: 'middle', fill: 'var(--text-primary)', size: 12, weight: 600, tabular: true }));
        if (neck === r.p) {
          s.push(txt(cx, labelY - 15, '▲ ネック',
            { anchor: 'middle', fill: 'var(--critical)', size: 11, weight: 700 }));
        }
      } else {
        s.push(txt(cx, padT + plotH - 8, '未計測', { anchor: 'middle' }));
      }
      s.push(txt(cx, padT + plotH + 18, clipName(r.p.name, Math.max(4, Math.floor(band / 13))),
        { anchor: 'middle', fill: 'var(--text-primary)', size: 12 }));

      var key = 'b-' + k;
      TIPS[key] = '<strong>' + esc(r.p.name) + '</strong>' + (r.st.n
        ? '<div class="tt-row"><span class="tt-key">平均</span><span class="tt-val">' + fmtTime(r.st.mean) + ' 秒</span></div>' +
          '<div class="tt-row"><span class="tt-key">最小 / 最大</span><span class="tt-val">' + fmtTime(r.st.min) + ' / ' + fmtTime(r.st.max) + '</span></div>' +
          '<div class="tt-row"><span class="tt-key">σ / CV</span><span class="tt-val">' + fmtTime(r.st.sd) + ' / ' + r.st.cv.toFixed(1) + ' %</span></div>' +
          '<div class="tt-row"><span class="tt-key">サイクル数</span><span class="tt-val">' + r.st.n + ' 回</span></div>' +
          (tt ? '<div class="tt-row"><span class="tt-key">タクト差</span><span class="tt-val" style="color:' +
            (r.st.mean > tt ? 'var(--critical)' : 'var(--success-text)') + '">' +
            (r.st.mean > tt ? '▲ +' : '') + fmtTime(r.st.mean - tt) + '</span></div>' : '')
        : '<div class="tt-row"><span class="tt-key">状態</span><span>未計測</span></div>');
      s.push('<rect class="hit" x="' + nn(padL + band * k) + '" y="' + padT + '" width="' + nn(band) +
        '" height="' + nn(plotH) + '" fill="transparent" data-tip="' + key + '" />');
    });

    if (tt) {
      var yt = yOf(tt);
      s.push('<line x1="' + padL + '" y1="' + nn(yt) + '" x2="' + nn(padL + plotW) + '" y2="' + nn(yt) +
        '" stroke="var(--critical)" stroke-width="2" stroke-dasharray="6 4" />');
      s.push(txt(padL + plotW + 7, yt, 'TT ' + fmtTime(tt),
        { baseline: 'middle', fill: 'var(--text-secondary)', size: 11, tabular: true }));
    }
    s.push('</svg>');
    host.innerHTML = s.join('');

    var lg = ['<span class="legend__item">横棒＝平均、細線＝最小〜最大</span>'];
    if (tt) lg.push('<span class="legend__item" style="color:var(--critical)"><span class="legend__swatch legend__swatch--dash"></span><span style="color:var(--text-secondary)">タクトタイム</span></span>');
    lg.push('<span class="legend__item"><span style="color:var(--critical)">▲</span>ネック工程（最長）</span>');
    $('legend-balance').innerHTML = lg.join('');
    var bal = balanceRate();
    $('fig-balance-sub').textContent = '縦軸：秒' + (bal == null ? '' : '　ラインバランス効率 ' + bal.toFixed(1) + ' %');
  }

  /* -------------------------------------------- ② 工程別サイクルタイム推移 */
  function renderTrendChart() {
    var host = $('chart-trend');
    var maxN = Math.max.apply(null, procs().map(function (p) { return p.cycles.length; }).concat([0]));
    if (maxN < 2) {
      markEmpty('chart-trend'); $('legend-trend').innerHTML = ''; $('fig-trend-sub').textContent = '';
      return;
    }
    host.dataset.state = '';

    var tt = taktMs();
    var all = [];
    procs().forEach(function (p) { p.cycles.forEach(function (c) { all.push(totalOf(c)); }); });
    var dataMax = Math.max.apply(null, all.concat(tt ? [tt] : []));
    var scale = niceScale(dataMax / 1000 * 1.05, 5);
    var yMax = scale.max * 1000;

    var w = chartWidth(host), h = 300;
    var padL = 48, padR = 62, padT = 16, padB = 38;
    var plotW = w - padL - padR, plotH = h - padT - padB;
    var yOf = function (v) { return padT + plotH - (v / yMax) * plotH; };
    var xOf = function (i) { return maxN < 2 ? padL + plotW / 2 : padL + (i / (maxN - 1)) * plotW; };

    var s = ['<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="工程別サイクルタイムの推移">'];
    scale.ticks.forEach(function (t) {
      var y = yOf(t * 1000);
      s.push('<line x1="' + padL + '" y1="' + nn(y) + '" x2="' + nn(padL + plotW) + '" y2="' + nn(y) +
        '" stroke="var(--grid)" stroke-width="1" />');
      s.push(txt(padL - 8, y, tickLabel(t), { anchor: 'end', baseline: 'middle', tabular: true }));
    });
    s.push('<line x1="' + padL + '" y1="' + nn(padT + plotH) + '" x2="' + nn(padL + plotW) +
      '" y2="' + nn(padT + plotH) + '" stroke="var(--axis)" stroke-width="1" />');

    if (tt) {
      var yt = yOf(tt);
      s.push('<line x1="' + padL + '" y1="' + nn(yt) + '" x2="' + nn(padL + plotW) + '" y2="' + nn(yt) +
        '" stroke="var(--critical)" stroke-width="2" stroke-dasharray="6 4" />');
      s.push(txt(padL + plotW + 7, yt, 'TT ' + fmtTime(tt),
        { baseline: 'middle', fill: 'var(--text-secondary)', size: 11, tabular: true }));
    }

    procs().forEach(function (p, pi) {
      if (!p.cycles.length) return;
      var pts = p.cycles.map(function (c, i) { return [xOf(i), yOf(totalOf(c))]; });
      s.push('<polyline fill="none" stroke="' + seriesVar(pi) + '" stroke-width="2" stroke-linejoin="round" ' +
        'stroke-linecap="round" points="' + pts.map(function (q) { return nn(q[0]) + ',' + nn(q[1]); }).join(' ') + '" />');
      var last = pts[pts.length - 1];
      s.push('<circle cx="' + nn(last[0]) + '" cy="' + nn(last[1]) + '" r="4.5" fill="' + seriesVar(pi) +
        '" stroke="var(--surface-1)" stroke-width="2" />');
    });

    // クロスヘア＋ツールチップ
    var labelEvery = Math.ceil(maxN / Math.max(1, Math.floor(plotW / 34)));
    for (var i = 0; i < maxN; i++) {
      var x = xOf(i);
      if (i % labelEvery === 0 || i === maxN - 1) {
        s.push(txt(x, padT + plotH + 16, String(i + 1), { anchor: 'middle' }));
      }
      var rows = procs().map(function (p, pi) {
        var c = p.cycles[i];
        if (!c) return '';
        return '<div class="tt-row"><span class="tt-key"><span class="tt-dot" style="background:' +
          seriesVar(pi) + '"></span>' + esc(p.name) + '</span><span class="tt-val">' +
          fmtTime(totalOf(c)) + (c.excluded ? '（除外）' : '') + '</span></div>';
      }).join('');
      TIPS['t-' + i] = '<strong>サイクル ' + (i + 1) + '</strong>' + rows;
      var half = plotW / Math.max(1, maxN - 1) / 2;
      s.push('<rect class="hit" x="' + nn(Math.max(padL, x - half)) + '" y="' + padT +
        '" width="' + nn(Math.min(half * 2, plotW)) + '" height="' + nn(plotH) +
        '" fill="transparent" data-tip="t-' + i + '" />');
    }
    s.push('</svg>');
    host.innerHTML = s.join('');

    $('legend-trend').innerHTML = procs().map(function (p, i) {
      return '<span class="legend__item"><span class="legend__swatch" style="background:' + seriesVar(i) +
        '"></span>' + esc(p.name) + '</span>';
    }).join('') + (tt
      ? '<span class="legend__item" style="color:var(--critical)"><span class="legend__swatch legend__swatch--dash"></span><span style="color:var(--text-secondary)">タクトタイム</span></span>' : '');
    $('fig-trend-sub').textContent = '縦軸：秒　横軸：サイクル No（最大 ' + maxN + ' サイクル）';
  }

  /* -------------------------------------------- ③ サイクルタイムの推移（工程内） */
  function renderCycleChart(p) {
    var host = $('chart-cycles');
    var legend = $('legend-1');
    var sub = $('fig1-sub');
    var cycles = p.cycles;
    var els = pElements(p);
    var multiEl = els.length > 1;

    if (!cycles.length) {
      markEmpty('chart-cycles'); legend.innerHTML = ''; sub.textContent = '';
      return;
    }
    host.dataset.state = '';

    var w = chartWidth(host), h = 300;
    var padL = 48, padR = 74, padT = 16, padB = 38;
    var plotW = w - padL - padR, plotH = h - padT - padB;

    var totals = cycles.map(totalOf);
    var tt = taktMs();
    var st = stats(pTotals(p));
    var dataMax = Math.max.apply(null, totals);
    if (tt) dataMax = Math.max(dataMax, tt);
    var scale = niceScale(dataMax / 1000 * 1.02, 5);
    var yMax = scale.max * 1000;
    var yOf = function (v) { return padT + plotH - (v / yMax) * plotH; };

    var s = ['<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="サイクルごとのサイクルタイム推移">'];
    scale.ticks.forEach(function (t) {
      var y = yOf(t * 1000);
      s.push('<line x1="' + padL + '" y1="' + nn(y) + '" x2="' + nn(padL + plotW) + '" y2="' + nn(y) +
        '" stroke="var(--grid)" stroke-width="1" />');
      s.push(txt(padL - 8, y, tickLabel(t), { anchor: 'end', baseline: 'middle', tabular: true }));
    });
    s.push('<line x1="' + padL + '" y1="' + nn(padT + plotH) + '" x2="' + nn(padL + plotW) +
      '" y2="' + nn(padT + plotH) + '" stroke="var(--axis)" stroke-width="1" />');

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
      var segs = multiEl && !c.excluded ? d : [total];

      segs.forEach(function (v, j) {
        var yTop = yOf(cum + v);
        var yBot = yOf(cum);
        var isTop = (j === segs.length - 1);
        var hh = yBot - yTop - (isTop ? 0 : gap);
        if (hh < 1) hh = 1;
        var fill = c.excluded ? 'var(--axis)' : (multiEl ? seriesVar(j) : 'var(--series-1)');
        var op = c.excluded ? ' opacity="0.55"' : '';
        if (isTop) s.push('<path d="' + topRounded(x, yTop, barW, hh, 4) + '" fill="' + fill + '"' + op + ' />');
        else s.push('<rect x="' + nn(x) + '" y="' + nn(yTop + gap) + '" width="' + nn(barW) +
          '" height="' + nn(hh) + '" fill="' + fill + '"' + op + ' />');
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

      var key = 'c1-' + i;
      TIPS[key] = tipCycle(c, i, d, total, tt, multiEl, els);
      s.push('<rect class="hit" x="' + nn(padL + band * i) + '" y="' + padT + '" width="' + nn(band) +
        '" height="' + nn(plotH) + '" fill="transparent" data-tip="' + key + '" />');
    });

    var lines = [];
    if (st.n) lines.push({ v: st.mean, color: 'var(--text-secondary)', dash: '', label: '平均 ' + fmtTime(st.mean), width: 1.5 });
    if (tt) lines.push({ v: tt, color: 'var(--critical)', dash: '6 4', label: 'TT ' + fmtTime(tt), width: 2 });
    lines.sort(function (a, b) { return b.v - a.v; });
    var prevY = -99;
    lines.forEach(function (L) {
      var y = yOf(L.v);
      s.push('<line x1="' + padL + '" y1="' + nn(y) + '" x2="' + nn(padL + plotW) + '" y2="' + nn(y) +
        '" stroke="' + L.color + '" stroke-width="' + L.width + '"' +
        (L.dash ? ' stroke-dasharray="' + L.dash + '"' : '') + ' />');
      var ly = y;
      if (Math.abs(ly - prevY) < 13) ly = prevY + 13;
      prevY = ly;
      s.push(txt(padL + plotW + 7, ly, L.label,
        { baseline: 'middle', fill: 'var(--text-secondary)', size: 11, tabular: true }));
    });
    s.push('</svg>');
    host.innerHTML = s.join('');

    var lg = [];
    if (multiEl) {
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
    if (cycles.length !== st.n) {
      lg.push('<span class="legend__item"><span class="legend__swatch" style="background:var(--axis);opacity:.55"></span>除外したサイクル</span>');
    }
    legend.innerHTML = lg.join('');
    sub.textContent = '縦軸：秒　横軸：サイクル No（全 ' + n + ' サイクル）';
  }

  function tipCycle(c, i, d, total, tt, multiEl, els) {
    var rows = '';
    if (multiEl) {
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

  /* -------------------------------------------- ④ サイクルタイムの分布 */
  function renderHistogram(p) {
    var host = $('chart-hist');
    var sub = $('fig2-sub');
    var totals = pTotals(p);
    if (totals.length < 3) { markEmpty('chart-hist'); sub.textContent = ''; return; }
    host.dataset.state = '';

    var st = stats(totals);
    var tt = taktMs();
    var k = Math.min(12, Math.max(5, Math.ceil(Math.sqrt(totals.length))));
    var lo = st.min, hi = st.max;
    if (hi - lo < 1e-6) { lo = st.min - 500; hi = st.max + 500; }
    var bw = (hi - lo) / k;
    var counts = new Array(k).fill(0);
    totals.forEach(function (v) { counts[Math.min(k - 1, Math.floor((v - lo) / bw))]++; });
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
    var xd = (hi - lo) / 1000 < 5 ? 2 : 1;   // レンジが狭いときは小数を増やす
    counts.forEach(function (cnt, i) {
      var x = padL + band * i + (band - barW) / 2;
      var yTop = yOf(cnt);
      if (cnt > 0) {
        s.push('<path d="' + topRounded(x, yTop, barW, Math.max(padT + plotH - yTop, 2), 4) + '" fill="var(--series-1)" />');
        if (band >= 24) {
          s.push(txt(x + barW / 2, Math.max(yTop - 6, padT - 6), String(cnt),
            { anchor: 'middle', fill: 'var(--text-secondary)', size: 11, weight: 600, tabular: true }));
        }
      }
      var from = lo + bw * i;
      TIPS['c2-' + i] = '<strong>' + sec(from) + ' 〜 ' + sec(from + bw) + ' 秒</strong>' +
        '<div class="tt-row"><span class="tt-key">サイクル数</span><span class="tt-val">' + cnt + ' 回</span></div>' +
        '<div class="tt-row"><span class="tt-key">構成比</span><span class="tt-val">' +
        (cnt / totals.length * 100).toFixed(0) + ' %</span></div>';
      s.push('<rect class="hit" x="' + nn(padL + band * i) + '" y="' + padT + '" width="' + nn(band) +
        '" height="' + nn(plotH) + '" fill="transparent" data-tip="c2-' + i + '" />');
      if (i % Math.ceil(k / 6) === 0) s.push(txt(padL + band * i, padT + plotH + 16, sec(from, xd), { anchor: 'middle' }));
    });
    s.push(txt(padL + plotW, padT + plotH + 16, sec(hi, xd), { anchor: 'end' }));

    var vlines = [{ v: st.mean, color: 'var(--text-secondary)', dash: '', label: '平均 ' + sec(st.mean), width: 1.5, side: -1 }];
    if (tt && tt >= lo && tt <= hi) vlines.push({ v: tt, color: 'var(--critical)', dash: '6 4', label: 'TT ' + sec(tt), width: 2, side: 1 });
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

  /* -------------------------------------------- ⑤ 要素作業ごとの平均時間 */
  function renderElementChart(p) {
    var fig = $('fig-elements');
    var host = $('chart-elements');
    var sub = $('fig3-sub');
    var els = pElements(p);
    var act = pActive(p);
    if (els.length < 2 || !act.length) { fig.hidden = true; host.innerHTML = ''; return; }
    fig.hidden = false;

    var rows = els.map(function (e, i) {
      var vals = act.map(function (c) { return durationsOf(c)[i]; }).filter(function (v) { return v != null; });
      return { name: e.name, i: i, st: stats(vals) };
    });
    var maxV = Math.max.apply(null, rows.map(function (r) { return r.st.max; }));
    var scale = niceScale(maxV / 1000 * 1.02, 4);

    var w = chartWidth(host);
    var rowH = 34, padT = 10, padB = 30;
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

      TIPS['c3-' + i] = '<strong>' + esc(r.name) + '</strong>' +
        '<div class="tt-row"><span class="tt-key">平均</span><span class="tt-val">' + fmtTime(r.st.mean) + ' 秒</span></div>' +
        '<div class="tt-row"><span class="tt-key">最小 / 最大</span><span class="tt-val">' + fmtTime(r.st.min) + ' / ' + fmtTime(r.st.max) + '</span></div>' +
        '<div class="tt-row"><span class="tt-key">σ / CV</span><span class="tt-val">' + fmtTime(r.st.sd) + ' / ' + r.st.cv.toFixed(1) + ' %</span></div>' +
        '<div class="tt-row"><span class="tt-key">構成比</span><span class="tt-val">' +
        (totalMean > 0 ? (r.st.mean / totalMean * 100).toFixed(1) : '0.0') + ' %</span></div>';
      s.push('<rect class="hit" x="0" y="' + nn(padT + rowH * i) + '" width="' + w + '" height="' + rowH +
        '" fill="transparent" data-tip="c3-' + i + '" />');
    });
    s.push('</svg>');
    host.innerHTML = s.join('');
    sub.textContent = '横棒＝平均、細線＝最小〜最大（単位：秒）';
  }

  function renderCharts() {
    TIPS = {};
    var all = viewAll();
    $('fig-balance').hidden = !all;
    $('fig-trend').hidden = !all;
    $('fig-cycles').hidden = all;
    $('figure-grid').hidden = all;
    if (all) {
      renderBalanceChart();
      renderTrendChart();
    } else {
      var p = viewProc();
      renderCycleChart(p);
      renderHistogram(p);
      renderElementChart(p);
    }
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
      if (t) show(t.getAttribute('data-tip'), e.touches[0].clientX, e.touches[0].clientY);
      else hide();
    }, { passive: true });
    window.addEventListener('scroll', hide, { passive: true });
  })();

  /* ============================================================ 書き出し / 読込 */
  function csvCell(v) {
    var s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function csvRow(arr) { return arr.map(csvCell).join(','); }

  function csvHeader(settings, scope) {
    return [
      csvRow(['CT Checker サイクルタイム測定']),
      csvRow(['ライン名/品名', settings.title]),
      csvRow(['観測者', settings.operator]),
      csvRow(['タクトタイム(秒)', settings.takt == null ? '' : settings.takt]),
      csvRow(['備考', settings.memo]),
      csvRow(['対象', scope]),
      csvRow(['書き出し日時', fmtDateTime(nowIso())]),
      ''
    ];
  }

  function statRow(label, values) {
    var s = stats(values);
    return csvRow([label, s.n, sec(s.mean), sec(s.median), sec(s.min), sec(s.max),
      sec(s.range), sec(s.sd), s.cv.toFixed(1)]);
  }
  var STAT_HEAD = ['項目', '有効サイクル数', '平均(秒)', '中央値(秒)', '最小(秒)', '最大(秒)', 'レンジ(秒)', '標準偏差(秒)', 'CV(%)'];

  /** 1工程の明細 CSV。 */
  function buildCsvProc(settings, p) {
    var els = p.elements;
    var multiEl = els.length > 1;
    var tt = (typeof settings.takt === 'number' && settings.takt > 0) ? settings.takt * 1000 : null;
    var lines = csvHeader(settings, p.name);

    var header = ['No', '記録時刻'];
    if (multiEl) els.forEach(function (e) { header.push(e.name + '(秒)'); });
    header.push('サイクル(秒)');
    if (tt) header.push('タクト差(秒)');
    header.push('除外', 'メモ');
    lines.push(csvRow(header));

    p.cycles.forEach(function (c, i) {
      var d = durationsOf(c);
      var total = totalOf(c);
      var row = [i + 1, c.at ? fmtDateTime(c.at) : ''];
      if (multiEl) els.forEach(function (_, j) { row.push(d[j] != null ? sec(d[j]) : ''); });
      row.push(sec(total));
      if (tt) row.push(sec(total - tt));
      row.push(c.excluded ? '除外' : '', c.note || '');
      lines.push(csvRow(row));
    });

    var act = p.cycles.filter(function (c) { return !c.excluded; });
    lines.push('');
    lines.push(csvRow(STAT_HEAD));
    lines.push(statRow('サイクル計', act.map(totalOf)));
    if (multiEl) {
      els.forEach(function (e, j) {
        lines.push(statRow(e.name, act.map(function (c) { return durationsOf(c)[j]; })
          .filter(function (v) { return v != null; })));
      });
    }
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  /** ライン全体（工程別マトリクス＋工程別統計）の CSV。 */
  function buildCsvLine(settings, list) {
    var tt = (typeof settings.takt === 'number' && settings.takt > 0) ? settings.takt * 1000 : null;
    var lines = csvHeader(settings, 'ライン全体（' + list.length + '工程）');
    var maxN = Math.max.apply(null, list.map(function (p) { return p.cycles.length; }).concat([0]));

    lines.push(csvRow(['No'].concat(list.map(function (p) { return p.name + '(秒)'; }))));
    for (var i = 0; i < maxN; i++) {
      lines.push(csvRow([i + 1].concat(list.map(function (p) {
        var c = p.cycles[i];
        return c ? (c.excluded ? '' : sec(totalOf(c))) : '';
      }))));
    }
    lines.push('');
    lines.push(csvRow(STAT_HEAD.concat(tt ? ['タクト差(秒)'] : [])));
    var neckMean = 0;
    list.forEach(function (p) {
      var act = p.cycles.filter(function (c) { return !c.excluded; });
      var s = stats(act.map(totalOf));
      if (s.mean > neckMean) neckMean = s.mean;
      var row = [p.name, s.n, sec(s.mean), sec(s.median), sec(s.min), sec(s.max),
        sec(s.range), sec(s.sd), s.cv.toFixed(1)];
      if (tt) row.push(sec(s.mean - tt));
      lines.push(csvRow(row));
    });

    var means = list.map(function (p) {
      return stats(p.cycles.filter(function (c) { return !c.excluded; }).map(totalOf));
    }).filter(function (s) { return s.n; }).map(function (s) { return s.mean; });
    lines.push('');
    if (means.length) {
      var sum = means.reduce(function (a, b) { return a + b; }, 0);
      lines.push(csvRow(['ネック工程の平均(秒)', sec(neckMean)]));
      lines.push(csvRow(['工程平均の合計(秒)', sec(sum)]));
      if (means.length > 1) {
        lines.push(csvRow(['ラインバランス効率(%)', (sum / (means.length * neckMean) * 100).toFixed(1)]));
      }
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

  function safeName(s) { return String(s || '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40); }
  function stamp() {
    var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes());
  }
  function fileBase(settings, suffix) {
    return 'CT_' + (safeName(settings.title) || 'measure') + (suffix ? '_' + safeName(suffix) : '') + '_' + stamp();
  }

  function exportCsvOf(settings, list, scopeProc) {
    var has = list.some(function (p) { return p.cycles.length; });
    if (!has) { toast('計測データがありません'); return; }
    if (scopeProc) download(fileBase(settings, scopeProc.name) + '.csv', buildCsvProc(settings, scopeProc), 'text/csv');
    else download(fileBase(settings, 'line') + '.csv', buildCsvLine(settings, list), 'text/csv');
    toast('CSVを書き出しました');
  }

  function exportJson() {
    var payload = { app: 'ct-checker', exportedAt: nowIso() };
    var snap = snapshot();
    for (var k in snap) payload[k] = snap[k];
    download(fileBase(state.settings) + '.json', JSON.stringify(payload, null, 2), 'application/json');
    toast('JSONを書き出しました');
  }

  function importJson(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var d;
      try { d = JSON.parse(reader.result); } catch (e) { toast('JSONを読み込めませんでした'); return; }
      if (!d || !d.settings) { toast('CT Checker の JSON ではありません'); return; }
      if (hasData() && !confirm('現在の計測データを破棄して読み込みます。よろしいですか？')) return;
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
    if (!hasData()) { toast('計測データがありません'); return; }
    var def = (state.settings.title || '測定') + ' ' + fmtDateTime(nowIso());
    var name = prompt('保存名を入力してください', def);
    if (name === null) return;
    var list = loadSessions();
    list.unshift({
      id: uid(), name: name || def, savedAt: nowIso(),
      data: JSON.parse(JSON.stringify(snapshot()))
    });
    saveSessions(list.slice(0, 50));
    renderSessions();
    toast('測定を保存しました');
  }

  function loadSession(id) {
    var s = loadSessions().filter(function (x) { return x.id === id; })[0];
    if (!s) return;
    if (hasData() && !confirm('現在の計測データを破棄して「' + s.name + '」を読み込みます。よろしいですか？')) return;
    state = normalize(s.data || s);
    state.started = true;
    runSince = null;
    syncSettingsInputs();
    render();
    save();
    announce('「' + s.name + '」を読み込みました。続きから計測もできます。');
    toast('読み込みました');
  }

  /* ------------------------------------------------------------------ イベント */
  function bind() {
    $('btn-lap').addEventListener('click', function () { lap(procs()[0]); });
    $('btn-pause').addEventListener('click', function () { running() ? pause() : resume(); });
    $('btn-undo').addEventListener('click', function () { undo(procs()[0]); });
    $('btn-discard').addEventListener('click', function () { discardCycle(procs()[0]); });
    $('btn-reset').addEventListener('click', resetAll);

    $('pcards').addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      var p = procs()[+b.getAttribute('data-i')];
      if (!p) return;
      var act = b.getAttribute('data-act');
      if (act === 'lap') lap(p);
      else if (act === 'undo') undo(p);
      else if (act === 'discard') discardCycle(p);
    });

    document.addEventListener('keydown', function (e) {
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === 'Space' || e.key === ' ' || e.key === 'Enter') { e.preventDefault(); lap(procs()[0]); }
      else if (e.key >= '1' && e.key <= '9') {
        var p = procs()[+e.key - 1];
        if (p) { e.preventDefault(); lap(p); }
      }
      else if (e.key === 'p' || e.key === 'P') { e.preventDefault(); running() ? pause() : resume(); }
      else if (e.key === 'z' || e.key === 'Z') { e.preventDefault(); undo(procs()[0]); }
    });

    // 表示切替
    $('viewswitch-chips').addEventListener('click', function (e) {
      var b = e.target.closest('[data-view]');
      if (!b) return;
      state.view = b.getAttribute('data-view');
      renderViewSwitch(); renderTiles(); renderTables(); renderCharts();
      saveSoon();
    });

    // 設定
    $('in-title').addEventListener('input', function () { state.settings.title = this.value; saveSoon(); });
    $('in-operator').addEventListener('input', function () { state.settings.operator = this.value; saveSoon(); });
    $('in-memo').addEventListener('input', function () { state.settings.memo = this.value; saveSoon(); });
    $('in-takt').addEventListener('input', function () {
      var v = parseFloat(this.value);
      state.settings.takt = (isFinite(v) && v > 0) ? v : null;
      render();
      saveSoon();
    });

    $('btn-add-proc').addEventListener('click', addProcess);
    $('in-proc').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); addProcess(); }
    });

    $('proc-list').addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      var pi = +b.getAttribute('data-p');
      var p = procs()[pi];
      if (!p) return;
      var act = b.getAttribute('data-act');
      if (act === 'del-proc') {
        if (procs().length <= 1) { toast('工程は1つ以上必要です'); return; }
        procs().splice(pi, 1);
        if (state.view === p.id) state.view = 'all';
        render(); save();
      } else if (act === 'del-element') {
        if (p.elements.length <= 1) { toast('要素作業は1つ以上必要です'); return; }
        p.elements.splice(+b.getAttribute('data-i'), 1);
        render(); save();
      } else if (act === 'add-element') {
        addElement(p, pi);
      }
    });
    $('proc-list').addEventListener('input', function (e) {
      var inp = e.target.closest('[data-act]');
      if (!inp) return;
      var p = procs()[+inp.getAttribute('data-p')];
      if (!p) return;
      var act = inp.getAttribute('data-act');
      if (act === 'rename-proc') {
        p.name = inp.value;
        renderViewSwitch(); renderTiles(); renderTables(); renderCharts();
        if (multi()) renderCards();
        saveSoon();
      } else if (act === 'rename-element') {
        p.elements[+inp.getAttribute('data-i')].name = inp.value;
        renderMeasure(); renderTables(); renderCharts();
        saveSoon();
      }
    });
    $('proc-list').addEventListener('keydown', function (e) {
      var inp = e.target.closest('[data-act="new-element"]');
      if (!inp || e.key !== 'Enter') return;
      e.preventDefault();
      addElement(procs()[+inp.getAttribute('data-p')], +inp.getAttribute('data-p'));
    });

    // 明細（除外・メモ）
    $('table-cycles').addEventListener('change', function (e) {
      var box = e.target.closest('[data-act="exclude"]');
      if (!box) return;
      viewProc().cycles[+box.getAttribute('data-i')].excluded = box.checked;
      render(); save();
    });
    $('table-cycles').addEventListener('input', function (e) {
      var inp = e.target.closest('[data-act="note"]');
      if (!inp) return;
      viewProc().cycles[+inp.getAttribute('data-i')].note = inp.value;
      saveSoon();
    });

    $('btn-outlier').addEventListener('click', function () {
      var p = viewProc();
      var all = p.cycles.map(totalOf);
      if (all.length < 3) { toast('3サイクル以上必要です'); return; }
      var st = stats(all);
      var hit = 0;
      p.cycles.forEach(function (c, i) {
        c.excluded = st.sd > 0 && Math.abs(all[i] - st.mean) > 2 * st.sd;
        if (c.excluded) hit++;
      });
      render(); save();
      toast(hit ? hit + ' サイクルを除外しました' : '±2σを超えるサイクルはありません');
    });
    $('btn-include-all').addEventListener('click', function () {
      viewProc().cycles.forEach(function (c) { c.excluded = false; });
      render(); save();
      toast('除外を解除しました');
    });

    // 書き出し / 読込
    $('btn-csv').addEventListener('click', function () {
      exportCsvOf(state.settings, procs(), viewAll() ? null : viewProc());
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
      var s = loadSessions().filter(function (x) { return x.id === id; })[0];
      if (act === 'load-session') loadSession(id);
      else if (act === 'del-session') {
        if (!s || !confirm('「' + s.name + '」を削除します。よろしいですか？')) return;
        saveSessions(loadSessions().filter(function (x) { return x.id !== id; }));
        renderSessions();
        toast('削除しました');
      } else if (act === 'csv-session' && s) {
        var st = normalize(s.data || s);
        exportCsvOf(st.settings, st.processes, st.processes.length > 1 ? null : st.processes[0]);
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

    var rt = null;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(renderCharts, 150);
    });
    window.addEventListener('beforeunload', save);
  }

  function addProcess() {
    var input = $('in-proc');
    var name = input.value.trim();
    var list = procs();
    if (list.length >= MAX_PROCESSES) { toast('工程は最大 ' + MAX_PROCESSES + ' 個までです'); return; }
    list.push(newProcess(name || ('工程' + (list.length + 1))));
    input.value = '';
    input.focus();
    render(); save();
  }

  function addElement(p, pi) {
    if (!p) return;
    var input = document.querySelector('[data-act="new-element"][data-p="' + pi + '"]');
    var name = input ? input.value.trim() : '';
    if (!name) { if (input) input.focus(); return; }
    if (p.elements.length >= MAX_ELEMENTS) { toast('要素作業は最大 ' + MAX_ELEMENTS + ' 個までです'); return; }
    // 初期値の「1サイクル」だけなら置き換える
    if (p.elements.length === 1 && p.elements[0].name === '1サイクル') p.elements[0] = { id: uid(), name: name };
    else p.elements.push({ id: uid(), name: name });
    render(); save();
    var again = document.querySelector('[data-act="new-element"][data-p="' + pi + '"]');
    if (again) again.focus();
  }

  /* -------------------------------------------------------------------- 起動 */
  function tick() {
    if (running()) {
      var e = elapsed();
      if (e - lastTickAt >= 50 || e < lastTickAt) { lastTickAt = e; renderReadout(); }
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
    if (state.started) announce('前回のデータを復元しました（一時停止中）。「再開」で続きから計測できます。');
    setInterval(function () { if (running()) save(); }, 5000);
    requestAnimationFrame(tick);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
