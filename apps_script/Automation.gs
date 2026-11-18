// ============================================================
//  버전 기록 (최신이 위)
//  v8.0  2026-10-22  자동 입력 뒤 학기 전환 알림 확인 + 통계 갱신 (매일 00:05)
//  v7.0  2026-10-22  예약 검사 트리거를 매시간 1개로 변경 (시간대별 7개 → 1개, 트리거 20개 제한 대응)
//  v4.0  2026-10-16  10분 트리거를 tick10min으로 교체 (테두리만)
//  v3.0  2026-10-15  10분 테두리 갱신 트리거 추가
//  v1.0  2026-10-15  자동 입력: 항상 마지막 행 다음에 추가, 예약ID로 중복 체크. installTriggers 통합
// ============================================================

// ============================================================
//  Automation.gs - 전날 미체크아웃자 → '위반 기록' 자동 입력
//  매일 00:05 실행. 원본 열(A~H)만 쓰고, n번째·구분·제한 기간·담당자는
//  시트 수식이 계산합니다.
// ============================================================

function run() {
  var start = new Date();
  log('=== 자동 입력 시작 ===');
  try {
    var yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
    var token = getFirebaseToken();
    if (!token) throw new Error('Firebase 로그인 실패');
    var docs = queryFirestore(token, yesterday.toDateString());
    if (!docs) throw new Error('Firestore 조회 실패');

    var res = collectViolations_(docs, yesterday);
    var written = res.length ? writeViolations_(res) : 0;
    finishRun_('자동 입력', true, (yesterday.getMonth() + 1) + '/' + yesterday.getDate()
      + ' 미체크아웃 ' + docs.length + '건 → ' + written + '명 기록', start, 'ST_AUTOFILL');
    try { checkSemesterAlert_(); } catch (e) { Logger.log('학기 알림 실패: ' + e.message); }
    try { refreshStats(); } catch (e) { Logger.log('통계 갱신 실패: ' + e.message); }
    return written;
  } catch (e) {
    log('❌ ' + e.message);
    finishRun_('자동 입력', false, e.message, start, 'ST_AUTOFILL');
    throw e;
  }
}

// Firestore 문서 → 위반 기록 원본 행(A~H)
function collectViolations_(docs, reservDate) {
  var sem = named_('CFG_SEMESTER').getValue();
  var today = dateOnly_(new Date());
  var rows = docs.map(parseReservation_)
    .filter(function (r) { return r.name && r.name !== CONFIG.ADMIN_NAME; })
    .sort(function (a, b) { return (a.roomIdx - b.roomIdx) || ((a.timeFrom || 0) - (b.timeFrom || 0)); });
  return rows.map(function (r) {
    log('추가 후보: ' + r.name + ' | ' + r.room + ' | ' + r.time);
    return [sem, today, dateOnly_(reservDate), r.time, r.room, r.name, r.phone, r.id];
  });
}

// 항상 마지막 행 '다음'에 추가 (중간 빈칸을 채우지 않음 → 덮어쓰기 없음)
// 중복은 예약ID로 판단
function writeViolations_(rows) {
  var sh = sheet_(CONFIG.SHEETS.VIO);
  var last = lastDataRow_(sh, 6); // F: 이름
  var existing = {};
  if (last >= 2) {
    sh.getRange(2, 8, last - 1, 1).getValues().forEach(function (r) { if (r[0]) existing[r[0]] = true; });
  }
  var fresh = rows.filter(function (r) { return !r[7] || !existing[r[7]]; });
  if (!fresh.length) { log('⚠️ 모두 이미 기록됨'); return 0; }

  ensureRows_(sh, last + fresh.length);
  sh.getRange(last + 1, 1, fresh.length, VIO_RAW_WIDTH).setValues(fresh);
  log('✅ ' + (last + 1) + '~' + (last + fresh.length) + '행 입력');
  return fresh.length;
}

// ============================================================
//  트리거 설치 (새 구조 세팅 후 한 번만 실행)
//  - run: 매일 00:05
//  - step4_findRestrictedReservations: 2, 8, 11, 14, 17, 20, 23시
//  - onDeleteEdit_: 삭제 처리 탭 상태 변경 시 처리자/일시 자동 기록
// ============================================================
function installTriggers() {
  assertSeoulTz_();
  var managed = ['run', 'step4_findRestrictedReservations', 'onDeleteEdit_', 'refreshDashboardBorders', 'tick10min'];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (managed.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });

  ScriptApp.newTrigger('run').timeBased().atHour(0).nearMinute(5).everyDays(1)
    .inTimezone('Asia/Seoul').create();

  // 예약 검사: 매시간 트리거 1개 (실행 시간대는 RestrictedCheck.gs의 CHECK_HOURS에서 거름)
  // ※ Apps Script는 스크립트당 트리거가 20개까지라, 시간마다 트리거를 따로 만들면 넘침
  ScriptApp.newTrigger('step4_findRestrictedReservations').timeBased().everyHours(1).create();

  ScriptApp.newTrigger('onDeleteEdit_').forSpreadsheet(SpreadsheetApp.getActive()).onEdit().create();

  // 10분마다: 대시보드 테두리 (가벼움, Firebase 접속 없음)
  ScriptApp.newTrigger('tick10min').timeBased().everyMinutes(10).create();

  Logger.log('✅ 트리거 설치 완료: run 00:05 / 예약 검사 매시간(2·5·7~23시) / 삭제 처리 편집 감시 / 테두리 10분');
}

// ============================================================
//  웹앱 수동 실행 버튼(doGet)이 부르는 단계 함수들
//  (화면은 WebApp.gs 그대로, 내부만 새 구조로)
// ============================================================
function step1_login() {
  var token = getFirebaseToken();
  if (!token) throw new Error('Firebase login failed');
  CacheService.getScriptCache().put('fb_token', token, 300);
  return true;
}

function step2_fetch() {
  var token = CacheService.getScriptCache().get('fb_token');
  if (!token) throw new Error('No token. Run step 1 first');
  var y = new Date(); y.setDate(y.getDate() - 1);
  var docs = queryFirestore(token, y.toDateString());
  if (!docs) throw new Error('Firestore query failed');
  CacheService.getScriptCache().put('fb_docs', JSON.stringify(docs), 300);
  return docs.length;
}

function step3_write() {
  var start = new Date();
  var docs = JSON.parse(CacheService.getScriptCache().get('fb_docs') || '[]');
  var y = new Date(); y.setDate(y.getDate() - 1);
  var rows = collectViolations_(docs, y);
  var written = rows.length ? writeViolations_(rows) : 0;
  finishRun_('자동 입력(수동)', true, '웹앱 수동 실행 → ' + written + '명 기록', start, 'ST_AUTOFILL');
  return written;
}
