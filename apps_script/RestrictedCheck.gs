// ============================================================
//  버전 기록 (최신이 위)
//  v8.0  2026-10-22  설정 탭 검사 켜기·끄기 반영, 통계 탭 학기 선택 변경 시 통계 다시 계산
//  v7.0  2026-10-22  매시간 실행(2·5시, 7~23시)을 트리거 1개로 처리, 겹침 방지 잠금, 예약 기록 수집 연결,
//                    단계별 소요 시간 로그
//  v4.0  2026-10-16  삭제 확인을 예약ID 직접 조회로 변경, 누락 방지용으로 예약 검사 때만 실행
//  v2.0  2026-10-15  예약 검사로 확장 (정보 오류·공휴일·중복 예약), 사유를 한 줄로 모아 기록
//  v1.0  2026-10-15  제한자 감지: 수식 열·영구 제한자 명단 기준, 9회 도달자 영구 명단 자동 등록
// ============================================================

// ============================================================
//  RestrictedCheck.gs - 예약 검사 → '삭제 처리' 탭
//  하루 7회 실행 (2, 8, 11, 14, 17, 20, 23시)
//
//  앞으로의 모든 예약(미체크아웃)을 읽어서
//   ① 제한자 예약: 위반 기록의 제한1/제한2 기간 중이거나, 영구 제한자 명단에 있는 사람
//   ② 공휴일 예약 / 중복 예약 / 정보 오류(인원·학번·이름·전화) → Validation.gs
//  하나라도 걸리면 삭제 처리 탭에 '대기'로 기록 (사유는 한 줄로 모아서)
//  제한 기간은 시작일~만료일 '포함' (문자에 "~까지"로 안내하므로)
// ============================================================

// 매시간 트리거가 부르는 함수 (트리거 개수 제한 때문에 트리거는 1개, 시간대는 여기서 거름)
// 실행 시각: 2·5시, 7~23시 매시간 (하루 19번). 0시는 자동 입력과 겹치지 않게 건너뜀
var CHECK_HOURS = [2, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23];

function step4_findRestrictedReservations() {
  var h = Number(Utilities.formatDate(new Date(), 'Asia/Seoul', 'H'));
  if (CHECK_HOURS.indexOf(h) < 0) return 0;
  return checkReservations();
}

function checkReservations() {
  // 겹침 방지: 이전 실행이 아직 돌고 있으면 이번 실행은 건너뜀
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) { Logger.log('이전 예약 검사가 아직 실행 중 → 건너뜀'); return 0; }
  try { return checkReservationsLocked_(); } finally { lock.releaseLock(); }
}

function checkReservationsLocked_() {
  var start = new Date();
  var t = { mark: start.getTime(), parts: [] };
  function lap(name) { var n = Date.now(); t.parts.push(name + ' ' + ((n - t.mark) / 1000).toFixed(1) + 's'); t.mark = n; }
  log('=== 예약 검사 시작 ===');
  try {
    var addedPerm = syncPermanentList_();
    var restricted = getRestrictedList_();
    lap('명단');

    var token = getFirebaseToken();
    if (!token) throw new Error('Firebase 로그인 실패');
    var docs = queryUpcomingReservations_(token);
    if (!docs) throw new Error('Firestore 조회 실패');

    var schema = detectSchema_(docs);
    log(describeSchema_(schema));
    lap('조회');

    var logged = 0;
    try { logged = logReservations_(docs, schema); } catch (e) { log('⚠️ 예약 기록 실패: ' + e.message); }
    lap('기록');

    var today = dateOnly_(new Date());
    var resvs = docs.map(function (d) { return parseReservation_(d, schema); })
      .filter(function (r) { return r.date && r.date >= today; });

    var minPeople = Number(named_('CFG_MIN_PEOPLE').getValue()) || 3;
    var holidays = holidaySet_();
    var dups = findDuplicateReservations_(resvs);
    var md = function (d) { return (d.getMonth() + 1) + '/' + d.getDate(); };

    var on = enabledChecks_();   // 설정 탭 '예약 검사 항목'
    var flagged = [], tally = {};
    resvs.forEach(function (r) {
      if (r.name === CONFIG.ADMIN_NAME) return;
      var issues = [], end = '';

      for (var i = 0; i < restricted.length; i++) {
        var x = restricted[i];
        var same = (x.phone && r.phone) ? x.phone === r.phone : x.name === r.name;
        if (!same) continue;
        if (x.permanent) { issues.push({ code: 'PERM' }); end = '영구'; break; }
        if (r.date <= x.end) {
          issues.push({ code: x.kind === '제한2' ? 'RESTRICT2' : 'RESTRICT1', detail: '~' + md(x.end) });
          end = x.end; break;
        }
      }
      var h = holidays[r.date.getTime()];
      if (h) issues.push({ code: 'HOLIDAY', detail: h });
      if (dups[r.id]) issues.push({ code: 'DUP_RESV', detail: dups[r.id].total + '건 중 1건 유지' });
      if (schema.ok) issues = issues.concat(validateInfo_(r, minPeople));
      issues = issues.filter(function (x) { return checkEnabled_(on, x.code); });

      if (issues.length) {
        flagged.push({ r: r, issues: issues, end: end });
        reasonCodes_(issues).split(',').forEach(function (c) { tally[c] = (tally[c] || 0) + 1; });
      }
    });

    lap('검사');
    var w = writeDeleteTargets_(flagged);
    lap('쓰기');
    var autoDone = confirmDeletions_(token);
    lap('삭제확인');
    log('소요: ' + t.parts.join(', '));
    var tallyText = Object.keys(tally).map(function (c) { return REASON_LABEL[c] + ' ' + tally[c]; }).join(', ');
    finishRun_('예약 검사', true, '예약 ' + resvs.length + '건 검사 → 걸림 ' + flagged.length + '건'
      + (tallyText ? '(' + tallyText + ')' : '') + ', 신규 ' + w.added + (w.updated ? ', 사유 갱신 ' + w.updated : '')
      + (autoDone ? ', 삭제 확인 ' + autoDone : '') + (addedPerm ? ', 영구 명단 +' + addedPerm : '')
      + (logged ? ', 예약 기록 +' + logged : '')
      + (schema.ok ? '' : ' ⚠️ ' + describeSchema_(schema)), start, 'ST_DETECT');
    return w.added;
  } catch (e) {
    log('❌ ' + e.message);
    finishRun_('예약 검사', false, e.message, start, 'ST_DETECT');
    throw e;
  }
}

// 위반 기록 + 영구 명단 → [{name, phone, end(Date|null), permanent, reason}]
function getRestrictedList_() {
  var today = dateOnly_(new Date());
  var list = [];

  // 아카이브도 확인: 학기 말에 걸린 제한이 새 학기까지 이어지는 경우
  [CONFIG.SHEETS.VIO, CONFIG.SHEETS.ARCHIVE].forEach(function (tab) {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(tab);
    if (!sh) return;
    var last = lastDataRow_(sh, 6);
    if (last < 2) return;
    // F 이름(6) ~ L 제한 만료(12)
    sh.getRange(2, 6, last - 1, 7).getValues().forEach(function (row) {
      var name = String(row[0]).trim(), phone = formatPhone(row[1]);
      var kind = row[4], s = row[5], e = row[6];
      if (!name || (kind !== '제한1' && kind !== '제한2')) return;
      if (!(s instanceof Date) || !(e instanceof Date)) return;
      if (dateOnly_(s) > today || dateOnly_(e) < today) return;
      list.push({ name: name, phone: phone, end: dateOnly_(e), permanent: false, kind: kind });
    });
  });

  named_('PERM_LIST').getValues().forEach(function (row) {
    var name = String(row[0]).trim();
    if (!name) return;
    list.push({ name: name, phone: formatPhone(row[1]), end: null, permanent: true, kind: '영구' });
  });
  return list;
}

// 위반 기록에서 '제한3'이 된 사람을 영구 명단에 자동 추가 (전화번호 기준 중복 제외)
function syncPermanentList_() {
  var range = named_('PERM_LIST');
  var vals = range.getValues();
  var known = {};
  var nextIdx = 0;
  vals.forEach(function (r, i) {
    if (String(r[0]).trim()) { known[formatPhone(r[1]) || r[0]] = true; nextIdx = i + 1; }
  });

  var sh = sheet_(CONFIG.SHEETS.VIO);
  var last = lastDataRow_(sh, 6);
  if (last < 2) return 0;
  var add = [];
  sh.getRange(2, 1, last - 1, 10).getValues().forEach(function (row) {
    if (row[9] !== '제한3') return;
    var name = String(row[5]).trim(), phone = formatPhone(row[6]);
    var key = phone || name;
    if (known[key]) return;
    known[key] = true;
    add.push([name, phone, dateOnly_(new Date()), row[0] + ' 위반 ' + row[8] + '회 (자동 등록)']);
  });
  if (!add.length) return 0;
  if (nextIdx + add.length > vals.length) throw new Error('영구 제한자 명단 칸이 부족합니다.');
  range.offset(nextIdx, 0, add.length, 4).setValues(add);
  log('영구 명단 자동 추가: ' + add.map(function (a) { return a[0]; }).join(', '));
  return add.length;
}

// 새 건은 추가, 이미 '대기'로 있는 건은 사유가 바뀌었으면 갱신. '완료'/'예외' 건은 건드리지 않음.
function writeDeleteTargets_(flagged) {
  var res = { added: 0, updated: 0 };
  if (!flagged.length) return res;
  var sh = sheet_(CONFIG.SHEETS.DEL);
  var last = lastDataRow_(sh, 4); // D: 이름
  var existing = {};
  if (last >= 2) {
    sh.getRange(2, 1, last - 1, 13).getValues().forEach(function (row, i) {
      if (row[10]) existing[row[10]] = { row: i + 2, status: row[7], codes: String(row[12] || '') };
    });
  }
  var now = new Date(), rows = [];
  flagged
    .sort(function (a, b) { return (a.r.date - b.r.date) || ((a.r.timeFrom || 0) - (b.r.timeFrom || 0)); })
    .forEach(function (f) {
      var text = reasonText_(f.issues), codes = reasonCodes_(f.issues);
      var ex = existing[f.r.id];
      if (ex) {
        if (ex.status === '대기' && ex.codes !== codes) {
          sh.getRange(ex.row, DEL_REASON_COL, 1, 2).setValues([[text, codes]]);
          res.updated++;
        }
        return;
      }
      rows.push([f.r.date, f.r.time, f.r.room, f.r.name, f.r.phone, f.end || '', now,
                 '대기', '', '', f.r.id, text, codes, '', '']);
    });
  if (rows.length) {
    ensureRows_(sh, last + rows.length);
    sh.getRange(last + 1, 1, rows.length, DEL_COLS.length).setValues(rows);
    res.added = rows.length;
    log('삭제 대상 ' + rows.length + '건 기록');
  }
  return res;
}

// ------------------------------------------------------------
//  삭제 확인(누락 방지용): '대기' 건을 예약ID로 Firestore에서 직접 조회
//  담당자가 '완료'로 바꾸는 걸 깜빡해도, 예약 검사 때 사이트에서 이미 지워진 건은 '완료'로 정리
//  당일 예약도 정확히 확인됨 (체크아웃해도 문서는 남고, 삭제해야만 사라지므로)
// ------------------------------------------------------------
function confirmDeletions_(token) {
  var sh = sheet_(CONFIG.SHEETS.DEL);
  var last = lastDataRow_(sh, 4);
  if (last < 2) return 0;
  var vals = sh.getRange(2, 1, last - 1, DEL_COLS.length).getValues();
  var waiting = [];
  vals.forEach(function (row, i) {
    if (row[7] === '대기' && row[10]) waiting.push({ row: i + 2, id: String(row[10]) });
  });
  if (!waiting.length) return 0;

  if (!token) token = getFirebaseToken();
  if (!token) throw new Error('Firebase 로그인 실패');

  var base = 'projects/' + CONFIG.FB_PROJECT + '/databases/(default)/documents/reservations/';
  var gone = {};
  for (var k = 0; k < waiting.length; k += 100) {
    var chunk = waiting.slice(k, k + 100);
    var resp = UrlFetchApp.fetch('https://firestore.googleapis.com/v1/projects/' + CONFIG.FB_PROJECT
      + '/databases/(default)/documents:batchGet', {
      method: 'POST', contentType: 'application/json', muteHttpExceptions: true,
      headers: { 'Authorization': 'Bearer ' + token },
      payload: JSON.stringify({ documents: chunk.map(function (w) { return base + w.id; }) })
    });
    var data = JSON.parse(resp.getContentText());
    if (!Array.isArray(data)) throw new Error('Firestore 확인 실패: ' + resp.getContentText().substring(0, 200));
    data.forEach(function (d) {
      if (d.missing) gone[d.missing.split('/').pop()] = true;
      else if (d.found && looksDeleted_(d.found.fields || {})) gone[d.found.name.split('/').pop()] = true;
    });
  }

  var now = new Date(), n = 0;
  waiting.forEach(function (w) {
    if (!gone[w.id]) return;
    sh.getRange(w.row, 8, 1, 3).setValues([['완료', '자동 확인', now]]);
    n++;
  });
  if (n) log('삭제 확인 → 완료 ' + n + '건');
  return n;
}

// 사이트가 문서를 지우지 않고 상태값만 바꾸는 방식일 때 대비
function looksDeleted_(f) {
  for (var k in f) {
    var v = f[k];
    if (/^(deleted|isDeleted|removed)$/i.test(k) && v.booleanValue === true) return true;
    if (/^(status|state)$/i.test(k) && v.stringValue && /cancel|delet|remov|취소|삭제/i.test(v.stringValue)) return true;
  }
  return false;
}

// 10분마다: 대시보드 테두리만 갱신 (installTriggers가 설치, Firebase 접속 없음)
// 삭제 확인은 담당자가 상태를 '완료'로 바꾸는 게 기본이고,
// 놓친 건은 예약 검사(하루 7회, 약 3시간 간격)가 confirmDeletions_로 잡아줌
function tick10min() {
  refreshDashboardBorders();
}

// ------------------------------------------------------------
//  삭제 처리 탭에서 상태를 바꾸면 처리자(그 주 담당자)·처리 일시 자동 기록
//  (installTriggers()가 설치하는 설치형 onEdit 트리거)
// ------------------------------------------------------------
function onDeleteEdit_(e) {
  if (!e || !e.range) return;
  var sh = e.range.getSheet();
  // 통계 탭 학기 선택을 바꾸면 다시 계산
  if (sh.getName() === CONFIG.SHEETS.STATS && e.range.getA1Notation() === STATS.SEM_CELL) { refreshStats(); return; }
  if (sh.getName() !== CONFIG.SHEETS.DEL) return;
  if (e.range.getColumn() !== DEL_STATUS_COL || e.range.getRow() < 2 || e.range.getNumRows() !== 1) return;
  var row = e.range.getRow();
  var v = e.range.getValue();
  if (v === '완료' || v === '예외') {
    var who = '';
    try { who = Session.getActiveUser().getEmail(); } catch (err) {}
    if (!who) { try { who = managerOn_(new Date()); } catch (err) {} }
    sh.getRange(row, 9, 1, 2).setValues([[who || '(알 수 없음)', new Date()]]);
  } else if (v === '대기') {
    sh.getRange(row, 9, 1, 2).clearContent();
  }
  SpreadsheetApp.flush();
  refreshDashboardBorders();
}
