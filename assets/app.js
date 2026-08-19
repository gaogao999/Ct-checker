/* ============================================================================
 * CT Checker — サイクルタイム測定
 * 依存ライブラリなし。ファイルを直接開いても動作します。
 *
 * 構造
 *   工程（大工程）        state.groups[]    … 色とまとまりの単位
 *     ステーション（小工程）state.stations[]  … ストップウォッチと計測の単位
 *       要素作業           station.elements[] … 1サイクル内の区切り
 *
 *   時刻はすべて「そのステーションのストップウォッチの累積経過(ms)」。
 *   区切り位置だけを持つので、取り消しても時間のつじつまが合わなくなりません。
 * ==========================================================================*/
(function () {
  'use strict';

  var STORE_KEY = 'ct-checker:v1';
  var PREV_KEY = 'ct-checker:prev:v1';     // 読み込み直前の中身（まるごと1世代分の控え）
  var SESSION_KEY = 'ct-checker:sessions:v1';
  var SCHEMA = 3;                          // 保存形式。これより新しいデータは書き換えない
  var THEME_KEY = 'ct-checker:theme';
  var MAX_ELEMENTS = 8;
  var MAX_GROUPS = 20;     // 9個目以降は同じ色に斜線（45°/135°）を重ねて見分ける
  var MAX_STATIONS = 60;
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


  /**
   * 配色は8色。9工程目からは同じ色に斜線を重ねて見分ける。
   * 0＝無地 / 1＝45°の斜線 / 2＝135°の斜線（色だけに頼らないための第2の手がかり）。
   */
  function hueOf(i) { return i % SERIES_SLOTS; }
  function variantOf(i) { return Math.floor(i / SERIES_SLOTS) % 3; }

  /** SVG の塗り。斜線が要る工程はパターンを参照する。 */
  function svgFill(i) {
    var v = variantOf(i);
    return v === 0 ? seriesVar(hueOf(i)) : 'url(#hatch' + hueOf(i) + '-' + v + ')';
  }

  /** グラフで使う斜線パターンの定義（必要な組み合わせの分だけ作る）。 */
  function hatchDefs(indexes) {
    var need = {};
    indexes.forEach(function (i) {
      var v = variantOf(i);
      if (v) need[hueOf(i) + '-' + v] = true;
    });
    var keys = Object.keys(need);
    if (!keys.length) return '';
    return '<defs>' + keys.map(function (k) {
      var parts = k.split('-');
      var deg = parts[1] === '1' ? 45 : 135;
      return '<pattern id="hatch' + k + '" width="7" height="7" patternUnits="userSpaceOnUse" ' +
        'patternTransform="rotate(' + deg + ')">' +
        '<rect width="7" height="7" fill="' + seriesVar(+parts[0]) + '" />' +
        '<line x1="0" y1="0" x2="0" y2="7" stroke="var(--surface-1)" stroke-width="2.6" />' +
        '</pattern>';
    }).join('') + '</defs>';
  }

  /** HTML の色見本。斜線が要る工程は縞のグラデーションにする。 */
  function swatchBg(i) {
    var c = seriesVar(hueOf(i));
    var v = variantOf(i);
    if (!v) return 'background:' + c;
    return 'background:repeating-linear-gradient(' + (v === 1 ? '45deg' : '135deg') + ',' +
      c + ',' + c + ' 3px,var(--surface-1) 3px,var(--surface-1) 5px)';
  }

  /** fmtTime が m:ss 表記に切り替わったら「秒」の単位は付けない。 */
  function unitFor(ms) { return Math.abs(ms) >= 60000 ? '' : '秒'; }

  /** 長めの時間を「12分34秒」で補足する。 */
  function minSec(ms) {
    var v = Math.round(ms / 1000);
    var m = Math.floor(v / 60);
    return m ? m + '分' + (v % 60) + '秒' : v + '秒';
  }
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
  function newStation(name, groupId) {
    return {
      id: uid(), groupId: groupId, name: name || 'ステーション',
      elements: [{ id: uid(), name: '1サイクル' }],
      cycles: [], cycleStart: 0, pending: [],
      accBase: 0,      // このステーションのストップウォッチの累積(ms)
      started: false   // 一度でも開始したか
    };
  }

  function defaultState() {
    var g = { id: uid(), name: '工程1' };
    return {
      settings: { title: '', operator: '', memo: '', takt: null },
      groups: [g],
      stations: [newStation('ステーション1', g.id)],
      startedAt: null,
      view: 'all',    // 'all' | 'g:<groupId>' | 's:<stationId>'
      focus: 'all',   // 計測パネルで表示する工程 'all' | <groupId>
      tab: 'measure', // 'measure' | 'stats' | 'table' | 'settings'
      density: null   // null(自動) | 'card' | 'list'
    };
  }

  var state = defaultState();
  var RUN = {};                    // ステーションID → 実行中の performance.now()。保存しない
  var lastTickAt = -1;

  function groups() { return state.groups; }
  function stations() { return state.stations; }
  function multi() { return state.stations.length > 1; }

  function groupIndex(g) { return state.groups.indexOf(g); }
  function groupById(id) {
    for (var i = 0; i < state.groups.length; i++) if (state.groups[i].id === id) return state.groups[i];
    return state.groups[0];
  }
  function groupOf(st) { return groupById(st.groupId); }
  function colorOf(st) { return seriesVar(groupIndex(groupOf(st))); }
  function stationsOf(g) {
    return state.stations.filter(function (s) { return s.groupId === g.id; });
  }
  function stationIndex(st) { return state.stations.indexOf(st); }
  function stationById(id) {
    for (var i = 0; i < state.stations.length; i++) if (state.stations[i].id === id) return state.stations[i];
    return null;
  }

  /** ステーションごとのストップウォッチ。互いに独立して動く。 */
  function pRunning(p) { return RUN[p.id] != null; }
  function pElapsed(p) {
    return p.accBase + (RUN[p.id] != null ? performance.now() - RUN[p.id] : 0);
  }
  function anyRunning() { return stations().some(pRunning); }
  function anyStarted() { return stations().some(function (p) { return p.started; }); }
  /** 観測全体の経過＝もっとも長く動いたステーションの経過。 */
  function elapsed() {
    return stations().reduce(function (m, p) { return Math.max(m, pElapsed(p)); }, 0);
  }

  function pElements(p) { return p.elements; }
  function pElemCount(p) { return Math.max(1, p.elements.length); }
  function pCycleElapsed(p) { return pElapsed(p) - p.cycleStart; }
  function pElementElapsed(p) {
    var base = p.pending.length ? p.pending[p.pending.length - 1] : p.cycleStart;
    return pElapsed(p) - base;
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

  /** 平均がもっとも長いステーション（ネック）。データが無ければ null。 */
  function neckOf(list) {
    var best = null, bestV = -1;
    list.forEach(function (p) {
      var st = pStats(p);
      if (st.n && st.mean > bestV) { bestV = st.mean; best = p; }
    });
    return best;
  }

  /** 工程（大）の集計：合計工数・ネック・データのあるステーション数。 */
  function groupSummary(g) {
    var list = stationsOf(g);
    var withData = list.filter(function (p) { return pStats(p).n; });
    var sum = withData.reduce(function (a, p) { return a + pStats(p).mean; }, 0);
    return {
      group: g, stations: list, withData: withData,
      sum: sum, neck: neckOf(list),
      count: list.length
    };
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

  /** ラインバランス効率＝平均の合計 ÷（ステーション数 × ネックの平均） */
  function balanceRate(list) {
    var means = list.map(pStats).filter(function (s) { return s.n; })
      .map(function (s) { return s.mean; });
    if (means.length < 2) return null;
    var max = Math.max.apply(null, means);
    var sum = means.reduce(function (a, b) { return a + b; }, 0);
    return max > 0 ? (sum / (means.length * max)) * 100 : null;
  }

  /* ------------------------------------------------------------------ 保存 */
  var saveTimer = null;
  function snapshot() {
    return {
      version: 3,
      schema: SCHEMA,
      settings: state.settings,
      groups: state.groups,
      stations: state.stations,
      accBase: elapsed(),
      started: anyStarted(),
      startedAt: state.startedAt,
      view: state.view,
      focus: state.focus,
      tab: state.tab,
      density: state.density
    };
  }
  var saveFailed = false;
  var readOnly = false;   // 新しいバージョンで保存されたデータを壊さないためのロック

  function save() {
    if (readOnly) return;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(snapshot()));
      if (saveFailed) { saveFailed = false; updateStorageHint(); }
    } catch (e) {
      if (!saveFailed) {
        saveFailed = true;
        updateStorageHint();
        toast('保存できませんでした。保存領域がいっぱいかもしれません');
      }
    }
  }
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 300);
  }
  /** 保存されているデータが何ステーション分あるか（取りこぼし検知用） */
  function countUnits(d) {
    if (Array.isArray(d.stations)) return d.stations.length;
    if (Array.isArray(d.processes)) return d.processes.length;
    return 1;
  }

  /** データの重み（ステーション数と記録サイクル数）。減っていたら退避する判定に使う。 */
  function dataWeight(d) {
    var list = Array.isArray(d.stations) ? d.stations
      : (Array.isArray(d.processes) ? d.processes : []);
    var cycles = 0;
    list.forEach(function (p) { if (p && Array.isArray(p.cycles)) cycles += p.cycles.length; });
    if (!list.length && Array.isArray(d.cycles)) cycles += d.cycles.length;   // v1
    return countUnits(d) * 1000 + cycles;
  }

  /** 取り込めなかったデータを「保存した測定」に退避して、あとから戻せるようにする。 */
  var rescueNotice = '';
  function keepRescue(raw, why) {
    var d;
    try { d = JSON.parse(raw); } catch (e) { return; }
    rescueNotice = why;
    var list = loadSessions();
    if (list.some(function (x) { return x.rescue && JSON.stringify(x.data) === JSON.stringify(d); })) return;
    list.unshift({
      id: uid(), auto: true, rescue: true,
      name: '復元用 ' + fmtDateTime(nowIso()) + '（' + why + '）',
      savedAt: nowIso(), data: d
    });
    saveSessions(trimSessions(list));
  }

  function load() {
    var raw;
    try { raw = localStorage.getItem(STORE_KEY); } catch (e) { return; }
    if (!raw) return;
    var d;
    try { d = JSON.parse(raw); } catch (e) { return; }
    if (!d || !d.settings) return;

    // 自分より新しい形式なら触らない（古い版が新しいデータを潰さないため）
    if (typeof d.schema === 'number' && d.schema > SCHEMA) {
      readOnly = true;
      return;
    }

    // 壊れたデータでもアプリを起動できるようにし、元データは退避しておく
    var before = countUnits(d);
    try {
      state = normalize(d);
    } catch (e) {
      state = defaultState();
      keepRescue(raw, '読み込みに失敗しました');
      return;
    }
    if (before > state.stations.length) {
      keepRescue(raw, 'ステーション ' + before + ' 件のうち ' + state.stations.length + ' 件しか読めませんでした');
    }

    // 前回の控えより中身が減っていたら、古いほうを「保存した測定」に退避する。
    // 別バージョンのコードに上書きされた場合でも、ここから戻せる。
    var prevRaw = null;
    try { prevRaw = localStorage.getItem(PREV_KEY); } catch (e) { /* noop */ }
    if (prevRaw && prevRaw !== raw) {
      try {
        var pd = JSON.parse(prevRaw);
        if (pd && pd.settings && dataWeight(pd) > dataWeight(d)) {
          keepRescue(prevRaw, '前回より内容が減っています（ST ' + countUnits(pd) + '→' + countUnits(d) + '）');
        }
      } catch (e) { /* 読めない控えは無視 */ }
    }

    // 読み込み直前の中身を1世代だけ控える（上書き事故からの復帰用）
    try { localStorage.setItem(PREV_KEY, raw); } catch (e) { /* 容量不足なら諦める */ }
  }

  function prevSnapshot() {
    var raw;
    try { raw = localStorage.getItem(PREV_KEY); } catch (e) { return null; }
    if (!raw) return null;
    try {
      var d = JSON.parse(raw);
      return (d && d.settings) ? d : null;
    } catch (e) { return null; }
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

  /**
   * v1（単一工程）・v2（複数工程・共通の時計）・v3（工程＋ステーション）を受け付ける。
   * 旧データの「工程」は計測単位なので、そのままステーションとして取り込む。
   */
  function normalize(d) {
    var s = defaultState();
    var set = d.settings || {};
    s.settings.title = String(set.title || '');
    s.settings.operator = String(set.operator || '');
    s.settings.memo = String(set.memo || '');
    s.settings.takt = (typeof set.takt === 'number' && set.takt > 0) ? set.takt : null;

    var gs = Array.isArray(d.groups) ? d.groups.filter(function (g) { return g && g.name; }) : [];
    s.groups = gs.length
      ? gs.slice(0, MAX_GROUPS).map(function (g) { return { id: g.id || uid(), name: String(g.name) }; })
      : [{ id: uid(), name: '工程1' }];

    var list = Array.isArray(d.stations) ? d.stations
      : (Array.isArray(d.processes) ? d.processes : null);
    if (list) list = list.filter(function (x) { return x && typeof x === 'object'; });
    if (list && !list.length) list = null;
    if (!list) {
      // v1: settings.elements + cycles を 1 ステーションとして取り込む
      list = [{
        id: uid(), name: set.title || 'ステーション1',
        elements: set.elements, cycles: d.cycles,
        cycleStart: d.cycleStart, pending: d.pending
      }];
    }
    var sharedAcc = typeof d.accBase === 'number' ? d.accBase : 0;
    var ids = s.groups.map(function (g) { return g.id; });
    s.stations = list.slice(0, MAX_STATIONS).map(function (p, i) {
      var cycles = normCycles(p.cycles);
      return {
        id: p.id || uid(),
        groupId: ids.indexOf(p.groupId) >= 0 ? p.groupId : ids[0],
        name: String(p.name || ('ステーション' + (i + 1))),
        elements: normElements(p.elements),
        cycles: cycles,
        cycleStart: typeof p.cycleStart === 'number' ? p.cycleStart : 0,
        pending: Array.isArray(p.pending) ? p.pending.slice() : [],
        accBase: typeof p.accBase === 'number' ? p.accBase : sharedAcc,
        started: typeof p.started === 'boolean' ? p.started : (!!d.started || cycles.length > 0)
      };
    });
    if (!s.stations.length) s.stations = [newStation('ステーション1', s.groups[0].id)];
    sortStations(s);

    s.startedAt = d.startedAt || null;
    s.view = validView(s, d.view);
    s.focus = (d.focus && ids.indexOf(d.focus) >= 0) ? d.focus : 'all';
    s.tab = ['measure', 'stats', 'table', 'settings'].indexOf(d.tab) >= 0 ? d.tab : 'measure';
    s.density = (d.density === 'card' || d.density === 'list') ? d.density : null;
    return s;
  }

  function validView(s, v) {
    if (typeof v !== 'string') return 'all';
    if (v === 'all') return 'all';
    var id = v.slice(2);
    if (v.indexOf('g:') === 0 && s.groups.some(function (g) { return g.id === id; })) return v;
    if (v.indexOf('s:') === 0 && s.stations.some(function (x) { return x.id === id; })) return v;
    return 'all';
  }

  /** 表示順を工程順に揃える（並びがそのまま画面と CSV の順序になる）。 */
  function sortStations(s) {
    var order = {};
    (s || state).groups.forEach(function (g, i) { order[g.id] = i; });
    (s || state).stations.sort(function (a, b) { return order[a.groupId] - order[b.groupId]; });
  }

  function loadSessions() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || []; } catch (e) { return []; }
  }
  function saveSessions(list) {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(list)); }
    catch (e) { toast('保存領域がいっぱいです。古い自動保存を削除してください'); }
  }

  /** 消える前に必ず控えを取る。リセット・読込・インポートの直前に呼ぶ。 */
  function autoArchive(reason) {
    if (!hasData()) return;
    var list = loadSessions();
    list.unshift({
      id: uid(), auto: true,
      name: '自動保存 ' + fmtDateTime(nowIso()) + '（' + reason + '）',
      savedAt: nowIso(),
      data: JSON.parse(JSON.stringify(snapshot()))
    });
    saveSessions(trimSessions(list));
    renderSessions();
  }

  /** 上限を超えたら自動保存の古いものから削る（手動保存は残す）。 */
  function trimSessions(list) {
    var LIMIT = 60;
    if (list.length <= LIMIT) return list;
    var keep = [];
    var autos = [];
    list.forEach(function (x) { (x.auto ? autos : keep).push(x); });
    var room = Math.max(0, LIMIT - keep.length);
    var keptAutos = autos.slice(0, room);
    return list.filter(function (x) { return !x.auto || keptAutos.indexOf(x) >= 0; });
  }

  /** 端末にデータを長く残してもらう（対応ブラウザのみ） */
  function requestPersist() {
    if (!navigator.storage || !navigator.storage.persist) return;
    try {
      navigator.storage.persisted().then(function (ok) {
        if (!ok) navigator.storage.persist().catch(function () { /* 断られても続行 */ });
      }).catch(function () { /* noop */ });
    } catch (e) { /* noop */ }
  }

  function updateStorageHint() {
    var el = $('storage-hint');
    if (!el) return;
    if (saveFailed) {
      el.className = 'hint hint--warn';
      el.textContent = '⚠ ブラウザに保存できませんでした。古い自動保存を削除するか、JSON で書き出して退避してください。';
      return;
    }
    if (!storageOk()) {
      el.className = 'hint hint--warn';
      el.textContent = '⚠ この環境ではブラウザへの自動保存が使えません。CSV / JSON で書き出して保管してください。';
      return;
    }
    var list = loadSessions();
    var autos = list.filter(function (x) { return x.auto; }).length;
    el.className = 'hint';
    el.textContent = 'リセット・読込・JSON取り込みの直前には自動でバックアップを取ります' +
      '（自動保存 ' + autos + ' 件／手動保存 ' + (list.length - autos) + ' 件）。' +
      '端末を移すときは JSON で書き出してください。';
  }

  /* ------------------------------------------------------------- 表示スコープ */
  function viewLevel() {
    if (!multi()) return 'station';
    if (state.view === 'all') return 'line';
    return state.view.indexOf('g:') === 0 ? 'group' : 'station';
  }
  function viewGroup() {
    if (state.view.indexOf('g:') === 0) return groupById(state.view.slice(2));
    if (state.view.indexOf('s:') === 0) {
      var st = stationById(state.view.slice(2));
      if (st) return groupOf(st);
    }
    return null;
  }
  function viewStation() {
    if (!multi()) return stations()[0];
    if (state.view.indexOf('s:') === 0) return stationById(state.view.slice(2)) || stations()[0];
    return stations()[0];
  }
  /** 現在のスコープに含まれるステーション */
  function viewStations() {
    var lv = viewLevel();
    if (lv === 'line') return stations();
    if (lv === 'group') return stationsOf(viewGroup());
    return [viewStation()];
  }

  /* ------------------------------------------------------------ 計測アクション */
  /** ステーション p のストップウォッチを開始する（他には影響しない）。 */
  function startProc(p) {
    if (pRunning(p)) return;
    if (!p.started) {
      p.started = true;
      p.accBase = 0;
      p.cycleStart = 0;
      p.pending = [];
      if (!state.startedAt) state.startedAt = nowIso();
    }
    RUN[p.id] = performance.now();
    requestWakeLock();
  }

  /** ステーション p のストップウォッチを止める。止めている間は加算されない。 */
  function stopProc(p) {
    if (!pRunning(p)) return;
    p.accBase = pElapsed(p);
    delete RUN[p.id];
    if (!anyRunning()) releaseWakeLock();
  }

  function label(p) { return multi() ? p.name + '：' : ''; }

  function toggleProc(p) {
    if (pRunning(p)) {
      stopProc(p);
      announce(label(p) + '一時停止しました。');
    } else {
      startProc(p);
      announce(label(p) + (p.cycles.length || p.pending.length ? '再開しました。' : '計測を開始しました。'));
    }
    render(); save();
  }

  /** いま計測中（未保存）の時間。ストップしていればその時点で止まっている。 */
  function measured(p) { return pElapsed(p) - p.cycleStart; }
  function hasUnsaved(p) { return p.started && measured(p) > 0; }

  /**
   * カードのタップ。ストップウォッチと同じで、押すたびに スタート ⇄ ストップ。
   * 要素作業を分けているステーションだけは、途中のタップが区切りになる。
   */
  function tap(p) {
    var els = pElements(p);
    if (!pRunning(p)) {
      startProc(p);
      announce(label(p) + (measured(p) > 0 ? '計測を再開しました。' : 'スタート。'));
    } else if (els.length > 1 && p.pending.length < els.length - 1) {
      p.pending.push(pElapsed(p));
      var i = p.pending.length - 1;
      var prev = i > 0 ? p.pending[i - 1] : p.cycleStart;
      announce(label(p) + els[i].name + ' ' + fmtTime(p.pending[i] - prev) + ' 秒');
    } else {
      if (els.length > 1) p.pending.push(pElapsed(p));
      stopProc(p);
      announce(label(p) + 'ストップ ' + fmtTime(measured(p)) + ' 秒。「保存」で記録します。');
    }
    if (navigator.vibrate) { try { navigator.vibrate(18); } catch (e) { /* noop */ } }
    render();
    save();
  }

  /** 計測中の時間を1サイクルとして記録する。計測を続けたまま押せば区切りになる。 */
  function saveCycle(p) {
    var t = pElapsed(p);
    if (t - p.cycleStart <= 0) { toast('まだ計測がありません'); return; }
    var marks = p.pending.slice();
    if (!marks.length || marks[marks.length - 1] < t) marks.push(t);
    p.cycles.push({
      startAcc: p.cycleStart, marks: marks,
      excluded: false, note: '', at: nowIso()
    });
    p.cycleStart = t;
    p.pending = [];
    announce(label(p) + 'サイクル ' + p.cycles.length + ' を記録しました（' +
      fmtTime(totalOf(p.cycles[p.cycles.length - 1])) + ' 秒）');
    if (navigator.vibrate) { try { navigator.vibrate(12); } catch (e) { /* noop */ } }
    render();
    save();
  }

  /** 計測中の時間だけを 0 に戻す。記録済みのサイクルは消さない。 */
  function clearCurrent(p) {
    if (!p.started) return;
    stopProc(p);
    p.pending = [];
    p.cycleStart = pElapsed(p);
    announce(label(p) + '計測中の時間を 0 に戻しました（記録済みのデータはそのままです）。');
    render();
    save();
  }

  /** 画面下の共通ボタン：表示中のステーションをまとめて開始 / 一時停止する。 */
  function targetsForBulk() {
    if (!multi()) return stations();
    return state.focus === 'all' ? stations() : stationsOf(groupById(state.focus));
  }

  function toggleAll() {
    var list = targetsForBulk();
    if (list.some(pRunning)) {
      list.forEach(stopProc);
      announce('ストップしました。「保存」で記録、もう一度タップで続きから計測します。');
    } else {
      list.forEach(startProc);
      announce(multi() ? list.length + ' ステーションをスタートしました。' : 'スタート。');
    }
    render(); save();
  }

  function undo(p) {
    if (p.pending.length) {
      p.pending.pop();
      announce(label(p) + '直前の区切りを取り消しました。');
    } else if (p.cycles.length) {
      var c = p.cycles.pop();
      p.cycleStart = c.startAcc;
      p.pending = c.marks.slice(0, -1);
      announce(label(p) + 'サイクル ' + (p.cycles.length + 1) + ' を取り消しました。');
    } else {
      return;
    }
    render();
    save();
  }

  function discardCycle(p) {
    if (!p.started) return;
    p.pending = [];
    p.cycleStart = pElapsed(p);
    announce(label(p) + '現在のサイクルを破棄しました。ここから測り直します。');
    render();
    save();
  }

  function hasData() {
    return stations().some(function (p) { return p.cycles.length > 0; });
  }

  function resetAll() {
    if (hasData() && !confirm('記録したサイクルをすべて消去します。よろしいですか？\n（消す前に自動でバックアップを取り、「保存した測定」から戻せます）')) return;
    autoArchive('リセット前');
    state.startedAt = null;
    stations().forEach(function (p) {
      p.cycles = []; p.pending = []; p.cycleStart = 0; p.accBase = 0; p.started = false;
    });
    RUN = {};
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
    if (document.visibilityState === 'visible' && anyRunning()) requestWakeLock();
    if (document.visibilityState === 'hidden') save();
  });

  /* ================================================================ タブ */
  var TABS = ['measure', 'stats', 'table', 'settings'];

  function applyTab() {
    var t = state.tab;
    document.querySelectorAll('[data-tab-panel]').forEach(function (el) {
      var tabs = el.getAttribute('data-tab-panel').split(' ');
      var want = tabs.indexOf(t) >= 0;
      if (el.id === 'viewswitch') want = want && multi();
      el.hidden = !want;
    });
    document.querySelectorAll('.tab').forEach(function (b) {
      b.setAttribute('aria-current', String(b.getAttribute('data-tab') === t));
    });
  }

  function setTab(t, dir) {
    if (TABS.indexOf(t) < 0 || state.tab === t) return;
    state.tab = t;
    applyTab();
    renderCharts();          // 隠れている間に幅が変わっているため描き直す
    window.scrollTo(0, 0);
    if (dir) {
      var main = document.querySelector('main');
      main.classList.remove('slide-l', 'slide-r');
      void main.offsetWidth;                       // アニメーションを再生させる
      main.classList.add(dir === 'left' ? 'slide-l' : 'slide-r');
    }
    saveSoon();
  }

  /** 左右スワイプでタブを切り替える（横スクロールする表と入力の上では無効）。 */
  (function initSwipe() {
    var x0 = null, y0 = null, blocked = false, swiped = 0;

    document.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) { x0 = null; return; }
      var t = e.touches[0];
      x0 = t.clientX; y0 = t.clientY;
      blocked = !!(e.target.closest &&
        e.target.closest('.table-wrap, input, select, textarea, .tabs, .focus, .viewswitch'));
    }, { passive: true });

    document.addEventListener('touchend', function (e) {
      var sx = x0; x0 = null;
      if (sx == null || blocked) return;
      var t = e.changedTouches[0];
      var dx = t.clientX - sx, dy = t.clientY - y0;
      if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 2) return;
      var i = TABS.indexOf(state.tab);
      var next = TABS[i + (dx < 0 ? 1 : -1)];
      if (!next) return;
      swiped = Date.now();
      setTab(next, dx < 0 ? 'left' : 'right');
    }, { passive: true });

    // スワイプの流れでボタンが押されてしまうのを防ぐ
    document.addEventListener('click', function (e) {
      if (swiped && Date.now() - swiped < 400) { e.stopPropagation(); e.preventDefault(); }
    }, true);
  })();

  /* ============================================================== 描画：計測 */
  /** 計測パネルに表示するステーション（工程で絞り込む） */
  function focusStations() {
    if (state.focus === 'all') return stations();
    return stationsOf(groupById(state.focus));
  }

  function renderLive() {
    var run = stations().filter(pRunning).length;
    var live = $('app-live');
    var badge = $('tab-badge');
    live.hidden = !run;
    badge.hidden = !run;
    if (run) {
      badge.textContent = String(run);
      $('app-live-text').textContent = (multi() ? '計測中 ' + run + ' ' : '計測中 ') + fmtTime(elapsed());
    }
  }

  /** 毎フレーム動かす数字だけを更新する。 */
  function renderReadout() {
    renderLive();
    if (multi()) {
      var tot = elapsed();
      $('multi-total').textContent = fmtTime(tot);
      $('multi-unit').textContent = unitFor(tot);
      focusStations().forEach(function (p) {
        var el = $('ptime-' + p.id);
        if (el) el.firstChild.nodeValue = p.started ? fmtTime(pCycleElapsed(p)) : '0.00';
      });
      return;
    }
    var p0 = stations()[0];
    var ce = p0.started ? pCycleElapsed(p0) : 0;
    $('readout-cycle').textContent = fmtTime(ce);
    $('readout-unit').textContent = unitFor(ce);
    $('readout-elem').textContent = p0.started ? fmtTime(pElementElapsed(p0)) : '0.00';
    $('readout-total').textContent = fmtTime(elapsed());
  }

  /** 表示密度。未指定ならステーション数で自動判定。 */
  function density() {
    return state.density || (stations().length > 8 ? 'list' : 'card');
  }

  /** まだ何も登録していないときに、最初の一歩を計測画面に出す。 */
  function renderSetupNote() {
    var el = $('setup-note');
    if (!el) return;
    var fresh = stations().length === 1 && !hasData() && !anyStarted() &&
      groups().length === 1 && pElements(stations()[0]).length === 1;
    el.hidden = !fresh;
    if (!fresh) return;
    var pre = BUILTIN_PRESETS[0];
    el.innerHTML = '<div class="setup-note__body">' +
      '<strong>まだ工程が入っていません</strong>' +
      '<span>用意された構成を入れるか、設定でステーションを追加してください。</span>' +
      '</div>' +
      '<div class="setup-note__actions">' +
        '<button type="button" class="btn btn--primary" data-act="use-preset" data-builtin="' +
          esc(pre.id) + '">' + esc(pre.name) + ' を入れる</button>' +
        '<button type="button" class="btn" data-act="go-settings">設定を開く</button>' +
      '</div>';
  }

  function renderMeasure() {
    renderSetupNote();
    var isMulti = multi();
    $('measure-single').hidden = isMulti;
    $('measure-multi').hidden = !isMulti;
    if (isMulti) { renderFocusChips(); renderDensityChips(); renderCards(); } else renderSingleMeasure();
    renderControls();
    renderReadout();
  }

  function renderDensityChips() {
    var d = density();
    document.querySelectorAll('#density [data-density]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-density') === d));
    });
  }

  function renderSingleMeasure() {
    var p = stations()[0];
    var els = pElements(p);
    var idx = Math.min(p.pending.length, els.length - 1);
    $('readout-elem-name').textContent = p.started ? els[idx].name : '—';
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

    var host = $('steps');
    if (els.length < 2) { host.innerHTML = ''; host.hidden = true; }
    else {
      host.hidden = false;
      host.innerHTML = els.map(function (el, i) {
        var cls = 'step', time = '';
        if (p.started && i < p.pending.length) {
          cls += ' step--done';
          var prev = i ? p.pending[i - 1] : p.cycleStart;
          time = '<span class="step__time">' + fmtTime(p.pending[i] - prev) + '</span>';
        } else if (p.started && i === p.pending.length) {
          cls += ' step--current';
        }
        return '<span class="' + cls + '" role="listitem">' +
          '<span class="step__dot" style="background:' + seriesVar(i) + '"></span>' +
          '<span>' + esc(el.name) + '</span>' + time + '</span>';
      }).join('');
    }

    var main = $('lap-btn-main'), sub = $('lap-btn-sub'), btn = $('btn-lap');
    var run = pRunning(p);
    var cta = ctaLabel(p, run, els);
    main.textContent = cta.long;
    btn.dataset.paused = run ? 'false' : 'true';
    if (!run && hasUnsaved(p)) sub.textContent = '未保存 ' + fmtTime(measured(p)) + ' 秒 —「保存」で記録します';
    else if (run && els.length > 1) sub.textContent = (p.pending.length + 1) + ' / ' + els.length + ' 番目の要素作業';
    else if (run) sub.textContent = 'もう一度押すとストップします';
    else sub.textContent = p.cycles.length + ' サイクル記録済み（Space キーでも操作できます）';
  }

  function renderFocusChips() {
    var host = $('focus-chips');
    if (groups().length < 2) { host.innerHTML = ''; host.hidden = true; return; }
    host.hidden = false;
    var chips = ['<button type="button" class="chip" data-focus="all" aria-pressed="' +
      (state.focus === 'all') + '">すべて<span class="chip__n">' + stations().length + '</span></button>'];
    groups().forEach(function (g, i) {
      var n = stationsOf(g).length;
      var run = stationsOf(g).filter(pRunning).length;
      chips.push('<button type="button" class="chip" data-focus="' + esc(g.id) + '" aria-pressed="' +
        (state.focus === g.id) + '"><span class="swatch" style="' + swatchBg(i) + '"></span>' +
        esc(g.name) + '<span class="chip__n">' + (run ? run + '/' : '') + n + '</span></button>');
    });
    host.innerHTML = chips.join('');
  }

  function renderCards() {
    var tt = taktMs();
    var neck = neckOf(stations());
    var visible = focusStations();
    var shown = [];
    var html = '';

    groups().forEach(function (g) {
      var list = stationsOf(g).filter(function (p) { return visible.indexOf(p) >= 0; });
      if (!list.length) return;
      var sm = groupSummary(g);
      var meta = [];
      meta.push(list.length + ' ST');
      if (sm.withData.length) {
        meta.push('工数 ' + sec(sm.sum, sm.sum >= 60000 ? 1 : 2) + ' 秒');
        if (sm.neck) meta.push('ネック ' + esc(sm.neck.name) + ' ' + fmtTime(pStats(sm.neck).mean));
      }
      var asList = density() === 'list';
      // 1ステーションだけの工程は見出しを省いて、工程名をカード内に出す
      var inline = groups().length > 1 && list.length === 1 ? g.name : '';
      var body = list.map(function (p) {
        shown.push(p);
        return asList ? rowHtml(p, shown.length, tt, neck, inline)
                      : cardHtml(p, shown.length, tt, neck, inline);
      }).join('');
      html += '<div class="pgroup" style="--pc:' + seriesVar(groupIndex(g)) + '">' +
        (groups().length > 1 && !inline
          ? '<div class="pgroup__head"><span class="pgroup__bar"></span>' +
            '<h3 class="pgroup__name">' + esc(g.name) + '</h3>' +
            '<span class="pgroup__meta">' + meta.slice(0, 1).join('') + '</span>' +
            '<span class="pgroup__meta pgroup__meta--wide">' + meta.slice(1).join('　') + '</span></div>'
          : '') +
        (asList
          ? '<div class="srows">' + body + '</div>'
          : '<div class="pcards' + (visible.length > 6 ? ' pcards--dense' : '') + '">' + body + '</div>') +
        '</div>';
    });

    if (!shown.length) {
      html = '<p class="empty-note">この工程にはステーションがありません。' +
        '<button type="button" class="btn btn--sm" data-act="go-settings">設定で追加</button></p>';
    }
    $('pcards').innerHTML = html;
    var runN = stations().filter(pRunning).length;
    $('multi-hint').textContent = anyStarted()
      ? '各ステーションのボタンを、そのステーションが1サイクル終わるたびに押してください。' +
        '（計測中 ' + runN + ' / ' + stations().length + '）'
      : 'ステーションごとに独立したストップウォッチです。1つずつ開始しても、下のボタンでまとめて動かしても構いません。';
  }

  /**
   * ステーションのカード。1枚を小さく保つため、上半分（名前＋経過＋操作ラベル）
   * ぜんぶをタップ領域にして、リセットと保存は下の細い行にまとめる。
   */
  function cardHtml(p, num, tt, neck, groupName) {
    var st = pStats(p);
    var els = pElements(p);
    var last = p.cycles.length ? totalOf(p.cycles[p.cycles.length - 1]) : null;
    var run = pRunning(p);
    var unsaved = hasUnsaved(p);
    var cta = ctaLabel(p, run, els);

    var badges = '';
    if (neck === p && st.n) badges += '<span class="badge">ネック</span>';
    if (tt && st.n && st.mean > tt) badges += '<span class="badge badge--muted">TT超過</span>';

    var sub;
    if (unsaved && !run) {
      sub = '<span class="pcard__unsaved">未保存 ' + fmtTime(measured(p)) + ' 秒</span>' +
        (st.n ? '　' + st.n + '回　平均 <b>' + fmtTime(st.mean) + '</b>' : '');
    } else if (st.n) {
      sub = st.n + '回　直前 <b>' + fmtTime(last) + '</b>　平均 <b>' + fmtTime(st.mean) + '</b>';
    } else {
      sub = run ? '計測中' : '未計測';
    }
    if (els.length > 1 && p.started) {
      sub = (Math.min(p.pending.length + 1, els.length)) + '/' + els.length + ' ' +
        esc(els[Math.min(p.pending.length, els.length - 1)].name) + '　' + sub;
    }

    return '<div class="pcard" data-id="' + esc(p.id) + '" data-neck="' + (neck === p && st.n ? 'true' : 'false') +
      '" data-run="' + (run ? 'true' : 'false') + '" style="--pc:' + colorOf(p) + '">' +
      '<button type="button" class="pcard__hit" data-act="tap" data-id="' + esc(p.id) + '">' +
        '<span class="pcard__head">' +
          (run ? '<span class="pcard__dot" title="計測中"></span>' : '') +
          (groupName ? '<span class="pcard__group">' + esc(groupName) + '</span>' : '') +
          '<span class="pcard__name">' + esc(p.name) + '</span>' + badges +
          (num <= 9 ? '<span class="pcard__key">' + num + '</span>' : '') +
        '</span>' +
        '<span class="pcard__row">' +
          '<span class="pcard__time" id="ptime-' + esc(p.id) + '">0.00<small>秒</small></span>' +
          '<span class="pcard__cta"><span class="cta-long">' + esc(cta.long) +
            '</span><span class="cta-short">' + esc(cta.short) + '</span></span>' +
        '</span>' +
        '<span class="pcard__sub">' + sub + '</span>' +
      '</button>' +
      '<div class="pcard__actions">' +
        '<button type="button" class="btn btn--sm" data-act="clear" data-id="' + esc(p.id) + '"' +
          (unsaved ? '' : ' disabled') + '>リセット</button>' +
        '<button type="button" class="btn btn--sm' + (unsaved && !run ? ' btn--go' : '') +
          '" data-act="save" data-id="' + esc(p.id) + '"' +
          (unsaved ? '' : ' disabled') + '>保存</button>' +
      '</div>' +
    '</div>';
  }

  /** タップ領域に出す操作ラベル（狭い画面用の短い表記つき）。 */
  function ctaLabel(p, run, els) {
    if (!run) {
      return measured(p) > 0
        ? { long: '▶ 再開', short: '▶ 再開' }
        : { long: '▶ スタート', short: '▶ 開始' };
    }
    if (els.length > 1 && p.pending.length < els.length - 1) {
      return { long: els[p.pending.length].name + ' 完了', short: '次へ' };
    }
    return { long: '■ ストップ', short: '■ 停止' };
  }

  /** 1行1ステーションの詰め表示。行そのものがスタート／ストップ。 */
  function rowHtml(p, num, tt, neck, groupName) {
    var st = pStats(p);
    var els = pElements(p);
    var run = pRunning(p);
    var unsaved = hasUnsaved(p);
    var cta = ctaLabel(p, run, els);

    var flags = '';
    if (neck === p && st.n) flags += ' <span class="badge">ネック</span>';
    if (tt && st.n && st.mean > tt) flags += ' <span class="badge badge--muted">TT超過</span>';

    var sub = unsaved && !run
      ? '<span class="pcard__unsaved">未保存</span>　'
      : (st.n ? st.n + '回　平均 <b>' + fmtTime(st.mean) + '</b>　' : '');

    return '<div class="srow" data-run="' + (run ? 'true' : 'false') + '" data-neck="' +
      (neck === p && st.n ? 'true' : 'false') + '" style="--pc:' + colorOf(p) + '">' +
      '<button type="button" class="srow__main" data-act="tap" data-id="' + esc(p.id) + '">' +
        '<span class="srow__name">' + (num <= 9 ? '<span class="pcard__key">' + num + '</span> ' : '') +
          (groupName ? '<span class="pcard__group">' + esc(groupName) + '</span> ' : '') +
          esc(p.name) + flags + '</span>' +
        '<span class="srow__time" id="ptime-' + esc(p.id) + '">0.00</span>' +
        '<span class="srow__sub">' + sub + '<span class="srow__cta">' + esc(cta.long) + '</span></span>' +
      '</button>' +
      '<div class="srow__side">' +
        '<button type="button" class="btn btn--sm" data-act="clear" data-id="' + esc(p.id) + '"' +
          (unsaved ? '' : ' disabled') + ' aria-label="' + esc(p.name) + ' の計測をリセット">リセット</button>' +
        '<button type="button" class="btn btn--sm' + (unsaved && !run ? ' btn--go' : '') +
          '" data-act="save" data-id="' + esc(p.id) + '"' +
          (unsaved ? '' : ' disabled') + ' aria-label="' + esc(p.name) + ' の計測を保存">保存</button>' +
      '</div>' +
    '</div>';
  }

  function renderControls() {
    var p0 = stations()[0];
    var list = targetsForBulk();
    var run = list.some(pRunning);
    var btn = $('btn-pause');
    btn.disabled = false;
    var scope = (multi() && state.focus !== 'all') ? groupById(state.focus).name : '全ステーション';
    if (multi()) btn.textContent = scope + (run ? 'をストップ' : 'をスタート');
    else btn.textContent = run ? 'ストップ' : (measured(p0) > 0 ? '再開' : 'スタート');
    var single = !multi();
    // 単一ステーションでは大ボタンがスタート／ストップを兼ねる
    $('btn-pause').hidden = single;
    $('btn-save-cycle').hidden = !single;
    $('btn-clear').hidden = !single;
    $('btn-undo').hidden = !single;
    $('btn-save-cycle').disabled = !hasUnsaved(p0);
    $('btn-save-cycle').classList.toggle('btn--go', hasUnsaved(p0) && !pRunning(p0));
    $('btn-clear').disabled = !hasUnsaved(p0);
    $('btn-undo').disabled = !p0.cycles.length;
    $('btn-reset').disabled = !anyStarted() && !hasData();
    $('controls').style.gridTemplateColumns = multi() ? 'repeat(2, minmax(0, 1fr))' : '';
    $('controls').classList.toggle('controls--single', single);
  }

  /* ============================================================== 表示切替 */
  var SCOPE_IDS = ['scope-stats', 'scope-charts', 'scope-table'];
  function setScope(html) { SCOPE_IDS.forEach(function (id) { $(id).innerHTML = html; }); }

  function renderViewSwitch() {
    var host = $('viewswitch');
    if (!multi()) {
      host.hidden = true;
      $('view-groups').innerHTML = '';
      $('view-stations').innerHTML = '';
      setScope('');
      return;
    }
    host.hidden = false;

    var lv = viewLevel();
    var g = viewGroup();
    var rows = ['<button type="button" class="chip" data-view="all" aria-selected="' +
      (state.view === 'all') + '">ライン全体</button>'];
    groups().forEach(function (gr, i) {
      rows.push('<button type="button" class="chip" data-view="g:' + esc(gr.id) + '" aria-selected="' +
        (g === gr) + '"><span class="swatch" style="' + swatchBg(i) + '"></span>' +
        esc(gr.name) + '<span class="chip__n">' + stationsOf(gr).length + '</span></button>');
    });
    $('view-groups').innerHTML = rows.join('');

    var sub = $('view-stations');
    var subRow = $('view-stations-row');
    if (!g) { sub.innerHTML = ''; subRow.hidden = true; }
    else {
      subRow.hidden = false;
      var list = stationsOf(g);
      var chips = ['<button type="button" class="chip chip--sub" data-view="g:' + esc(g.id) +
        '" aria-selected="' + (lv === 'group') + '">' + esc(g.name) + ' 全体</button>'];
      list.forEach(function (p) {
        chips.push('<button type="button" class="chip chip--sub" data-view="s:' + esc(p.id) +
          '" aria-selected="' + (lv === 'station' && viewStation() === p) + '">' + esc(p.name) + '</button>');
      });
      sub.innerHTML = chips.join('');
    }

    if (lv === 'line') setScope('ライン全体（' + groups().length + ' 工程・' + stations().length + ' ステーション）');
    else if (lv === 'group') {
      setScope('<span class="swatch" style="background:' + seriesVar(groupIndex(g)) + '"></span>' +
        esc(g.name) + '（' + stationsOf(g).length + ' ステーション）');
    } else {
      var p = viewStation();
      setScope('<span class="swatch" style="background:' + colorOf(p) + '"></span>' +
        esc(groupOf(p).name) + ' / ' + esc(p.name));
    }
  }

  /* ============================================================== 描画：集計 */
  function tile(label, value, unit, note, cls) {
    return '<div class="tile' + (cls ? ' ' + cls : '') + '">' +
      '<span class="tile__label">' + esc(label) + '</span>' +
      '<span class="tile__value">' + value + (unit ? '<small>' + unit + '</small>' : '') + '</span>' +
      (note ? '<span class="tile__note">' + note + '</span>' : '') + '</div>';
  }

  function renderTiles() {
    var lv = viewLevel();
    $('stats-actions').hidden = lv !== 'station';
    if (lv === 'station') renderProcTiles(viewStation());
    else renderGroupTiles(lv === 'group' ? viewGroup() : null);
  }

  /** ライン全体 / 工程（大）の集計。ネックとバランスを主役にする。 */
  function renderGroupTiles(g) {
    var host = $('tiles');
    var list = g ? stationsOf(g) : stations();
    var tt = taktMs();
    var neck = neckOf(list);
    var scope = g ? g.name : 'ライン';
    if (!neck) {
      host.innerHTML = tile('ネックステーション', '—', '', '計測データがありません', 'tile--hero');
      $('takt-bar').innerHTML = '';
      return;
    }
    var neckSt = pStats(neck);
    var withData = list.filter(function (p) { return pStats(p).n; });
    var sum = withData.reduce(function (a, p) { return a + pStats(p).mean; }, 0);
    var over = tt ? withData.filter(function (p) { return pStats(p).mean > tt; }) : [];
    var bal = balanceRate(list);

    var html = '';
    html += tile('ネックステーション', esc(neck.name), '',
      (g ? '' : esc(groupOf(neck).name) + '／') + '平均 ' + fmtTime(neckSt.mean) +
      ' 秒・' + scope + 'のペースを決めます', 'tile--hero');
    html += tile('ラインバランス効率', bal == null ? '—' : bal.toFixed(1), bal == null ? '' : '%',
      bal == null ? '2ステーション以上で算出' : '100 % に近いほど工数の偏りが小さい');
    html += tile('合計工数', sec(sum, sum >= 60000 ? 1 : 2), '秒',
      (sum >= 60000 ? minSec(sum) + '／' : '') + withData.length + ' ステーションの平均を合計');
    if (tt) {
      html += tile('必要ステーション数', Math.ceil(sum / tt), '', '合計工数 ÷ タクト（理論値）');
      html += tile('タクト超過', over.length + ' <small>/ ' + withData.length + '</small>', '',
        over.length ? over.slice(0, 3).map(function (p) { return esc(p.name); }).join('、') +
          (over.length > 3 ? ' ほか' : '') : 'すべてタクト内');
    } else {
      html += tile('ステーション数', list.length, '', g ? '' : groups().length + ' 工程');
      html += tile('総観測時間', fmtTime(elapsed()), unitFor(elapsed()), 'タクトタイム未設定');
    }
    host.innerHTML = html;
    renderTaktBar(neckSt, tt, 'ネック ' + neck.name);
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
      html += tile('合計観測時間', fmtTime(elapsed()), unitFor(elapsed()), 'タクトタイム未設定');
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
    var lv = viewLevel();
    var undoBtn = $('btn-undo-cycle');
    if (undoBtn) {
      undoBtn.hidden = lv !== 'station';
      undoBtn.disabled = lv === 'station' && !viewStation().cycles.length;
    }
    $('table-groups-wrap').hidden = lv !== 'line';
    $('table-summary-wrap').hidden = lv === 'station';
    $('table-matrix-wrap').hidden = lv === 'station';
    $('table-cycles-wrap').hidden = lv !== 'station';
    if (lv === 'station') { renderCycleTable(viewStation()); return; }
    $('table-elements-wrap').hidden = true;
    if (lv === 'line') renderGroupTable();
    renderSummaryTable(viewStations());
    renderMatrixTable(viewStations());
  }

  /** 工程（大）ごとのサマリ */
  function renderGroupTable() {
    var tt = taktMs();
    var head = '<thead><tr><th>工程</th><th>ステーション</th><th>合計工数（秒）</th>' +
      '<th>平均（秒）</th><th>ネックステーション</th><th>ネック平均</th>' +
      (tt ? '<th>必要ST数</th>' : '') + '</tr></thead>';
    var body = groups().map(function (g, i) {
      var sm = groupSummary(g);
      var neckMean = sm.neck ? pStats(sm.neck).mean : 0;
      var avg = sm.withData.length ? sm.sum / sm.withData.length : 0;
      return '<tr><td><span class="swatch-cell"><span class="swatch" style="' + swatchBg(i) +
        '"></span>' + esc(g.name) + '</span></td>' +
        '<td class="num">' + sm.count + '</td>' +
        '<td class="num">' + (sm.withData.length ? sec(sm.sum) : '—') + '</td>' +
        '<td class="num">' + (sm.withData.length ? sec(avg) : '—') + '</td>' +
        '<td>' + (sm.neck ? esc(sm.neck.name) : '—') + '</td>' +
        '<td class="num">' + (sm.neck ? sec(neckMean) : '—') + '</td>' +
        (tt ? '<td class="num">' + (sm.withData.length ? Math.ceil(sm.sum / tt) : '—') + '</td>' : '') +
        '</tr>';
    }).join('');
    $('table-groups').innerHTML = head + '<tbody>' + body + '</tbody>';
  }

  /** ステーションごとのサマリ */
  function renderSummaryTable(list) {
    var tt = taktMs();
    var neck = neckOf(list);
    var showGroup = viewLevel() === 'line' && groups().length > 1;
    var head = '<thead><tr>' + (showGroup ? '<th>工程</th>' : '') +
      '<th>ステーション</th><th>サイクル</th><th>平均（秒）</th><th>中央値</th><th>最小</th><th>最大</th>' +
      '<th>σ</th><th>CV</th>' + (tt ? '<th>タクト差</th><th>判定</th>' : '') + '</tr></thead>';
    var body = list.map(function (p) {
      var s = pStats(p);
      var cells = '';
      if (showGroup) {
        cells += '<td><span class="swatch-cell"><span class="swatch" style="background:' + colorOf(p) +
          '"></span>' + esc(groupOf(p).name) + '</span></td>';
      }
      cells += '<td>' + esc(p.name) + (neck === p && s.n ? ' <span class="badge">ネック</span>' : '') + '</td>';
      if (!s.n) return '<tr>' + cells + '<td class="num">0</td><td colspan="' + (6 + (tt ? 2 : 0)) + '">—</td></tr>';
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

  function renderMatrixTable(list) {
    var maxN = Math.max.apply(null, list.map(function (p) { return p.cycles.length; }).concat([0]));
    var head = '<thead><tr><th>No</th>' + list.map(function (p) {
      return '<th><span class="swatch-cell"><span class="swatch" style="background:' + colorOf(p) +
        '"></span>' + esc(p.name) + '（秒）</span></th>';
    }).join('') + '</tr></thead>';
    var body = '';
    if (!maxN) {
      body = '<tr class="empty-row"><td colspan="' + (list.length + 1) + '">まだ計測データがありません</td></tr>';
    } else {
      for (var r = 0; r < maxN; r++) {
        body += '<tr><td>' + (r + 1) + '</td>' + list.map(function (p) {
          var c = p.cycles[r];
          if (!c) return '<td class="num">—</td>';
          return '<td class="num"' + (c.excluded ? ' style="color:var(--text-muted);text-decoration:line-through"' : '') +
            '>' + sec(totalOf(c)) + '</td>';
        }).join('') + '</tr>';
      }
      body += '<tr><td>平均</td>' + list.map(function (p) {
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
  var EL_OPEN = {};   // 要素作業の開閉を再描画でも保つ

  function renderProcList() {
    var locked = anyStarted() || hasData();
    var host = $('proc-list');
    host.innerHTML = groups().map(function (g, gi) {
      var list = stationsOf(g);
      var rows = list.map(function (p) {
        var els = pElements(p);
        return '<li class="stn">' +
          '<div class="stn__head">' +
            '<span class="swatch" style="background:' + seriesVar(gi) + '"></span>' +
            '<input type="text" value="' + esc(p.name) + '" data-act="rename-station" data-id="' + esc(p.id) +
              '" maxlength="24" aria-label="ステーション名"' + (locked ? ' disabled' : '') + '>' +
            (locked || list.length < 2 ? '' :
              '<button type="button" class="btn btn--icon" data-act="del-station" data-id="' + esc(p.id) +
              '" aria-label="ステーションを削除">✕</button>') +
          '</div>' +
          '<details class="stn__els" data-station="' + esc(p.id) + '"' +
            (els.length > 1 || EL_OPEN[p.id] ? ' open' : '') + '>' +
            '<summary>要素作業 ' + els.length + ' 個' + (els.length > 1 ? '' : '（分割なし）') + '</summary>' +
            '<ul class="elements__list">' + els.map(function (e, j) {
              return '<li class="elements__item">' +
                '<span class="elements__index">' + (j + 1) + '</span>' +
                '<input type="text" value="' + esc(e.name) + '" data-act="rename-element" data-id="' + esc(p.id) +
                  '" data-i="' + j + '" maxlength="24" aria-label="要素作業名"' + (locked ? ' disabled' : '') + '>' +
                (locked ? '' : '<button type="button" class="btn btn--icon" data-act="del-element" data-id="' +
                  esc(p.id) + '" data-i="' + j + '" aria-label="要素作業を削除">✕</button>') +
                '</li>';
            }).join('') + '</ul>' +
            (locked ? '' :
              '<div class="elements__add">' +
                '<input type="text" data-act="new-element" data-id="' + esc(p.id) +
                  '" placeholder="要素作業を追加" maxlength="24"' + (els.length >= MAX_ELEMENTS ? ' disabled' : '') + '>' +
                '<button type="button" class="btn btn--sm" data-act="add-element" data-id="' + esc(p.id) + '"' +
                  (els.length >= MAX_ELEMENTS ? ' disabled' : '') + '>追加</button>' +
              '</div>') +
          '</details>' +
        '</li>';
      }).join('');

      return '<div class="proc" style="--pc:' + seriesVar(gi) + '">' +
        '<div class="proc__head">' +
          '<span class="elements__index">' + (gi + 1) + '</span>' +
          '<span class="swatch" style="' + swatchBg(gi) + '"></span>' +
          '<input type="text" value="' + esc(g.name) + '" data-act="rename-group" data-id="' + esc(g.id) +
            '" maxlength="20" aria-label="工程名"' + (locked ? ' disabled' : '') + '>' +
          '<span class="proc__count">' + list.length + ' ST</span>' +
          (locked || groups().length < 2 ? '' :
            '<button type="button" class="btn btn--icon" data-act="del-group" data-id="' + esc(g.id) +
            '" aria-label="工程を削除">✕</button>') +
        '</div>' +
        '<div class="proc__body">' +
          '<ul class="stn__list">' + rows + '</ul>' +
        '</div>' +
      '</div>';
    }).join('');

    var full = stations().length >= MAX_STATIONS;
    $('in-proc').disabled = locked || groups().length >= MAX_GROUPS;
    $('btn-add-proc').disabled = locked || groups().length >= MAX_GROUPS;
    $('in-station').disabled = locked || full;
    $('btn-add-station').disabled = locked || full;

    // 追加先の工程。工程が1つだけなら選ばせない
    var sel = $('in-station-group');
    var many = groups().length > 1;
    sel.hidden = !many || locked;
    if (many) {
      var cur = sel.value;
      sel.innerHTML = groups().map(function (g) {
        return '<option value="' + esc(g.id) + '">' + esc(g.name) + ' に追加</option>';
      }).join('');
      if (groups().some(function (g) { return g.id === cur; })) sel.value = cur;
    }

    var hint = $('proc-hint');
    if (locked) {
      hint.textContent = '記録したサイクルがあるため構成は変更できません。変更するには「全データ消去」してください。';
      hint.className = 'hint hint--warn';
    } else if (full) {
      hint.textContent = 'ステーションは全体で最大 ' + MAX_STATIONS + ' 個までです。';
      hint.className = 'hint hint--warn';
    } else {
      hint.textContent = '登録済み：工程 ' + groups().length + ' / ' + MAX_GROUPS +
        '、ステーション ' + stations().length + ' / ' + MAX_STATIONS + '。';
      hint.className = 'hint';
    }
  }

  function renderSessions() {
    var list = loadSessions();
    var t = $('table-sessions');
    var head = '<thead><tr><th>名前</th><th>保存日時</th><th>工程</th><th>ST</th><th>サイクル</th>' +
      '<th>ネックの平均（秒）</th><th>操作</th></tr></thead>';
    if (!list.length) {
      t.innerHTML = head + '<tbody><tr class="empty-row"><td colspan="7">保存した測定はありません</td></tr></tbody>';
      return;
    }
    var body = list.map(function (s) {
      var st = normalize(s.data || s);
      var total = 0, neckMean = 0, neckName = '—';
      st.stations.forEach(function (p) {
        total += p.cycles.length;
        var ps = stats(p.cycles.filter(function (c) { return !c.excluded; }).map(totalOf));
        if (ps.n && ps.mean > neckMean) { neckMean = ps.mean; neckName = p.name; }
      });
      return '<tr><td>' + (s.rescue ? '<span class="badge">復元用</span> '
          : (s.auto ? '<span class="badge badge--muted">自動</span> ' : '')) +
        esc(s.name) + '</td><td>' + fmtDateTime(s.savedAt) + '</td>' +
        '<td class="num">' + st.groups.length + '</td><td class="num">' + st.stations.length + '</td>' +
        '<td class="num">' + total + '</td>' +
        '<td class="num">' + (neckMean ? esc(neckName) + ' ' + sec(neckMean) : '—') + '</td>' +
        '<td><button type="button" class="btn btn--sm" data-act="load-session" data-id="' + esc(s.id) + '">読込</button> ' +
        '<button type="button" class="btn btn--sm" data-act="csv-session" data-id="' + esc(s.id) + '">CSV</button> ' +
        '<button type="button" class="btn btn--sm btn--danger" data-act="del-session" data-id="' + esc(s.id) + '">削除</button></td></tr>';
    }).join('');
    t.innerHTML = head + '<tbody>' + body + '</tbody>';
    updateStorageHint();
  }

  /** 上部の警告バー（新しい形式のデータ・データ減少を検出したときなど） */
  function renderAlert() {
    var bar = $('alertbar');
    if (rescueNotice) {
      bar.hidden = false;
      bar.dataset.kind = 'info';
      $('alertbar-text').textContent = '前回より内容が減っていたため、古いデータを「保存した測定」に' +
        '退避しました（' + rescueNotice + '）。設定タブの一覧から戻せます。';
      $('alertbar-action').textContent = '設定を開く';
      $('alertbar-action').onclick = function () {
        rescueNotice = '';
        setTab('settings');
        renderAlert();
      };
      return;
    }
    bar.dataset.kind = 'warn';
    if (readOnly) {
      bar.hidden = false;
      $('alertbar-text').textContent =
        'このブラウザには、より新しいバージョンで保存されたデータがあります。' +
        'そのままだと壊してしまうため、書き込みを止めています。ページを再読み込みしてください。';
      $('alertbar-action').textContent = '再読み込み';
      $('alertbar-action').onclick = function () { location.reload(true); };
      return;
    }
    bar.hidden = true;
  }

  function syncSettingsInputs() {
    $('in-title').value = state.settings.title;
    $('in-operator').value = state.settings.operator;
    $('in-memo').value = state.settings.memo;
    $('in-takt').value = state.settings.takt == null ? '' : state.settings.takt;
  }

  function render() {
    renderMeasure();
    renderViewSwitch();
    renderTiles();
    renderTables();
    renderProcList();
    renderCharts();
    renderAlert();
    applyTab();
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
      (opts.rotate ? ' transform="rotate(' + opts.rotate + ' ' + nn(x) + ' ' + nn(y) + ')"' : '') +
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

  function tipStation(p, tt, extra) {
    var s = pStats(p);
    if (!s.n) {
      return '<strong>' + esc(p.name) + '</strong><div class="tt-row"><span class="tt-key">状態</span><span>未計測</span></div>';
    }
    return '<strong>' + esc(p.name) + '</strong>' +
      (multi() ? '<div class="tt-row"><span class="tt-key">工程</span><span>' + esc(groupOf(p).name) + '</span></div>' : '') +
      '<div class="tt-row"><span class="tt-key">平均</span><span class="tt-val">' + fmtTime(s.mean) + ' 秒</span></div>' +
      '<div class="tt-row"><span class="tt-key">最小 / 最大</span><span class="tt-val">' + fmtTime(s.min) + ' / ' + fmtTime(s.max) + '</span></div>' +
      '<div class="tt-row"><span class="tt-key">σ / CV</span><span class="tt-val">' + fmtTime(s.sd) + ' / ' + s.cv.toFixed(1) + ' %</span></div>' +
      '<div class="tt-row"><span class="tt-key">サイクル数</span><span class="tt-val">' + s.n + ' 回</span></div>' +
      (tt ? '<div class="tt-row"><span class="tt-key">タクト差</span><span class="tt-val" style="color:' +
        (s.mean > tt ? 'var(--critical)' : 'var(--success-text)') + '">' +
        (s.mean > tt ? '▲ +' : '') + fmtTime(s.mean - tt) + '</span></div>' : '') +
      (extra || '');
  }

  /* -------------------------------------------- ① ステーション別の平均（山積み表） */
  function renderBalanceChart(list, showGroups) {
    var host = $('chart-balance');
    if (!list.some(function (p) { return pStats(p).n; })) {
      markEmpty('chart-balance');
      $('legend-balance').innerHTML = ''; $('fig-balance-sub').textContent = '';
      return;
    }
    host.dataset.state = '';

    var tt = taktMs();
    var neck = neckOf(list);
    var rows = list.map(function (p) { return { p: p, st: pStats(p) }; });
    var dataMax = Math.max.apply(null, rows.map(function (r) { return r.st.max || 0; }).concat(tt ? [tt] : []));
    var scale = niceScale(dataMax / 1000 * 1.02, 5);
    var yMax = scale.max * 1000;

    var w = chartWidth(host);
    var padL = 48, padR = 66, padT = 34, plotH = 200;
    var plotW = w - padL - padR;
    var band = plotW / rows.length;
    var rotate = band < 46;
    var padB = (rotate ? 76 : 44) + (showGroups ? 26 : 0);
    var h = padT + plotH + padB;
    var yOf = function (v) { return padT + plotH - (v / yMax) * plotH; };

    var s = ['<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="ステーションごとの平均サイクルタイム">'];
    s.push(hatchDefs(list.map(function (p) { return groupIndex(groupOf(p)); })));
    scale.ticks.forEach(function (t) {
      var y = yOf(t * 1000);
      s.push('<line x1="' + padL + '" y1="' + nn(y) + '" x2="' + nn(padL + plotW) + '" y2="' + nn(y) +
        '" stroke="var(--grid)" stroke-width="1" />');
      s.push(txt(padL - 8, y, tickLabel(t), { anchor: 'end', baseline: 'middle', tabular: true }));
    });
    s.push('<line x1="' + padL + '" y1="' + nn(padT + plotH) + '" x2="' + nn(padL + plotW) +
      '" y2="' + nn(padT + plotH) + '" stroke="var(--axis)" stroke-width="1" />');

    var barW = Math.min(24, Math.max(4, band * 0.62));
    var labelAll = band >= 34;
    rows.forEach(function (r, k) {
      var cx = padL + band * (k + 0.5);
      var x = cx - barW / 2;
      if (r.st.n) {
        var yTop = yOf(r.st.mean);
        s.push('<path d="' + topRounded(x, yTop, barW, padT + plotH - yTop, 4) +
          '" fill="' + svgFill(groupIndex(groupOf(r.p))) + '" />');
        if (r.st.max > r.st.min && barW >= 8) {
          var y1 = yOf(r.st.min), y2 = yOf(r.st.max);
          s.push('<line x1="' + nn(cx) + '" y1="' + nn(y1) + '" x2="' + nn(cx) + '" y2="' + nn(y2) +
            '" stroke="var(--surface-1)" stroke-width="4" />');
          s.push('<line x1="' + nn(cx) + '" y1="' + nn(y1) + '" x2="' + nn(cx) + '" y2="' + nn(y2) +
            '" stroke="var(--text-secondary)" stroke-width="1.5" />');
          [y1, y2].forEach(function (yy) {
            s.push('<line x1="' + nn(cx - 4) + '" y1="' + nn(yy) + '" x2="' + nn(cx + 4) + '" y2="' + nn(yy) +
              '" stroke="var(--text-secondary)" stroke-width="1.5" />');
          });
        }
        var labelY = Math.max(yOf(r.st.max) - 10, 24);
        if (labelAll || neck === r.p) {
          s.push(txt(cx, labelY, sec(r.st.mean),
            { anchor: 'middle', fill: 'var(--text-primary)', size: 12, weight: 600, tabular: true }));
        }
        if (neck === r.p) {
          s.push(txt(cx, labelY - 15, '▲ ネック',
            { anchor: 'middle', fill: 'var(--critical)', size: 11, weight: 700 }));
        }
      } else if (band >= 34) {
        s.push(txt(cx, padT + plotH - 8, '未計測', { anchor: 'middle' }));
      }

      // ステーション名
      if (rotate) {
        s.push(txt(cx, padT + plotH + 14, clipName(r.p.name, 9),
          { anchor: 'end', fill: 'var(--text-primary)', size: 11, rotate: -45 }));
      } else {
        s.push(txt(cx, padT + plotH + 18, clipName(r.p.name, Math.max(4, Math.floor(band / 13))),
          { anchor: 'middle', fill: 'var(--text-primary)', size: 12 }));
      }

      var key = 'b-' + k;
      TIPS[key] = tipStation(r.p, tt);
      s.push('<rect class="hit" x="' + nn(padL + band * k) + '" y="' + padT + '" width="' + nn(band) +
        '" height="' + nn(plotH) + '" fill="transparent" data-tip="' + key + '" />');
    });

    // 工程（大）の区切りと見出し
    if (showGroups) {
      var y0 = padT + plotH + (rotate ? 60 : 30);
      var idx = 0;
      groups().forEach(function (g, gi) {
        var members = rows.filter(function (r) { return r.p.groupId === g.id; });
        if (!members.length) return;
        var from = padL + band * idx;
        var to = from + band * members.length;
        idx += members.length;
        s.push('<line x1="' + nn(from + 3) + '" y1="' + nn(y0) + '" x2="' + nn(to - 3) + '" y2="' + nn(y0) +
          '" stroke="' + seriesVar(gi) + '" stroke-width="3" stroke-linecap="round" />');
        if (to - from >= 56) {
          s.push(txt((from + to) / 2, y0 + 15, clipName(g.name, Math.max(4, Math.floor((to - from) / 12))),
            { anchor: 'middle', fill: 'var(--text-secondary)', size: 11, weight: 600 }));
        }
        if (to < padL + plotW - 1) {
          s.push('<line x1="' + nn(to) + '" y1="' + padT + '" x2="' + nn(to) + '" y2="' + nn(padT + plotH) +
            '" stroke="var(--grid)" stroke-width="1" />');
        }
      });
    }

    if (tt) {
      var yt = yOf(tt);
      s.push('<line x1="' + padL + '" y1="' + nn(yt) + '" x2="' + nn(padL + plotW) + '" y2="' + nn(yt) +
        '" stroke="var(--critical)" stroke-width="2" stroke-dasharray="6 4" />');
      s.push(txt(padL + plotW + 7, yt, 'TT ' + fmtTime(tt),
        { baseline: 'middle', fill: 'var(--text-secondary)', size: 11, tabular: true }));
    }
    s.push('</svg>');
    host.innerHTML = s.join('');

    var lg = [];
    if (showGroups && groups().length > 1) {
      groups().forEach(function (g, gi) {
        if (!stationsOf(g).length) return;
        lg.push('<span class="legend__item"><span class="legend__swatch" style="' + swatchBg(gi) +
          '"></span>' + esc(g.name) + '</span>');
      });
    }
    lg.push('<span class="legend__item">棒＝平均、細線＝最小〜最大</span>');
    if (tt) lg.push('<span class="legend__item" style="color:var(--critical)"><span class="legend__swatch legend__swatch--dash"></span><span style="color:var(--text-secondary)">タクトタイム</span></span>');
    lg.push('<span class="legend__item"><span style="color:var(--critical)">▲</span>ネック（最長）</span>');
    $('legend-balance').innerHTML = lg.join('');
    var bal = balanceRate(list);
    $('fig-balance-sub').textContent = '縦軸：秒　' + list.length + ' ステーション' +
      (bal == null ? '' : '　ラインバランス効率 ' + bal.toFixed(1) + ' %') +
      (labelAll ? '' : '　※値はネックのみ表示（明細表に全ステーション）');
  }

  /* -------------------------------------------- ② 工程（大）別の工数内訳 */
  function renderGroupStackChart() {
    var host = $('chart-groups');
    var sums = groups().map(function (g) { return groupSummary(g); });
    if (!sums.some(function (sm) { return sm.withData.length; })) {
      markEmpty('chart-groups');
      $('legend-groups').innerHTML = ''; $('fig-groups-sub').textContent = '';
      return;
    }
    host.dataset.state = '';

    var tt = taktMs();
    var dataMax = Math.max.apply(null, sums.map(function (sm) { return sm.sum; }));
    var scale = niceScale(dataMax / 1000 * 1.02, 5);
    var yMax = scale.max * 1000;

    var w = chartWidth(host);
    var padL = 48, padR = 24, padT = 30, plotH = 224;
    var plotW = w - padL - padR;
    var rotate = (plotW / sums.length) < 46;
    var padB = rotate ? 76 : 46;
    var h = padT + plotH + padB;
    var yOf = function (v) { return padT + plotH - (v / yMax) * plotH; };

    var s = ['<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="工程ごとの工数内訳">'];
    s.push(hatchDefs(sums.map(function (_, gi) { return gi; })));
    scale.ticks.forEach(function (t) {
      var y = yOf(t * 1000);
      s.push('<line x1="' + padL + '" y1="' + nn(y) + '" x2="' + nn(padL + plotW) + '" y2="' + nn(y) +
        '" stroke="var(--grid)" stroke-width="1" />');
      s.push(txt(padL - 8, y, tickLabel(t), { anchor: 'end', baseline: 'middle', tabular: true }));
    });
    s.push('<line x1="' + padL + '" y1="' + nn(padT + plotH) + '" x2="' + nn(padL + plotW) +
      '" y2="' + nn(padT + plotH) + '" stroke="var(--axis)" stroke-width="1" />');

    var band = plotW / sums.length;
    var barW = Math.min(64, Math.max(12, band * 0.5));
    sums.forEach(function (sm, gi) {
      var cx = padL + band * (gi + 0.5);
      var x = cx - barW / 2;
      var cum = 0;
      var segs = sm.withData.map(function (p) { return { p: p, v: pStats(p).mean }; });
      segs.forEach(function (seg, j) {
        var yTop = yOf(cum + seg.v);
        var yBot = yOf(cum);
        var isTop = j === segs.length - 1;
        var hh = yBot - yTop - (isTop ? 0 : 2);
        if (hh < 1) hh = 1;
        if (isTop) s.push('<path d="' + topRounded(x, yTop, barW, hh, 4) + '" fill="' + svgFill(gi) + '" />');
        else s.push('<rect x="' + nn(x) + '" y="' + nn(yTop + 2) + '" width="' + nn(barW) +
          '" height="' + nn(hh) + '" fill="' + svgFill(gi) + '" />');
        if (hh >= 16 && barW >= 44) {
          s.push(txt(cx, yTop + hh / 2 + 4, clipName(seg.p.name, Math.floor(barW / 12)),
            { anchor: 'middle', fill: '#fff', size: 11 }));
        }
        cum += seg.v;
      });
      if (sm.sum > 0) {
        s.push(txt(cx, yOf(sm.sum) - 8, sec(sm.sum),
          { anchor: 'middle', fill: 'var(--text-primary)', size: 12, weight: 600, tabular: true }));
      }
      if (rotate) {
        s.push(txt(cx, padT + plotH + 14, clipName(sm.group.name, 9),
          { anchor: 'end', fill: 'var(--text-primary)', size: 11, rotate: -45 }));
      } else {
        s.push(txt(cx, padT + plotH + 18, clipName(sm.group.name, Math.max(4, Math.floor(band / 13))),
          { anchor: 'middle', fill: 'var(--text-primary)', size: 12 }));
      }

      TIPS['g-' + gi] = '<strong>' + esc(sm.group.name) + '</strong>' +
        segs.map(function (seg) {
          return '<div class="tt-row"><span class="tt-key">' + esc(seg.p.name) + '</span><span class="tt-val">' +
            fmtTime(seg.v) + '</span></div>';
        }).join('') +
        '<div class="tt-row"><span class="tt-key">合計工数</span><span class="tt-val">' + fmtTime(sm.sum) + ' 秒</span></div>' +
        (tt ? '<div class="tt-row"><span class="tt-key">必要ST数</span><span class="tt-val">' +
          Math.ceil(sm.sum / tt) + ' / 実 ' + sm.count + '</span></div>' : '');
      s.push('<rect class="hit" x="' + nn(padL + band * gi) + '" y="' + padT + '" width="' + nn(band) +
        '" height="' + nn(plotH) + '" fill="transparent" data-tip="g-' + gi + '" />');
    });
    s.push('</svg>');
    host.innerHTML = s.join('');
    $('legend-groups').innerHTML = '<span class="legend__item">積み上げの1区切り＝1ステーションの平均</span>';
    $('fig-groups-sub').textContent = '縦軸：秒（工程内のステーション平均を合計＝その工程の工数）';
  }

  /* -------------------------------------------- ③ ステーション別の推移 */
  function renderTrendChart(full) {
    var host = $('chart-trend');
    var dropped = Math.max(0, full.length - SERIES_SLOTS);
    var list = full.slice(0, SERIES_SLOTS);   // 線は色で識別するため配色スロット数で打ち切る
    var lineColor = function (p) { return seriesVar(list.indexOf(p)); };
    var maxN = Math.max.apply(null, list.map(function (p) { return p.cycles.length; }).concat([0]));
    if (maxN < 2) {
      markEmpty('chart-trend'); $('legend-trend').innerHTML = ''; $('fig-trend-sub').textContent = '';
      return;
    }
    host.dataset.state = '';

    var tt = taktMs();
    var all = [];
    list.forEach(function (p) { p.cycles.forEach(function (c) { all.push(totalOf(c)); }); });
    var dataMax = Math.max.apply(null, all.concat(tt ? [tt] : []));
    var scale = niceScale(dataMax / 1000 * 1.05, 5);
    var yMax = scale.max * 1000;

    var w = chartWidth(host), h = 300;
    var padL = 48, padR = 62, padT = 16, padB = 38;
    var plotW = w - padL - padR, plotH = h - padT - padB;
    var yOf = function (v) { return padT + plotH - (v / yMax) * plotH; };
    var xOf = function (i) { return maxN < 2 ? padL + plotW / 2 : padL + (i / (maxN - 1)) * plotW; };

    var s = ['<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="ステーション別サイクルタイムの推移">'];
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

    // 同じ工程内は同色になるため、線の濃淡ではなく凡例＋ツールチップで識別する
    list.forEach(function (p) {
      if (!p.cycles.length) return;
      var pts = p.cycles.map(function (c, i) { return [xOf(i), yOf(totalOf(c))]; });
      s.push('<polyline fill="none" stroke="' + lineColor(p) + '" stroke-width="2" stroke-linejoin="round" ' +
        'stroke-linecap="round" points="' + pts.map(function (q) { return nn(q[0]) + ',' + nn(q[1]); }).join(' ') + '" />');
      var last = pts[pts.length - 1];
      s.push('<circle cx="' + nn(last[0]) + '" cy="' + nn(last[1]) + '" r="4.5" fill="' + lineColor(p) +
        '" stroke="var(--surface-1)" stroke-width="2" />');
      if (list.length <= 6) {
        s.push(txt(last[0] + 9, last[1], clipName(p.name, 7),
          { baseline: 'middle', fill: 'var(--text-secondary)', size: 11 }));
      }
    });

    var labelEvery = Math.ceil(maxN / Math.max(1, Math.floor(plotW / 34)));
    for (var i = 0; i < maxN; i++) {
      var x = xOf(i);
      if (i % labelEvery === 0 || i === maxN - 1) {
        s.push(txt(x, padT + plotH + 16, String(i + 1), { anchor: 'middle' }));
      }
      var rows = list.map(function (p) {
        var c = p.cycles[i];
        if (!c) return '';
        return '<div class="tt-row"><span class="tt-key"><span class="tt-dot" style="background:' +
          lineColor(p) + '"></span>' + esc(p.name) + '</span><span class="tt-val">' +
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

    $('legend-trend').innerHTML = list.map(function (p) {
      return '<span class="legend__item"><span class="legend__swatch" style="background:' + lineColor(p) +
        '"></span>' + esc(p.name) + '</span>';
    }).join('') + (tt
      ? '<span class="legend__item" style="color:var(--critical)"><span class="legend__swatch legend__swatch--dash"></span><span style="color:var(--text-secondary)">タクトタイム</span></span>' : '');
    $('fig-trend-sub').textContent = '縦軸：秒　横軸：サイクル No（最大 ' + maxN + ' サイクル）' +
      (dropped ? '　※線は先頭 ' + SERIES_SLOTS + ' ステーションのみ（残り ' + dropped +
        ' は明細表と各ステーション表示で確認できます）' : '');
  }

  /* -------------------------------------------- ④ サイクルタイムの推移（ステーション内） */
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

  /* -------------------------------------------- ⑤ サイクルタイムの分布 */
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

  /* -------------------------------------------- ⑥ 要素作業ごとの平均時間 */
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
    var lv = viewLevel();
    $('fig-balance').hidden = lv === 'station';
    $('fig-groups').hidden = lv !== 'line';
    $('fig-trend').hidden = lv !== 'group';
    $('fig-cycles').hidden = lv !== 'station';
    $('figure-grid').hidden = lv !== 'station';
    if (lv === 'station') {
      var p = viewStation();
      renderCycleChart(p);
      renderHistogram(p);
      renderElementChart(p);
      return;
    }
    renderBalanceChart(viewStations(), lv === 'line');
    if (lv === 'line') renderGroupStackChart();
    else renderTrendChart(viewStations());
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

  var STAT_HEAD = ['項目', '有効サイクル数', '平均(秒)', '中央値(秒)', '最小(秒)', '最大(秒)', 'レンジ(秒)', '標準偏差(秒)', 'CV(%)'];
  function statRow(label, values) {
    var s = stats(values);
    return csvRow([label, s.n, sec(s.mean), sec(s.median), sec(s.min), sec(s.max),
      sec(s.range), sec(s.sd), s.cv.toFixed(1)]);
  }

  /** 1ステーションの明細 CSV。 */
  function buildCsvStation(settings, p, groupName) {
    var els = p.elements;
    var multiEl = els.length > 1;
    var tt = (typeof settings.takt === 'number' && settings.takt > 0) ? settings.takt * 1000 : null;
    var lines = csvHeader(settings, (groupName ? groupName + ' / ' : '') + p.name);

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

  /** ライン全体 / 工程のCSV（マトリクス＋ステーション統計＋工程サマリ）。 */
  function buildCsvLine(settings, groupList, stationList, scope) {
    var tt = (typeof settings.takt === 'number' && settings.takt > 0) ? settings.takt * 1000 : null;
    var lines = csvHeader(settings, scope);
    var nameOf = {};
    groupList.forEach(function (g) { nameOf[g.id] = g.name; });
    var maxN = Math.max.apply(null, stationList.map(function (p) { return p.cycles.length; }).concat([0]));

    lines.push(csvRow(['工程'].concat(stationList.map(function (p) { return nameOf[p.groupId] || ''; }))));
    lines.push(csvRow(['No'].concat(stationList.map(function (p) { return p.name + '(秒)'; }))));
    for (var i = 0; i < maxN; i++) {
      lines.push(csvRow([i + 1].concat(stationList.map(function (p) {
        var c = p.cycles[i];
        return c ? (c.excluded ? '' : sec(totalOf(c))) : '';
      }))));
    }

    lines.push('');
    lines.push(csvRow(['工程', 'ステーション'].concat(STAT_HEAD.slice(1)).concat(tt ? ['タクト差(秒)'] : [])));
    var means = [];
    stationList.forEach(function (p) {
      var act = p.cycles.filter(function (c) { return !c.excluded; });
      var s = stats(act.map(totalOf));
      if (s.n) means.push(s.mean);
      var row = [nameOf[p.groupId] || '', p.name, s.n, sec(s.mean), sec(s.median), sec(s.min),
        sec(s.max), sec(s.range), sec(s.sd), s.cv.toFixed(1)];
      if (tt) row.push(sec(s.mean - tt));
      lines.push(csvRow(row));
    });

    lines.push('');
    lines.push(csvRow(['工程', 'ステーション数', '合計工数(秒)', 'ネックステーション', 'ネック平均(秒)']
      .concat(tt ? ['必要ST数'] : [])));
    groupList.forEach(function (g) {
      var list = stationList.filter(function (p) { return p.groupId === g.id; });
      var sum = 0, neckMean = 0, neckName = '';
      list.forEach(function (p) {
        var s = stats(p.cycles.filter(function (c) { return !c.excluded; }).map(totalOf));
        if (!s.n) return;
        sum += s.mean;
        if (s.mean > neckMean) { neckMean = s.mean; neckName = p.name; }
      });
      var row = [g.name, list.length, sec(sum), neckName || '—', neckMean ? sec(neckMean) : ''];
      if (tt) row.push(sum ? Math.ceil(sum / tt) : '');
      lines.push(csvRow(row));
    });

    if (means.length > 1) {
      var mx = Math.max.apply(null, means);
      var sm = means.reduce(function (a, b) { return a + b; }, 0);
      lines.push('');
      lines.push(csvRow(['ネックの平均(秒)', sec(mx)]));
      lines.push(csvRow(['工程平均の合計(秒)', sec(sm)]));
      lines.push(csvRow(['ラインバランス効率(%)', (sm / (means.length * mx) * 100).toFixed(1)]));
    }
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  function anchorDownload(filename, text, mime) {
    var blob = new Blob([text], { type: mime + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast('書き出しました');
  }

  /**
   * ファイルの書き出し。通常のブラウザではリンク経由、共有ページ（Artifact）では
   * ホストの保存 API を通す（そちらでは a[download] が無効なため）。
   */
  function download(filename, text, mime) {
    var host = (typeof window.claude !== 'undefined' && window.claude &&
      typeof window.claude.use === 'function') ? window.claude : null;
    if (!host) { anchorDownload(filename, text, mime); return; }

    host.use('downloads').then(function (dl) {
      if (!dl) { anchorDownload(filename, text, mime); return; }
      return dl.save({ filename: filename, data: text })
        .then(function () { toast('保存しました'); })
        .catch(function (e) {
          var code = e && e.code;
          if (code === 'declined') return;
          if (code === 'extension_not_enabled' && /\.csv$/.test(filename)) {
            return dl.save({ filename: filename.replace(/\.csv$/, '.txt'), data: text })
              .then(function () { toast('CSVを .txt で保存しました（拡張子を .csv に変えるとExcelで開けます）'); })
              .catch(function () { toast('保存できませんでした'); });
          }
          toast('保存できませんでした（' + (code || 'error') + '）');
        });
    }, function () { anchorDownload(filename, text, mime); });
  }

  function safeName(s) { return String(s || '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40); }
  function stamp() {
    var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes());
  }
  function fileBase(settings, suffix) {
    return 'CT_' + (safeName(settings.title) || 'measure') + (suffix ? '_' + safeName(suffix) : '') + '_' + stamp();
  }

  /** 現在の表示スコープに合わせて CSV を書き出す。 */
  function exportCsvScoped(settings, groupList, stationList, scopeName, single) {
    if (!stationList.some(function (p) { return p.cycles.length; })) { toast('計測データがありません'); return; }
    if (single) {
      var g = groupList.filter(function (x) { return x.id === single.groupId; })[0];
      download(fileBase(settings, single.name) + '.csv',
        buildCsvStation(settings, single, g ? g.name : ''), 'text/csv');
    } else {
      download(fileBase(settings, scopeName) + '.csv',
        buildCsvLine(settings, groupList, stationList, scopeName), 'text/csv');
    }
  }

  function exportJson() {
    var payload = { app: 'ct-checker', exportedAt: nowIso() };
    var snap = snapshot();
    for (var k in snap) payload[k] = snap[k];
    download(fileBase(state.settings) + '.json', JSON.stringify(payload, null, 2), 'application/json');
  }

  /**
   * アプリに内蔵する構成。presets/ が読めない環境でも必ず選べるように、
   * データそのものをコードに持たせる。
   */
  var BUILTIN_PRESETS = [{
    id: 'assy-line',
    name: 'Assy1〜Assy9 / Station1〜11',
    note: '工程9・ステーション11（計測データなし）',
    build: function () {
      var spec = [
        ['Assy1', []],
        ['Assy2', ['Station1', 'Station2']],
        ['Assy3', ['Station3', 'Station4']],
        ['Assy4', ['Station5']],
        ['Assy5', ['Station6']],
        ['Assy6', ['Station7', 'Station8']],
        ['Assy7', ['Station9']],
        ['Assy8', ['Station10']],
        ['Assy9', ['Station11']]
      ];
      var groups = [], stations = [];
      spec.forEach(function (row) {
        var g = { id: uid(), name: row[0] };
        groups.push(g);
        row[1].forEach(function (name) { stations.push(newStation(name, g.id)); });
      });
      return {
        schema: SCHEMA, version: 3,
        settings: { title: '', operator: '', memo: '', takt: null },
        groups: groups, stations: stations,
        started: false, startedAt: null, view: 'all', focus: 'all', tab: 'measure', density: null
      };
    }
  }];

  /** 構成を実際に入れる（内蔵・ファイルの両方から呼ぶ）。 */
  function applyPresetData(d) {
    if (!d || !d.settings) { toast('構成を読み込めませんでした'); return; }
    var msg = '構成を読み込みます（工程 ' + (d.groups ? d.groups.length : 1) +
      '・ステーション ' + countUnits(d) + '）。よろしいですか？';
    if (hasData()) msg += '\n※いまの計測データは自動バックアップしてから入れ替えます。';
    if (!confirm(msg)) return;
    autoArchive('構成の読込前');
    state = normalize(d);
    RUN = {};
    syncSettingsInputs();
    render();
    save();
    announce('構成を読み込みました（工程 ' + groups().length + '・ステーション ' + stations().length + '）。');
    toast('構成を読み込みました');
  }

  function presetItemHtml(x) {
    return '<div class="preset">' +
      '<div class="preset__body"><span class="preset__name">' + esc(x.name) + '</span>' +
      (x.note ? '<span class="preset__note">' + esc(x.note) + '</span>' : '') + '</div>' +
      '<button type="button" class="btn btn--primary" data-act="use-preset"' +
        (x.id ? ' data-builtin="' + esc(x.id) + '"' : ' data-file="' + esc(x.file) + '"') +
        '>読み込む</button></div>';
  }

  /** 用意された構成の一覧を出す（内蔵＋presets/index.json）。 */
  function renderPresets() {
    var block = $('preset-block');
    if (!block) return;
    block.hidden = false;
    $('preset-list').innerHTML = BUILTIN_PRESETS.map(presetItemHtml).join('');
    // 追加の構成ファイルがあれば後ろに足す（無くても内蔵分は出る）
    fetch('presets/index.json', { cache: 'no-cache' }).then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (d) {
      var list = (d && Array.isArray(d.presets) ? d.presets : []).filter(function (x) {
        return x && x.file && x.file !== 'assy-line.json';
      });
      if (!list.length) return;
      $('preset-list').innerHTML += list.map(presetItemHtml).join('');
    }).catch(function () { /* 通信できなくても内蔵分は使える */ });
  }

  /** 構成ファイルを取り込む。取り込み前に必ずバックアップを取る。 */
  function applyPreset(url, quiet) {
    fetch(url, { cache: 'no-cache' }).then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (d) {
      applyPresetData(d);
      if (quiet) { try { history.replaceState(null, '', location.pathname); } catch (e) { /* noop */ } }
    }).catch(function () { toast('構成ファイルを読み込めませんでした（通信を確認してください）'); });
  }

  function usePreset(b) {
    var id = b.getAttribute('data-builtin');
    if (id) {
      var pre = BUILTIN_PRESETS.filter(function (x) { return x.id === id; })[0];
      if (pre) applyPresetData(pre.build());
      return;
    }
    applyPreset('presets/' + b.getAttribute('data-file'), false);
  }

  /**
   * ?preset=... で同じサイト内の構成ファイルを読み込む。
   * 現場に「このリンクを開くだけ」で構成を配れるようにするため。
   */
  function loadPresetFromQuery() {
    var m = /[?&]preset=([^&]+)/.exec(location.search);
    if (!m) return;
    var url;
    try { url = new URL(decodeURIComponent(m[1]), location.href); } catch (e) { return; }
    if (url.origin !== location.origin) { toast('同じサイト内のファイルだけ読み込めます'); return; }
    applyPreset(url.href, true);
  }

  function importJson(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var d;
      try { d = JSON.parse(reader.result); } catch (e) { toast('JSONを読み込めませんでした'); return; }
      if (!d || !d.settings) { toast('CT Checker の JSON ではありません'); return; }
      if (hasData() && !confirm('現在の計測データを置き換えて読み込みます。よろしいですか？\n（置き換える前に自動でバックアップを取ります）')) return;
      autoArchive('JSON取り込み前');
      state = normalize(d);
      RUN = {};
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
    if (hasData() && !confirm('現在の計測データを置き換えて「' + s.name + '」を読み込みます。よろしいですか？\n（置き換える前に自動でバックアップを取ります）')) return;
    autoArchive('読込前');
    state = normalize(s.data || s);
    RUN = {};
    syncSettingsInputs();
    render();
    save();
    announce('「' + s.name + '」を読み込みました。続きから計測もできます。');
    toast('読み込みました');
  }

  /* ------------------------------------------------------------------ イベント */
  function stationFromEvent(b) { return stationById(b.getAttribute('data-id')); }

  function bind() {
    $('btn-lap').addEventListener('click', function () { tap(stations()[0]); });
    $('btn-pause').addEventListener('click', toggleAll);
    $('btn-save-cycle').addEventListener('click', function () { saveCycle(stations()[0]); });
    $('btn-clear').addEventListener('click', function () { clearCurrent(stations()[0]); });
    $('btn-undo').addEventListener('click', function () { undo(stations()[0]); });
    $('btn-undo-cycle').addEventListener('click', function () { undo(viewStation()); });
    $('btn-reset').addEventListener('click', resetAll);

    $('pcards').addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.getAttribute('data-act') === 'go-settings') { setTab('settings'); return; }
      var p = stationFromEvent(b);
      if (!p) return;
      var act = b.getAttribute('data-act');
      if (act === 'go-settings') { setTab('settings'); return; }
      if (act === 'tap') tap(p);
      else if (act === 'save') saveCycle(p);
      else if (act === 'clear') clearCurrent(p);
      else if (act === 'undo') undo(p);
    });

    $('tabs').addEventListener('click', function (e) {
      var b = e.target.closest('[data-tab]');
      if (b) setTab(b.getAttribute('data-tab'));
    });

    $('density').addEventListener('click', function (e) {
      var b = e.target.closest('[data-density]');
      if (!b) return;
      state.density = b.getAttribute('data-density');
      renderMeasure();
      saveSoon();
    });

    $('focus-chips').addEventListener('click', function (e) {
      var b = e.target.closest('[data-focus]');
      if (!b) return;
      state.focus = b.getAttribute('data-focus');
      renderMeasure();
      saveSoon();
    });

    document.addEventListener('keydown', function (e) {
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var first = multi() ? focusStations()[0] : stations()[0];
      if (e.code === 'Space' || e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        tap(first);
      } else if (e.key >= '1' && e.key <= '9') {
        var p = focusStations()[+e.key - 1];
        if (p) { e.preventDefault(); tap(p); }
      } else if (e.key === 's' || e.key === 'S') { e.preventDefault(); saveCycle(first); }
      else if (e.key === 'p' || e.key === 'P') { e.preventDefault(); toggleAll(); }
      else if (e.key === 'z' || e.key === 'Z') { e.preventDefault(); undo(first); }
    });

    // 表示切替
    function onViewClick(e) {
      var b = e.target.closest('[data-view]');
      if (!b) return;
      state.view = b.getAttribute('data-view');
      renderViewSwitch(); renderTiles(); renderTables(); renderCharts();
      saveSoon();
    }
    $('view-groups').addEventListener('click', onViewClick);
    $('view-stations').addEventListener('click', onViewClick);

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

    $('btn-add-station').addEventListener('click', addStation);
    $('in-station').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); addStation(); }
    });
    $('btn-add-proc').addEventListener('click', addGroup);
    $('in-proc').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); addGroup(); }
    });

    $('proc-list').addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      var act = b.getAttribute('data-act');
      var id = b.getAttribute('data-id');
      if (act === 'del-group') {
        if (groups().length <= 1) { toast('工程は1つ以上必要です'); return; }
        var g = groupById(id);
        var rest = stations().filter(function (p) { return p.groupId !== id; });
        if (!rest.length) { toast('ステーションが無くなるため削除できません'); return; }
        if (stationsOf(g).length && !confirm('「' + g.name + '」と、その中の ' + stationsOf(g).length +
          ' ステーションを削除します。よろしいですか？')) return;
        state.stations = rest;
        state.groups = groups().filter(function (x) { return x.id !== id; });
        if (state.focus === id) state.focus = 'all';
        state.view = validView(state, state.view);
        afterStructureChange();
      } else if (act === 'del-station') {
        if (stations().length <= 1) { toast('ステーションは1つ以上必要です'); return; }
        state.stations = stations().filter(function (p) { return p.id !== id; });
        state.view = validView(state, state.view);
        afterStructureChange();
      } else if (act === 'del-element') {
        var p = stationById(id);
        if (!p) return;
        if (p.elements.length <= 1) { toast('要素作業は1つ以上必要です'); return; }
        p.elements.splice(+b.getAttribute('data-i'), 1);
        afterStructureChange();
      } else if (act === 'add-element') {
        addElement(id);
      }
    });

    $('proc-list').addEventListener('input', function (e) {
      var inp = e.target.closest('[data-act]');
      if (!inp) return;
      var act = inp.getAttribute('data-act');
      var id = inp.getAttribute('data-id');
      if (act === 'rename-group') {
        groupById(id).name = inp.value;
        renderMeasure(); renderViewSwitch(); renderTables(); renderCharts();
        saveSoon();
      } else if (act === 'rename-station') {
        var p = stationById(id);
        if (p) p.name = inp.value;
        renderMeasure(); renderViewSwitch(); renderTables(); renderCharts();
        saveSoon();
      } else if (act === 'rename-element') {
        var st = stationById(id);
        if (st) st.elements[+inp.getAttribute('data-i')].name = inp.value;
        renderMeasure(); renderTables(); renderCharts();
        saveSoon();
      }
    });

    $('proc-list').addEventListener('toggle', function (e) {
      var d = e.target.closest ? e.target.closest('[data-station]') : null;
      if (!d) return;
      if (d.open) EL_OPEN[d.getAttribute('data-station')] = true;
      else delete EL_OPEN[d.getAttribute('data-station')];
    }, true);

    $('proc-list').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var el = e.target.closest('[data-act="new-element"]');
      if (!el) return;
      e.preventDefault();
      addElement(el.getAttribute('data-id'));
    });

    // 明細（除外・メモ）
    $('table-cycles').addEventListener('change', function (e) {
      var box = e.target.closest('[data-act="exclude"]');
      if (!box) return;
      viewStation().cycles[+box.getAttribute('data-i')].excluded = box.checked;
      render(); save();
    });
    $('table-cycles').addEventListener('input', function (e) {
      var inp = e.target.closest('[data-act="note"]');
      if (!inp) return;
      viewStation().cycles[+inp.getAttribute('data-i')].note = inp.value;
      saveSoon();
    });

    $('btn-outlier').addEventListener('click', function () {
      var p = viewStation();
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
      viewStation().cycles.forEach(function (c) { c.excluded = false; });
      render(); save();
      toast('除外を解除しました');
    });

    // 書き出し / 読込
    $('btn-csv').addEventListener('click', function () {
      var lv = viewLevel();
      if (lv === 'station') exportCsvScoped(state.settings, groups(), [viewStation()], null, viewStation());
      else if (lv === 'group') exportCsvScoped(state.settings, [viewGroup()], viewStations(), viewGroup().name);
      else exportCsvScoped(state.settings, groups(), stations(), 'ライン全体');
    });
    $('btn-json').addEventListener('click', exportJson);
    $('file-json').addEventListener('change', function () {
      if (this.files && this.files[0]) importJson(this.files[0]);
      this.value = '';
    });

    // 保存測定
    $('preset-list').addEventListener('click', function (e) {
      var b = e.target.closest('[data-act="use-preset"]');
      if (b) usePreset(b);
    });
    $('setup-note').addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.getAttribute('data-act') === 'use-preset') usePreset(b);
      else if (b.getAttribute('data-act') === 'go-settings') setTab('settings');
    });

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
        exportCsvScoped(st.settings, st.groups, st.stations, 'ライン全体',
          st.stations.length === 1 ? st.stations[0] : null);
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

  function afterStructureChange() {
    sortStations();
    render();
    save();
  }

  function addGroup() {
    var input = $('in-proc');
    var name = input.value.trim();
    if (groups().length >= MAX_GROUPS) { toast('工程は最大 ' + MAX_GROUPS + ' 個までです'); return; }
    if (stations().length >= MAX_STATIONS) { toast('ステーションは最大 ' + MAX_STATIONS + ' 個までです'); return; }
    var g = { id: uid(), name: name || ('工程' + (groups().length + 1)) };
    groups().push(g);
    state.stations.push(newStation(g.name + ' ST1', g.id));
    toast('「' + g.name + '」を追加しました');
    input.value = '';
    input.focus();
    afterStructureChange();
  }

  /** 上部の入力欄からステーションを足す。工程が1つならそこへ、複数なら選んだ工程へ。 */
  function addStation() {
    if (stations().length >= MAX_STATIONS) { toast('ステーションは最大 ' + MAX_STATIONS + ' 個までです'); return; }
    var input = $('in-station');
    var sel = $('in-station-group');
    var gid = (!sel.hidden && sel.value) ? sel.value : groups()[groups().length - 1].id;
    var g = groupById(gid);
    var name = input.value.trim();
    state.stations.push(newStation(name || ('ST' + (stationsOf(g).length + 1)), gid));
    input.value = '';
    afterStructureChange();
    $('in-station').focus();
  }

  function addElement(stationId) {
    var p = stationById(stationId);
    if (!p) return;
    var input = document.querySelector('[data-act="new-element"][data-id="' + stationId + '"]');
    var name = input ? input.value.trim() : '';
    if (!name) { if (input) input.focus(); return; }
    if (p.elements.length >= MAX_ELEMENTS) { toast('要素作業は最大 ' + MAX_ELEMENTS + ' 個までです'); return; }
    // 初期値の「1サイクル」だけなら置き換える
    if (p.elements.length === 1 && p.elements[0].name === '1サイクル') p.elements[0] = { id: uid(), name: name };
    else p.elements.push({ id: uid(), name: name });
    EL_OPEN[p.id] = true;
    afterStructureChange();
    var again = document.querySelector('[data-act="new-element"][data-id="' + stationId + '"]');
    if (again) again.focus();
  }

  /* -------------------------------------------------------------------- 起動 */
  function tick() {
    // 実時間で間引く。ステーションごとに時計が止まるため、経過値では判定できない
    if (anyRunning()) {
      var now = performance.now();
      if (now - lastTickAt >= 50) { lastTickAt = now; renderReadout(); }
    }
    requestAnimationFrame(tick);
  }

  function initTheme() {
    var t;
    try { t = localStorage.getItem(THEME_KEY); } catch (e) { t = null; }
    if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);
  }

  /** localStorage が使えるか（共有ページやプライベートモードでは使えないことがある） */
  function storageOk() {
    try {
      localStorage.setItem('ct-checker:probe', '1');
      localStorage.removeItem('ct-checker:probe');
      return true;
    } catch (e) { return false; }
  }

  /** GitHub Pages などに置いたときはオフラインでも開けるようにする。 */
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
    if (typeof window.claude !== 'undefined') return;   // 共有ページでは登録しない
    try {
      navigator.serviceWorker.register('sw.js').catch(function () { /* 失敗しても通常動作 */ });
    } catch (e) { /* noop */ }
  }

  /** どの版が動いているかを設定タブに出す（更新が届いたかの確認用）。 */
  function renderBuildId() {
    var m = document.querySelector('meta[name="build"]');
    var el = $('build-id');
    if (el) el.textContent = (m && m.content) || 'dev';
  }

  function init() {
    initTheme();
    load();
    syncSettingsInputs();
    bind();
    render();
    renderSessions();
    renderPresets();
    renderBuildId();
    requestPersist();
    updateStorageHint();
    if (!storageOk()) {
      document.querySelector('.app-foot p').textContent =
        'この環境ではブラウザへの自動保存が使えません。計測結果はページを閉じると消えるため、' +
        '必要なら CSV / JSON で書き出してください。';
    }
    if (anyStarted()) announce('前回のデータを復元しました（停止中）。「再開」で続きから計測できます。');
    setInterval(function () { if (anyRunning()) save(); }, 5000);
    requestAnimationFrame(tick);
    registerServiceWorker();
    loadPresetFromQuery();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
