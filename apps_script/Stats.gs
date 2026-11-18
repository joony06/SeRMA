// ============================================================
//  버전 기록 (최신이 위)
//  v8.5  2026-10-22  메뉴 함수 이름 menuImportSemester1 → menuImportOldSemester
//  v8.4  2026-10-22  차트 첫 행을 머리글로 지정(가로축에 '월'이 끼고 범례가 비던 문제), 월차 기준을 학기 시작 달 보정
//                    (16일 이후 시작이면 다음 달이 1개월차)
//  v8.3  2026-10-22  차트 겹침 수정: 위 차트 아래로 자동 배치, 직접 옮긴 차트 위치는 새로고침해도 유지
//  v8.2  2026-10-22  예약 기록 탭 이름을 CONFIG.SHEETS.RESV에서 읽음 (RESV_SHEET 없음 오류 수정)
//  v8.1  2026-10-22  1칸짜리 안내 표에서 멈추던 버그 수정 (예약 기록 없는 학기), 위반 기록 가져오기를
//                    시트 링크 입력 방식으로 변경 + 날짜가 학기 기간과 안 맞으면 중단, 가져온 기록 되돌리기 추가
//  v8.0  2026-10-22  통계 탭 신규 (스크립트 계산): 학기 선택, 요약, 학기 비교, 월별 추이(신규·재위반),
//                    학기별 월차 비교, 호실·요일·시간대별 이용률·미체크아웃률, 리드타임, 삭제 사유별(오탐률),
//                    문자 발송 현황, 반복 위반자, 주별 위반 추이, 차트 3개. 이전 학기 위반 기록 가져오기
// ============================================================

// ============================================================
//  Stats.gs - 통계 탭 (값만 쓰고 수식 없음 → 시트가 가벼움)
//
//  갱신: 매일 00:05 자동 입력 뒤 / 통계 탭 D1 학기를 바꿀 때 / 메뉴 > 통계 새로고침
//  이용률·미체크아웃률·리드타임은 '예약 기록' 수집 시작일 이후만 계산 (사이트가 지난 예약을 지우므로)
//  이용 가능 시간: 9~22시(13시간) × 8개 호실, 월~토, 설정 탭 공휴일 제외
// ============================================================

var STATS = {
  OPEN_HOURS: 13,          // 9~22시
  SEM_CELL: 'D1',
  TOP_N: 15,
  BAD: ['실패', '멈춤', '확인 불가'],
  GONE: ['기한 지남', '번호 없음'],
  REASONS: [
    ['RESTRICT', '제한 기간 중 예약'], ['PERM', '영구 제한자 예약'], ['HOLIDAY', '공휴일 예약'],
    ['DUP_RESV', '중복 예약'], ['PEOPLE', '인원 미달'], ['STUDENT_ID', '학번 오류'],
    ['DUP_ID', '학번 중복'], ['NAME', '이름 오류'], ['PHONE', '전화번호 오류']
  ],
  BANDS: [[9, 12, '9~12시'], [12, 15, '12~15시'], [15, 18, '15~18시'], [18, 22, '18~22시']],
  LEAD: [[0, 0, '당일'], [1, 1, '1일 전'], [2, 3, '2~3일 전'], [4, 7, '4~7일 전'], [8, 9999, '8일 이상 전']]
};

// ------------------------------------------------------------
//  탭 만들기 (upgradeToV8에서 1회)
// ------------------------------------------------------------
function rebuildStatsSheet_(ss) {
  var old = ss.getSheetByName(CONFIG.SHEETS.STATS);
  var idx = old ? old.getIndex() : 4;
  if (old) ss.deleteSheet(old);
  var sh = ss.insertSheet(CONFIG.SHEETS.STATS, Math.max(0, idx - 1));
  return sh;
}

function statsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(CONFIG.SHEETS.STATS) || rebuildStatsSheet_(ss);
}

// ------------------------------------------------------------
//  데이터 읽기
// ------------------------------------------------------------
function readRows_(name, width) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, width).getValues();
}

function asDate_(v) { return v instanceof Date && !isNaN(v) ? dateOnly_(v) : null; }
function personKey_(r) { var p = String(r[6] || '').replace(/\D/g, ''); return p || String(r[5] || '').trim(); }
function inRange_(d, a, b) { return d && (!a || d >= a) && (!b || d <= b); }
function pct_(a, b) { return b ? a / b : ''; }
function dayKey_(d) { return Utilities.formatDate(d, 'Asia/Seoul', 'yyyy-MM-dd'); }

function loadStatsData_() {
  var vio = readRows_(CONFIG.SHEETS.VIO, 16).concat(readRows_(CONFIG.SHEETS.ARCHIVE, 16))
    .filter(function (r) { return String(r[5]).trim() && asDate_(r[2]); });
  var del = readRows_(CONFIG.SHEETS.DEL, 15).filter(function (r) { return String(r[3]).trim() && asDate_(r[0]); });
  var resv = readRows_((CONFIG.SHEETS && CONFIG.SHEETS.RESV) || '예약 기록', 12).filter(function (r) { return r[0] && asDate_(r[1]); });

  var removed = {};   // 우리가 삭제했거나 삭제할 예약 → 이용률 계산에서 제외
  del.forEach(function (r) { if (r[10] && (r[7] === '완료' || r[7] === '대기')) removed[r[10]] = true; });
  resv = resv.filter(function (r) { return !removed[r[0]]; });

  var collectStart = null;
  resv.forEach(function (r) { var c = asDate_(r[11]); if (c && (!collectStart || c < collectStart)) collectStart = c; });

  var holidays = {};
  try { named_('HOLIDAYS').getValues().forEach(function (r) { if (r[0] instanceof Date) holidays[dayKey_(dateOnly_(r[0]))] = true; }); } catch (e) {}

  return { vio: vio, del: del, resv: resv, collectStart: collectStart, holidays: holidays,
           rooms: Object.keys(CONFIG.ROOM_MAP).map(function (k) { return CONFIG.ROOM_MAP[k]; }) };
}

// 학기 → 위반 집계 기간 [start, 다음 학기 시작 전날] (방학은 직전 학기)
function semesterRange_(name, list) {
  for (var i = 0; i < list.length; i++) {
    if (list[i].name !== name) continue;
    var end = null;
    if (list[i + 1]) { end = new Date(list[i + 1].start); end.setDate(end.getDate() - 1); }
    return { name: name, start: list[i].start, end: end, classEnd: list[i].end };
  }
  return { name: name, start: null, end: null, classEnd: null };
}

function openDays_(a, b, holidays) {
  var n = 0, d = new Date(a);
  while (d <= b) {
    if (d.getDay() !== 0 && !holidays[dayKey_(d)]) n++;
    d.setDate(d.getDate() + 1);
  }
  return n;
}

function startHour_(timeStr) {
  var m = String(timeStr || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) + Number(m[2]) / 60 : null;
}

// ------------------------------------------------------------
//  학기 하나 계산
// ------------------------------------------------------------
function computeSemester_(D, sem) {
  var today = dateOnly_(new Date()), yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  var v = D.vio.filter(function (r) { return String(r[0]).trim() === sem.name; });
  var out = { name: sem.name, sem: sem, vio: v };

  // 위반 요약
  var persons = {}, stage = { '제한1': 0, '제한2': 0, '제한3': 0 };
  v.forEach(function (r) {
    var k = personKey_(r); persons[k] = (persons[k] || 0) + 1;
    if (stage.hasOwnProperty(r[9])) stage[r[9]]++;
  });
  var pk = Object.keys(persons);
  out.total = v.length;
  out.persons = pk.length;
  out.repeaters = pk.filter(function (k) { return persons[k] >= 2; }).length;
  out.stage = stage;
  out.newCount = v.filter(function (r) { return Number(r[8]) === 1; }).length;

  // 이용률 등: 수집 시작 이후, 어제까지, 학기 집계 기간 안
  var a = sem.start, b = sem.end && sem.end < yesterday ? sem.end : yesterday;
  if (D.collectStart && (!a || D.collectStart > a)) a = D.collectStart;
  out.useFrom = D.collectStart ? a : null; out.useTo = b;
  out.usable = !!(D.collectStart && a && b && a <= b);
  if (out.usable) {
    var rs = D.resv.filter(function (r) { return inRange_(asDate_(r[1]), a, b); });
    var vs = v.filter(function (r) { return inRange_(asDate_(r[2]), a, b); });
    var days = openDays_(a, b, D.holidays);
    out.days = days;
    out.resvCount = rs.length;
    out.hours = rs.reduce(function (s, r) { return s + (Number(r[6]) || 0); }, 0);
    out.util = pct_(out.hours, days * STATS.OPEN_HOURS * D.rooms.length);
    out.noCheckout = vs.length;
    out.noRate = pct_(vs.length, rs.length);
    out.rs = rs; out.vs = vs;
    var leads = rs.map(function (r) { return Number(r[9]); }).filter(function (x) { return !isNaN(x) && x >= 0; }).sort(function (x, y) { return x - y; });
    out.leads = leads;
    out.leadAvg = leads.length ? leads.reduce(function (s, x) { return s + x; }, 0) / leads.length : '';
    out.leadMed = leads.length ? leads[Math.floor((leads.length - 1) / 2)] : '';
  }

  // 삭제 처리 (예약일이 학기 집계 기간 안)
  out.del = sem.start ? D.del.filter(function (r) { return inRange_(asDate_(r[0]), sem.start, sem.end); }) : [];

  // 개월 수 (월평균용)
  var mEnd = sem.end && sem.end < today ? sem.end : today;
  out.months = sem.start ? Math.max(1, (mEnd - sem.start) / 86400000 / 30.4) : '';
  return out;
}

// ------------------------------------------------------------
//  통계 새로고침
// ------------------------------------------------------------
function refreshStats() {
  var start = new Date();
  var sh = statsSheet_();
  var list = semesters_();
  var setting = String(named_('CFG_SEMESTER').getValue()).trim();
  var chosen = String(sh.getRange(STATS.SEM_CELL).getValue() || '').trim() || setting;
  var D = loadStatsData_();

  // 비교 대상: 학기 표에 있고 데이터가 있는 학기 + 선택 학기
  var names = list.map(function (s) { return s.name; });
  D.vio.forEach(function (r) { var n = String(r[0]).trim(); if (n && names.indexOf(n) < 0) names.push(n); });
  var all = names.map(function (n) { return computeSemester_(D, semesterRange_(n, list)); })
    .filter(function (c) { return c.total > 0 || c.name === chosen; });
  var S = all.filter(function (c) { return c.name === chosen; })[0] || computeSemester_(D, semesterRange_(chosen, list));

  // ── 탭 초기화 ──
  // 직접 옮긴 차트 위치 기억 (제목 기준) → 다시 그릴 때 그 자리에
  var savedPos = {};
  sh.getCharts().forEach(function (c) {
    try {
      var t = c.getOptions().get('title'), ci = c.getContainerInfo();
      if (t) savedPos[t] = [ci.getAnchorRow(), ci.getAnchorColumn(), ci.getOffsetX(), ci.getOffsetY()];
    } catch (e) {}
    sh.removeChart(c);
  });
  function mk_(b, top, h, title) { return { b: b, top: top, h: h, title: title }; }
  sh.clear(); sh.clearConditionalFormatRules();
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).clearDataValidations();
  if (sh.getMaxColumns() < 16) sh.insertColumnsAfter(sh.getMaxColumns(), 16 - sh.getMaxColumns());
  [160, 95, 95, 95, 95, 95, 95, 20].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  sh.setHiddenGridlines(true);

  sh.getRange('A1').setValue('통계').setFontSize(18).setFontWeight('bold');
  sh.getRange('C1').setValue('학기').setHorizontalAlignment('right').setFontColor('#6b7280');
  sh.getRange(STATS.SEM_CELL).setValue(chosen).setFontWeight('bold').setBackground('#fff7d6')
    .setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(names.length ? names : [chosen], true).build());
  sh.getRange('E1').setValue('계산: ' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'M/d HH:mm')).setFontColor('#6b7280');
  sh.getRange('A2').setValue('학기를 바꾸면 자동으로 다시 계산돼요 · 메뉴 > SeRMA 관리 > 통계 새로고침 · 매일 00:05 자동 갱신')
    .setFontColor('#6b7280').setFontSize(9);

  var row = 4, charts = [];
  function table(title, note, heads, rows, fmts) {
    sh.getRange(row, 1).setValue(title).setFontWeight('bold').setFontSize(12);
    if (note) sh.getRange(row, 3).setValue(note).setFontColor('#6b7280').setFontSize(9);
    var top = row + 1;
    sh.getRange(top, 1, 1, heads.length).setValues([heads])
      .setBackground(STYLE.HEAD_BG).setFontColor(STYLE.HEAD_FG).setFontWeight('bold');
    var body = rows.length ? rows : [['데이터 없음'].concat(new Array(heads.length - 1).fill(''))];
    ensureRows_(sh, top + body.length + 2);
    if (sh.getMaxColumns() < heads.length) sh.insertColumnsAfter(sh.getMaxColumns(), heads.length - sh.getMaxColumns());
    sh.getRange(top + 1, 1, body.length, heads.length).setValues(body)
      .setBorder(true, true, true, true, true, true, DASH.BORDER, SpreadsheetApp.BorderStyle.SOLID);
    (fmts || []).forEach(function (f, i) { if (f) sh.getRange(top + 1, i + 1, body.length, 1).setNumberFormat(f); });
    if (heads.length > 1) sh.getRange(top, 2, body.length + 1, heads.length - 1).setHorizontalAlignment('center');
    row = top + body.length + 2;
    return { top: top, n: rows.length, w: heads.length };
  }
  var P = '0.0%', N = '#,##0', N1 = '0.0', MD = 'm/d';
  var md = function (d) { return d ? Utilities.formatDate(d, 'Asia/Seoul', 'M/d') : '-'; };

  // 1. 요약
  var t1 = table(S.name + ' 요약', '위반 집계: ' + md(S.sem.start) + ' ~ ' + (S.sem.end ? md(S.sem.end) : '현재') + ' (방학 포함)',
    ['항목', '값'], [
      ['위반', S.total], ['위반자 (명)', S.persons], ['재위반자 비율 (2회 이상)', pct_(S.repeaters, S.persons)],
      ['신규 위반 비율 (1회째 위반)', pct_(S.newCount, S.total)],
      ['제재: 제한1 / 제한2 / 영구', S.stage['제한1'] + ' / ' + S.stage['제한2'] + ' / ' + S.stage['제한3']],
      ['삭제 처리 (감지 건)', S.del.length],
      ['예약 (수집분)', S.usable ? S.resvCount : '수집 전'],
      ['이용률', S.usable ? S.util : '-'], ['미체크아웃률', S.usable ? S.noRate : '-'],
      ['리드타임 평균 / 중앙값 (일)', S.usable && S.leads.length ? (Math.round(S.leadAvg * 10) / 10) + ' / ' + S.leadMed : '-'],
      ['이용률 집계 기간', S.usable ? md(S.useFrom) + ' ~ ' + md(S.useTo) + ' (' + S.days + '일)' : '예약 기록 수집 이후 계산']
    ]);
  [2, 3, 7, 8].forEach(function (i) { sh.getRange(t1.top + 1 + i, 2).setNumberFormat(P); });
  sh.getRange(t1.top + 1, 2, 11, 1).setHorizontalAlignment('right');

  // 2. 학기 비교
  var cmpHeads = ['항목'].concat(all.map(function (c) { return c.name; }));
  var cmpRows = [
    ['위반'].concat(all.map(function (c) { return c.total; })),
    ['위반자 (명)'].concat(all.map(function (c) { return c.persons; })),
    ['재위반자 비율'].concat(all.map(function (c) { return pct_(c.repeaters, c.persons); })),
    ['월평균 위반'].concat(all.map(function (c) { return c.months ? Math.round(c.total / c.months * 10) / 10 : ''; })),
    ['제한1'].concat(all.map(function (c) { return c.stage['제한1']; })),
    ['제한2'].concat(all.map(function (c) { return c.stage['제한2']; })),
    ['영구 제한'].concat(all.map(function (c) { return c.stage['제한3']; })),
    ['삭제 처리'].concat(all.map(function (c) { return c.del.length; })),
    ['이용률'].concat(all.map(function (c) { return c.usable ? c.util : '-'; })),
    ['미체크아웃률'].concat(all.map(function (c) { return c.usable ? c.noRate : '-'; }))
  ];
  var t2 = table('학기 비교', '이용률·미체크아웃률은 예약 기록이 있는 학기만', cmpHeads, cmpRows);
  [2, 8, 9].forEach(function (i) { sh.getRange(t2.top + 1 + i, 2, 1, all.length).setNumberFormat(P); });

  // 3. 월별 추이 (선택 학기)
  var months = {}, monthOrder = [];
  S.vio.forEach(function (r) {
    var d = asDate_(r[2]); var k = Utilities.formatDate(d, 'Asia/Seoul', 'yyyy-MM');
    if (!months[k]) { months[k] = { v: 0, n: 0, r: 0, resv: 0, vu: 0 }; monthOrder.push(k); }
    months[k].v++; if (Number(r[8]) === 1) months[k].n++; else months[k].r++;
  });
  if (S.usable) {
    S.rs.forEach(function (r) { var k = Utilities.formatDate(asDate_(r[1]), 'Asia/Seoul', 'yyyy-MM'); if (!months[k]) { months[k] = { v: 0, n: 0, r: 0, resv: 0, vu: 0 }; monthOrder.push(k); } months[k].resv++; });
    S.vs.forEach(function (r) { var k = Utilities.formatDate(asDate_(r[2]), 'Asia/Seoul', 'yyyy-MM'); months[k].vu++; });
  }
  monthOrder.sort();
  var t3 = table('월별 추이 · ' + S.name, '신규 = 이번 학기 첫 위반, 재위반 = 2회째 이상',
    ['월', '위반', '신규', '재위반', '예약 (수집분)', '미체크아웃률'],
    monthOrder.map(function (k) { var m = months[k]; return [Number(k.slice(5)) + '월', m.v, m.n, m.r, m.resv || '', m.resv ? m.vu / m.resv : '']; }),
    ['', N, N, N, N, P]);
  if (t3.n) charts.push(mk_(sh.newChart().asColumnChart().setStacked()
    .addRange(sh.getRange(t3.top, 1, t3.n + 1, 1)).addRange(sh.getRange(t3.top, 3, t3.n + 1, 2))
    .setOption('title', '월별 위반 (신규 / 재위반)').setOption('legend', { position: 'bottom' })
    .setOption('width', 520).setOption('height', 260), t3.top, 260, '월별 위반 (신규 / 재위반)'));

  // 4. 학기별 월차 비교 (1개월차, 2개월차 …)
  var maxM = 0, perSem = all.map(function (c) {
    var cnt = {};
    c.vio.forEach(function (r) {
      var d = asDate_(r[2]); if (!c.sem.start) return;
      // 1개월차 = 학기 시작이 그 달 16일 이후면 다음 달 (8/31 시작 → 9월이 1개월차)
      var s0 = new Date(c.sem.start.getFullYear(), c.sem.start.getMonth() + (c.sem.start.getDate() > 15 ? 1 : 0), 1);
      var m = (d.getFullYear() - s0.getFullYear()) * 12 + d.getMonth() - s0.getMonth() + 1;
      if (m >= 1) { cnt[m] = (cnt[m] || 0) + 1; if (m > maxM) maxM = m; }
    });
    return cnt;
  });
  var mRows = [];
  for (var m = 1; m <= maxM; m++) mRows.push([m + '개월차'].concat(perSem.map(function (c) { return c[m] || 0; })));
  var t4 = table('학기별 월차 비교 (위반)', '학기 시작 달을 1개월차로 맞춘 비교', ['월차'].concat(all.map(function (c) { return c.name; })), mRows);
  if (t4.n && all.length) charts.push(mk_(sh.newChart().asLineChart()
    .addRange(sh.getRange(t4.top, 1, t4.n + 1, all.length + 1))
    .setOption('title', '학기별 위반 비교').setOption('legend', { position: 'bottom' })
    .setOption('width', 520).setOption('height', 260), t4.top, 260, '학기별 위반 비교'));

  // 5~7. 이용률·미체크아웃률 (호실 / 요일 / 시간대)
  if (S.usable) {
    var room = {}, wd = {}, band = {};
    D.rooms.forEach(function (x) { room[x] = { n: 0, h: 0, v: 0 }; });
    S.rs.forEach(function (r) {
      var x = String(r[3]); if (!room[x]) room[x] = { n: 0, h: 0, v: 0 };
      room[x].n++; room[x].h += Number(r[6]) || 0;
      var w = String(r[2]); wd[w] = wd[w] || { n: 0, v: 0 }; wd[w].n++;
      var h = Number(r[4]) * 24; STATS.BANDS.forEach(function (b) { if (h >= b[0] && h < b[1]) { band[b[2]] = band[b[2]] || { n: 0, v: 0 }; band[b[2]].n++; } });
    });
    var dn = ['일', '월', '화', '수', '목', '금', '토'];
    S.vs.forEach(function (r) {
      var x = String(r[4]); if (room[x]) room[x].v++;
      var w = dn[asDate_(r[2]).getDay()]; wd[w] = wd[w] || { n: 0, v: 0 }; wd[w].v++;
      var h = startHour_(r[3]); STATS.BANDS.forEach(function (b) { if (h != null && h >= b[0] && h < b[1]) { band[b[2]] = band[b[2]] || { n: 0, v: 0 }; band[b[2]].v++; } });
    });
    var cap = S.days * STATS.OPEN_HOURS;
    var t5 = table('호실별 이용률 · 미체크아웃률', md(S.useFrom) + ' ~ ' + md(S.useTo) + ', 이용 가능 ' + S.days + '일 × 13시간',
      ['호실', '예약', '이용 시간', '이용률', '미체크아웃', '미체크아웃률'],
      Object.keys(room).sort().map(function (x) { var o = room[x]; return [x, o.n, Math.round(o.h * 10) / 10, pct_(o.h, cap), o.v, pct_(o.v, o.n)]; }),
      ['@', N, N1, P, N, P]);
    if (t5.n) charts.push(mk_(sh.newChart().asBarChart()
      .addRange(sh.getRange(t5.top, 1, t5.n + 1, 1)).addRange(sh.getRange(t5.top, 4, t5.n + 1, 1)).addRange(sh.getRange(t5.top, 6, t5.n + 1, 1))
      .setOption('title', '호실별 이용률 · 미체크아웃률').setOption('legend', { position: 'bottom' })
      .setOption('hAxis', { format: 'percent' })
      .setOption('width', 520).setOption('height', 300), t5.top, 300, '호실별 이용률 · 미체크아웃률'));
    table('요일별 예약 · 미체크아웃률', '', ['요일', '예약', '미체크아웃', '미체크아웃률'],
      ['월', '화', '수', '목', '금', '토'].map(function (w) { var o = wd[w] || { n: 0, v: 0 }; return [w, o.n, o.v, pct_(o.v, o.n)]; }),
      ['', N, N, P]);
    table('시간대별 예약 · 미체크아웃률', '예약 시작 시각 기준', ['시간대', '예약', '미체크아웃', '미체크아웃률'],
      STATS.BANDS.map(function (b) { var o = band[b[2]] || { n: 0, v: 0 }; return [b[2], o.n, o.v, pct_(o.v, o.n)]; }),
      ['', N, N, P]);
    // 8. 리드타임
    var lc = STATS.LEAD.map(function (b) { return S.leads.filter(function (x) { return x >= b[0] && x <= b[1]; }).length; });
    table('예약 리드타임', '예약을 만든 날부터 이용일까지', ['구간', '예약', '비율'],
      STATS.LEAD.map(function (b, i) { return [b[2], lc[i], pct_(lc[i], S.leads.length)]; }), ['', N, P]);
  } else {
    table('이용률 · 미체크아웃률 · 리드타임', '', ['안내'], [['예약 기록 수집이 시작된 뒤부터 계산돼요 (이 학기는 수집 전)']]);
  }

  // 9. 삭제 사유별 (오탐률)
  var rs = {};
  STATS.REASONS.forEach(function (x) { rs[x[0]] = { d: 0, done: 0, ex: 0, wait: 0 }; });
  S.del.forEach(function (r) {
    var codes = String(r[12] || '').split(',').map(function (c) { return c.trim(); }).filter(String)
      .map(function (c) { return c.indexOf('RESTRICT') === 0 ? 'RESTRICT' : c; });
    if (!codes.length) codes = ['RESTRICT'];   // 이전 기록은 모두 제한 기간 중 예약
    codes.filter(function (c, i) { return codes.indexOf(c) === i && rs[c]; }).forEach(function (c) {
      rs[c].d++;
      if (r[7] === '완료') rs[c].done++; else if (r[7] === '예외') rs[c].ex++; else rs[c].wait++;
    });
  });
  table('삭제 처리 사유별 · ' + S.name, '한 예약이 여러 사유에 걸리면 각각 셈 · 예외 비율 = 예외 ÷ (완료 + 예외)',
    ['사유', '감지', '완료', '예외', '대기', '예외 비율'],
    STATS.REASONS.map(function (x) { var o = rs[x[0]]; return [x[1], o.d, o.done, o.ex, o.wait, pct_(o.ex, o.done + o.ex)]; }),
    ['', N, N, N, N, P]);

  // 10. 문자 발송 현황
  function smsRow(label, statuses) {
    var o = { ok: 0, bad: 0, manual: 0, gone: 0 };
    statuses.forEach(function (s) {
      s = String(s || '').trim();
      if (s === '성공' || s === '발송됨') o.ok++;
      else if (STATS.BAD.indexOf(s) >= 0) o.bad++;
      else if (s === '수동 발송') o.manual++;
      else if (STATS.GONE.indexOf(s) >= 0) o.gone++;
    });
    var sent = o.ok + o.bad;
    return [label, sent, o.ok, o.bad, o.manual, o.gone, pct_(o.ok, sent)];
  }
  table('문자 발송 현황 · ' + S.name, '10/16 새 시스템 이후 기록만 · 이전 기록·발송 안 함·테스트 제외',
    ['종류', '자동 발송', '성공', '실패·멈춤·확인 불가', '수동 발송', '기한 지남·번호 없음', '성공률'],
    [smsRow('위반 안내', S.vio.map(function (r) { return r[13]; })),
     smsRow('삭제 안내', S.del.filter(function (r) { return r[7] === '완료'; }).map(function (r) { return r[13]; }))],
    ['', N, N, N, N, N, P]);

  // 11. 반복 위반자
  var who = {};
  S.vio.forEach(function (r) {
    var k = personKey_(r); var d = asDate_(r[2]);
    who[k] = who[k] || { name: r[5], phone: r[6], n: 0, last: null, stage: '' };
    who[k].n++; if (!who[k].last || d > who[k].last) who[k].last = d;
    if (String(r[9]).indexOf('제한') === 0) who[k].stage = r[9];
  });
  var top = Object.keys(who).map(function (k) { return who[k]; }).filter(function (o) { return o.n >= 2; })
    .sort(function (a, b) { return b.n - a.n || b.last - a.last; }).slice(0, STATS.TOP_N);
  table('반복 위반자 (상위 ' + STATS.TOP_N + '명) · ' + S.name, '2회 이상',
    ['이름', '전화', '위반', '마지막 위반', '최고 단계'],
    top.map(function (o) { return [o.name, o.phone, o.n, o.last, o.stage ? o.stage.replace('제한3', '영구') : '-']; }),
    ['', '@', N, MD, '']);

  // 12. 주별 위반 추이
  var wk = {};
  S.vio.forEach(function (r) {
    var d = asDate_(r[2]); var mon = new Date(d); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
    var k = dayKey_(mon); wk[k] = wk[k] || { d: mon, v: 0, n: 0, r: 0 };
    wk[k].v++; if (Number(r[8]) === 1) wk[k].n++; else wk[k].r++;
  });
  table('주별 위반 추이 · ' + S.name, '', ['주 시작 (월)', '위반', '신규', '재위반'],
    Object.keys(wk).sort().map(function (k) { var o = wk[k]; return [o.d, o.v, o.n, o.r]; }), [MD, N, N, N]);

  // 차트 배치: 기억한 위치가 있으면 그대로, 없으면 표 옆(I열)에 놓되 위 차트와 겹치지 않게 아래로
  var nextFree = 1, needRows = row + 20;
  charts.forEach(function (c) {
    var p = savedPos[c.title], rowsTall = Math.ceil(c.h / 21) + 1;
    c.b.setNumHeaders(1);   // 첫 행 = 머리글 (범례 이름, 가로축에서 '월' 제외)
    if (p) c.b.setPosition(p[0], p[1], p[2], p[3]);
    else {
      var r = Math.max(c.top, nextFree);
      c.b.setPosition(r, 9, 0, 0);
      nextFree = r + rowsTall;
    }
    needRows = Math.max(needRows, (p ? p[0] : nextFree) + rowsTall);
    sh.insertChart(c.b.build());
  });
  if (sh.getMaxRows() < needRows) sh.insertRowsAfter(sh.getMaxRows(), needRows - sh.getMaxRows());
  else if (sh.getMaxRows() > needRows) sh.deleteRows(needRows + 1, sh.getMaxRows() - needRows);
  Logger.log('✅ 통계 계산 (' + chosen + ', ' + ((new Date() - start) / 1000).toFixed(1) + 's)');
}

// ------------------------------------------------------------
//  이전 학기 위반 기록 가져오기 (옛 '규칙 위반 내역' 형식 → 아카이브)
//  옛 형식: A 관리자명 / B 이름 / C 전화 / D 예약 일자 / E 시간 / F 호실 / G 누적 일자
// ------------------------------------------------------------
function menuImportOldSemester() {
  var ui = SpreadsheetApp.getUi();
  var r1 = ui.prompt('이전 학기 위반 기록 가져오기 (1/2)',
    '가져올 학기의 관리 시트 링크(또는 ID)를 붙여넣어주세요.\n옛 \'규칙 위반 내역\' 탭(B 이름, C 전화, D 예약 일자, G 누적 일자)을 읽습니다.', ui.ButtonSet.OK_CANCEL);
  if (r1.getSelectedButton() !== ui.Button.OK) return;
  var m = r1.getResponseText().match(/[-\w]{25,}/);
  if (!m) { ui.alert('시트 링크를 알아볼 수 없습니다.'); return; }
  var list = semesters_().map(function (x) { return x.name; });
  var r2 = ui.prompt('이전 학기 위반 기록 가져오기 (2/2)',
    '어느 학기로 저장할까요? (설정 탭 학기 기간 표의 이름)\n' + list.join(', '), ui.ButtonSet.OK_CANCEL);
  if (r2.getSelectedButton() !== ui.Button.OK) return;
  var sem = r2.getResponseText().trim();
  if (list.indexOf(sem) < 0) { ui.alert('"' + sem + '"은(는) 학기 기간 표에 없습니다.'); return; }
  var n = importOldSemester_(m[0], '규칙 위반 내역', sem);
  try { refreshStats(); } catch (e) {}
  ui.alert('✅ ' + sem + ' 위반 기록 ' + n + '건을 아카이브에 가져왔습니다.');
}

// 가져온 기록 되돌리기: 아카이브에서 '옛 시트에서 가져옴' 행만 지움 (학기 지정)
function menuUndoImport() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('가져온 기록 되돌리기', '지울 학기 이름을 입력해주세요. (가져오기로 들어온 행만 지워요)', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var n = undoImport_(r.getResponseText().trim());
  try { refreshStats(); } catch (e) {}
  ui.alert('✅ ' + n + '건 지웠습니다.');
}

function undoImport_(semName) {
  var arc = sheet_(CONFIG.SHEETS.ARCHIVE);
  var last = arc.getLastRow();
  if (last < 2) return 0;
  var vals = arc.getRange(2, 1, last - 1, 16).getValues(), n = 0;
  for (var i = vals.length - 1; i >= 0; i--) {
    if (String(vals[i][0]).trim() === semName && vals[i][15] === '옛 시트에서 가져옴') { arc.deleteRow(i + 2); n++; }
  }
  return n;
}

function importOldSemester_(fileId, tabName, semName) {
  var arc = sheet_(CONFIG.SHEETS.ARCHIVE);
  var existing = readRows_(CONFIG.SHEETS.ARCHIVE, 1).filter(function (r) { return String(r[0]).trim() === semName; }).length;
  if (existing) throw new Error('아카이브에 이미 ' + semName + ' 기록이 ' + existing + '건 있습니다.');
  var sem = semesterRange_(semName, semesters_());
  var year = sem.start ? sem.start.getFullYear() : new Date().getFullYear();
  var src = SpreadsheetApp.openById(fileId).getSheetByName(tabName);
  if (!src) throw new Error('"' + tabName + '" 탭을 찾을 수 없습니다.');
  var vals = src.getRange(2, 1, Math.max(1, src.getLastRow() - 1), 7).getValues();

  function md(v) {
    if (v instanceof Date && !isNaN(v)) return dateOnly_(v);
    var m = String(v || '').match(/^\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*$/);
    return m ? new Date(year, Number(m[1]) - 1, Number(m[2])) : null;
  }
  var stages = named_('SANCTION_STAGE').getValues(), counts = named_('SANCTION_COUNT').getValues(),
      lens = named_('SANCTION_LEN').getValues(), units = named_('SANCTION_UNIT').getValues();
  var rows = vals.map(function (r, i) { return { i: i, name: String(r[1]).trim(), phone: formatPhone(r[2]), resv: md(r[3]), time: String(r[4]), room: String(r[5]), acc: md(r[6]) }; })
    .filter(function (r) { return r.name && r.acc; })
    .sort(function (a, b) { return (a.acc - b.acc) || (a.i - b.i); });
  // 날짜가 학기 기간(방학 포함)과 맞는지 확인 → 다른 학기 시트를 잘못 고른 경우 중단
  if (sem.start && rows.length) {
    var fit = rows.filter(function (r) { return inRange_(r.acc, sem.start, sem.end); }).length;
    if (fit / rows.length < 0.8) {
      throw new Error('가져올 기록 ' + rows.length + '건 중 ' + fit + '건만 ' + semName + ' 기간('
        + Utilities.formatDate(sem.start, 'Asia/Seoul', 'M/d') + '~' + (sem.end ? Utilities.formatDate(sem.end, 'Asia/Seoul', 'M/d') : '') + ')에 들어갑니다. 다른 학기 시트가 아닌지 확인해주세요.');
    }
  }
  var seen = {};
  var out = rows.map(function (r) {
    var k = r.phone.replace(/\D/g, '') || r.name;
    seen[k] = (seen[k] || 0) + 1;
    var n = seen[k], stage = '부재', st = '', end = '';
    counts.forEach(function (c, j) { if (Number(c[0]) === n) stage = String(stages[j][0]); });
    if (stage !== '부재' && r.resv) {
      st = new Date(r.resv); st.setDate(st.getDate() + 1);
      counts.forEach(function (c, j) {
        if (String(stages[j][0]) !== stage || stage === '제한3') return;
        end = new Date(st);
        if (units[j][0] === '개월') end.setMonth(end.getMonth() + Number(lens[j][0])); else end.setDate(end.getDate() + Number(lens[j][0]));
      });
    }
    return [semName, r.acc, r.resv || '', r.time, r.room, r.name, r.phone, '', n, stage, st, end, '', '이전 기록', '', '옛 시트에서 가져옴'];
  });
  if (!out.length) return 0;
  var last = lastDataRow_(arc, 6);
  ensureRows_(arc, last + out.length);
  arc.getRange(last + 1, 1, out.length, out[0].length).setValues(out);
  return out.length;
}
