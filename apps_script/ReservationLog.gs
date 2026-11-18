// ============================================================
//  버전 기록 (최신이 위)
//  v8.0  2026-10-22  탭 이름을 CONFIG.SHEETS.RESV로 통일
//  v7.0  2026-10-22  예약 기록 수집 신규: 예약 검사 때마다 보이는 예약을 숨김 탭 '예약 기록'에 쌓음
//                    (개인정보 없이 날짜·호실·시간·인원·생성 시각만), 지금 남은 예약 한 번에 가져오기
// ============================================================

// ============================================================
//  ReservationLog.gs - 예약 기록 (통계용 분모)
//
//  사이트에서 지난 예약을 수동으로 지우기 때문에, 지워지기 전에 여기 쌓아둠.
//  - 예약 검사(매시간)가 조회한 예약 중 처음 보는 예약ID만 맨 아래에 추가 → 쓰기는 거의 없음
//  - 이름·전화·학번·목적은 저장하지 않음
//  - 이름이 ADMIN인 예약은 제외
//  - backfillReservations(): 지금 사이트에 남은 예약 전체(지난 예약 포함)를 한 번에 가져옴 (처음 1회)
// ============================================================

var RESV_COLS = ['예약ID', '예약일', '요일', '호실', '시작', '끝', '이용 시간', '인원',
                 '생성 시각', '리드타임(일)', '체크아웃', '수집 시각'];

function resvSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(CONFIG.SHEETS.RESV);
  if (sh) return sh;
  sh = ss.insertSheet(CONFIG.SHEETS.RESV);
  sh.getRange(1, 1, 1, RESV_COLS.length).setValues([RESV_COLS])
    .setBackground('#1f2937').setFontColor('#ffffff').setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.getRange('A:A').setNumberFormat('@');
  sh.getRange('B:B').setNumberFormat('yyyy-mm-dd');
  sh.getRange('E:F').setNumberFormat('hh:mm');
  sh.getRange('G:G').setNumberFormat('0.00');
  sh.getRange('I:I').setNumberFormat('yyyy-mm-dd hh:mm');
  sh.getRange('L:L').setNumberFormat('yyyy-mm-dd hh:mm');
  sh.hideSheet();
  return sh;
}

// 슬롯(15분 단위, 0 = 9:00) → 시각 (시트 시간 값, 하루의 비율)
function slotToDayFraction_(slot) { return (9 * 60 + slot * 15) / (24 * 60); }

// 인원: 대표 + 멤버, 학번 기준 중복 제외 (Validation.gs와 같은 기준)
function peopleCount_(r) {
  if (!r.members) return '';
  var seen = {};
  var rep = String(r.studentId || '').replace(/\s/g, '');
  if (rep) seen[rep] = true;
  r.members.forEach(function (m, i) {
    var name = String(m.name || '').trim(), id = String(m.id || '').replace(/\s/g, '');
    if (!name && !id) return;
    seen[id || ('__' + i)] = true;
  });
  return Object.keys(seen).length || 1;
}

function resvRow_(doc, r, now) {
  var dayNames = ['일', '월', '화', '수', '목', '금', '토'];
  var f = doc.fields || {};
  var co = f.checkOut && ('booleanValue' in f.checkOut) ? f.checkOut.booleanValue : '';
  var hours = (r.timeFrom != null && r.timeTo != null) ? (r.timeTo - r.timeFrom) / 4 : '';
  var created = r.createTime || '';
  var lead = (created && r.date) ? Math.round((r.date - dateOnly_(created)) / 86400000) : '';
  return [
    r.id, r.date || '', r.date ? dayNames[r.date.getDay()] : '', r.room,
    r.timeFrom != null ? slotToDayFraction_(r.timeFrom) : '',
    r.timeTo != null ? slotToDayFraction_(r.timeTo) : '',
    hours, peopleCount_(r), created, lead, co, now
  ];
}

/**
 * 조회한 예약 문서들 중 처음 보는 것만 '예약 기록'에 추가
 * @return {number} 추가한 건수
 */
function logReservations_(docs, schema) {
  if (!docs || !docs.length) return 0;
  var sh = resvSheet_();
  var last = sh.getLastRow();
  var known = {};
  if (last >= 2) sh.getRange(2, 1, last - 1, 1).getValues().forEach(function (v) { if (v[0]) known[v[0]] = true; });

  var now = new Date(), rows = [];
  docs.forEach(function (doc) {
    var id = doc.name.split('/').pop();
    if (known[id]) return;
    var r = parseReservation_(doc, schema);
    if (!r.date || r.name === CONFIG.ADMIN_NAME) return;
    known[id] = true;
    rows.push(resvRow_(doc, r, now));
  });
  if (!rows.length) return 0;
  rows.sort(function (a, b) { return (a[1] - b[1]) || (a[4] - b[4]); });
  sh.getRange(last + 1, 1, rows.length, RESV_COLS.length).setValues(rows);
  return rows.length;
}

/**
 * 처음 1회: 지금 사이트에 남아 있는 예약 전체(지난 예약 포함)를 가져옴
 * 이미 있는 예약ID는 건너뛰므로 여러 번 실행해도 중복 없음
 */
function backfillReservations() {
  var start = new Date();
  try {
    var token = getFirebaseToken();
    if (!token) throw new Error('Firebase 로그인 실패');
    var docs = firestoreQuery_(token, null);   // 조건 없이 전체
    if (!docs) throw new Error('Firestore 조회 실패');
    var schema = detectSchema_(docs);
    var n = logReservations_(docs, schema);
    finishRun_('예약 기록 가져오기', true, '사이트에 남은 예약 ' + docs.length + '건 중 ' + n + '건 새로 기록', start, null);
    Logger.log('✅ 예약 ' + docs.length + '건 확인, ' + n + '건 기록');
  } catch (e) {
    finishRun_('예약 기록 가져오기', false, e.message, start, null);
    throw e;
  }
}
