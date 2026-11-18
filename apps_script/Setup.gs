// ============================================================
//  버전 기록 (최신이 위)
//  v8.3p  2026-11-19  공개판: SEED의 관리자 실명·영구 제한자(실명·전화) 제거, 예시 값으로
//  v8.3  2026-10-22  위반 기록 '문자 상태'(N열)에도 선택 목록 (삭제 처리와 같은 값), applySmsDropdowns() 추가
//  v8.2  2026-10-22  정리: 빈 새 시트 기준으로 setupNewStructure 단순화 (옛 탭 이전·옛 통계·옛 제재 설정 삭제),
//                    로테이션 시작 월요일을 비우면 이번 주 월요일로 자동, upgradeToV2·upgradeToV5 삭제 (운영 시트에 이미 적용, 새 시트는 처음부터 반영)
//  v8.1  2026-10-22  문자 발송 봇 이름 SeRMA → SeSMA
//  v8.0  2026-10-22  새로 만들 때 마지막에 upgradeToV8 실행 (설정 탭 v8·통계 탭)
//  v5.0  2026-10-22  대시보드 생성을 Dashboard.gs(v5 배치)로 위임, 삭제 처리 '문자 상태' 선택 목록 + upgradeToV5
//  v4.0  2026-10-16  대시보드 왼쪽 목록 A8부터, 1~6행 고정
//  v2.0  2026-10-15  최소 인원·공휴일 설정, 삭제 처리 열 추가, upgradeToV2, 대시보드 삭제할 예약 전체 표시
//  v1.0  2026-10-15  setupNewStructure: 새 탭·수식·대시보드 생성, 기존 데이터 이전
// ============================================================

// ============================================================
//  Setup.gs - 빈 스프레드시트에 SeRMA 시트 한 번에 만들기 (새 시트에서 1회 실행)
//
//  setupNewStructure() 가 하는 일
//   1) 탭 생성: 대시보드 / 위반 기록 / 삭제 처리 / 통계 / 설정 / 로그(숨김) / 아카이브(숨김)
//      (예약 기록(숨김)은 첫 예약 검사·예약 기록 가져오기 때 자동 생성)
//   2) 헤더, 수식, 서식, 이름 있는 범위 설정
//   3) 마지막에 upgradeToV8 → 설정 탭 최종 구성·제재 수식·통계·보호
//   이전 학기 기록은 메뉴 > 이전 학기 위반 기록 가져오기 로
//
//  실행 전에 아래 SEED 값을 확인하세요.
// ============================================================

var SEED = {
  SEMESTER: '2026-2학기',
  // 로테이션: 첫 월요일부터 순서대로 1주씩 돌아가며 WEEKS 주 생성 (설정 탭에서 언제든 수정 가능)
  ROTATION_FIRST_MONDAY: '',   // 비우면 이번 주 월요일부터 (예: '2027-03-02')
  ROTATION_ORDER: ['관리자A', '관리자B', '관리자C'],
  ROTATION_WEEKS: 12,
  // 관리자 전화번호는 설정 탭에서 채우세요 (교대 문자 수신용)
  MANAGERS: ['관리자A', '관리자B', '관리자C'],
  // 학기가 바뀌어도 유지되는 영구 제한자
  PERMANENT: [],   // 예: [['홍길동', '010-0000-0000', '사유']]
  // 공휴일 (설정 탭에서 추가·수정. 학교 휴일·대체공휴일도 여기에)
  HOLIDAYS: [['2026-12-25', '성탄절'], ['2027-01-01', '신정']]
};

var STYLE = {
  HEAD_BG: '#1f2937', HEAD_FG: '#ffffff',
  CALC_BG: '#f3f4f6',              // 수식이 채우는 칸
  CARD_BG: '#f8fafc', BORDER: '#cbd5e1',
  RED_BG: '#fee2e2', RED_FG: '#b91c1c',
  GREEN_BG: '#dcfce7', GREEN_FG: '#166534'
};

function setupNewStructure() {
  assertSeoulTz_();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName(CONFIG.SHEETS.VIO)) {
    throw new Error('이미 "' + CONFIG.SHEETS.VIO + '" 탭이 있습니다. 새 시트(빈 스프레드시트)에서 실행하세요.');
  }
  ss.setSpreadsheetTimeZone('Asia/Seoul');
  ss.setRecalculationInterval(SpreadsheetApp.RecalculationInterval.HOUR); // 대시보드 NOW() 갱신

  buildSettings_(ss);
  buildViolations_(ss);
  buildDeletions_(ss);
  buildLog_(ss);
  buildArchive_(ss);
  rebuildStatsSheet_(ss);
  var dash = buildDashboard_(ss);
  named_('CFG_DASH_URL').setValue(ss.getUrl() + '#gid=' + dash.getSheetId());

  // 탭 순서
  [CONFIG.SHEETS.DASH, CONFIG.SHEETS.VIO, CONFIG.SHEETS.DEL, CONFIG.SHEETS.STATS, CONFIG.SHEETS.SET]
    .forEach(function (name, i) { ss.setActiveSheet(ss.getSheetByName(name)); ss.moveActiveSheet(i + 1); });
  // 빈 스프레드시트의 기본 탭(시트1 등) 정리
  ss.getSheets().forEach(function (t) {
    if (/^(시트|Sheet)\d+$/.test(t.getName()) && t.getLastRow() === 0) ss.deleteSheet(t);
  });
  ss.setActiveSheet(dash);

  upgradeToV8();   // 설정 탭 최종 구성 · 제재 수식 · 통계 · 보호 (Settings.gs)
  Logger.log('✅ 새 시트 완료. 다음: 설정 탭 관리자 전화번호·학기 기간 확인 → installTriggers() 실행');
}

// ------------------------------------------------------------
function header_(range) {
  range.setBackground(STYLE.HEAD_BG).setFontColor(STYLE.HEAD_FG).setFontWeight('bold');
}
function section_(range, text) {
  range.setValue(text).setFontWeight('bold').setFontSize(12);
}
function name_(ss, name, range) { ss.setNamedRange(name, range); }

// ------------------------------------------------------------
//  설정
// ------------------------------------------------------------
function buildSettings_(ss) {
  var sh = ss.insertSheet(CONFIG.SHEETS.SET);
  sh.getRange('A1').setValue('설정').setFontSize(16).setFontWeight('bold');
  sh.getRange('A2').setValue('흰 칸은 직접 수정, 회색 칸은 스크립트·수식이 채웁니다.').setFontColor('#6b7280');

  // 규칙
  section_(sh.getRange('A3'), '규칙');
  sh.getRange('B4').setNumberFormat('@');
  // (기본 규칙·제재 기준·학기 기간 등 A:D는 upgradeToV8이 다시 그림)
  sh.getRange('A4:B4').setValues([['현재 학기 (바꾸면 누적 횟수 리셋)', SEED.SEMESTER]]);
  sh.getRange('A8:B8').setValues([['대시보드 링크', '']]);
  sh.getRange('B8').setBackground(STYLE.CALC_BG);
  name_(ss, 'CFG_SEMESTER', sh.getRange('B4'));
  name_(ss, 'CFG_DASH_URL', sh.getRange('B8'));

  // 시스템 상태 (스크립트가 기록)
  section_(sh.getRange('A10'), '시스템 상태');
  sh.getRange('A11:A13').setValues([['자동 입력 (Apps Script)'], ['제한자 감지 (Apps Script)'], ['SeSMA 문자 발송 (Python)']]);
  sh.getRange('B11:C13').setBackground(STYLE.CALC_BG);
  sh.getRange('B11:B13').setNumberFormat('m/d hh:mm');
  name_(ss, 'ST_AUTOFILL', sh.getRange('B11:C11'));
  name_(ss, 'ST_DETECT', sh.getRange('B12:C12'));
  name_(ss, 'ST_MAC', sh.getRange('B13:C13'));

  // 관리자 연락처
  section_(sh.getRange('E3'), '관리자 연락처');
  header_(sh.getRange('E4:F4').setValues([['이름', '전화']]));
  sh.getRange('F5:F14').setNumberFormat('@');
  sh.getRange(5, 5, SEED.MANAGERS.length, 1).setValues(SEED.MANAGERS.map(function (m) { return [m]; }));
  name_(ss, 'MGR_CONTACTS', sh.getRange('E5:F14'));

  // 로테이션
  section_(sh.getRange('H3'), '로테이션 (월~일)');
  header_(sh.getRange('H4:J4').setValues([['시작(월)', '종료(일)', '관리자']]));
  var first;
  if (SEED.ROTATION_FIRST_MONDAY) {
    var p = SEED.ROTATION_FIRST_MONDAY.split('-').map(Number);
    first = new Date(p[0], p[1] - 1, p[2]);
  } else {
    first = dateOnly_(new Date()); first.setDate(first.getDate() - (first.getDay() + 6) % 7);   // 이번 주 월요일
  }
  var rot = [];
  for (var w = 0; w < SEED.ROTATION_WEEKS; w++) {
    var d = new Date(first); d.setDate(d.getDate() + 7 * w);
    rot.push([d, SEED.ROTATION_ORDER[w % SEED.ROTATION_ORDER.length]]);
  }
  sh.getRange(5, 8, rot.length, 1).setValues(rot.map(function (r) { return [r[0]]; }));
  sh.getRange(5, 10, rot.length, 1).setValues(rot.map(function (r) { return [r[1]]; }));
  sh.getRange('I5').setFormula('=ARRAYFORMULA(IF(H5:H80="",,H5:H80+6))');
  sh.getRange('I5:I80').setBackground(STYLE.CALC_BG);
  sh.getRange('H5:I80').setNumberFormat('m/d (ddd)');
  name_(ss, 'ROT_START', sh.getRange('H5:H80'));
  name_(ss, 'ROT_MGR', sh.getRange('J5:J80'));
  sh.getRange('J5:J80').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInRange(sh.getRange('E5:E14'), true).setAllowInvalid(true).build());

  // 영구 제한자
  section_(sh.getRange('L3'), '영구 제한자 (학기 리셋 안 됨)');
  header_(sh.getRange('L4:O4').setValues([['이름', '전화', '등록일', '사유']]));
  sh.getRange('M5:M300').setNumberFormat('@');
  sh.getRange('N5:N300').setNumberFormat('yyyy-mm-dd');
  if (SEED.PERMANENT.length) {
    var today = dateOnly_(new Date());
    sh.getRange(5, 12, SEED.PERMANENT.length, 4).setValues(SEED.PERMANENT.map(function (p) { return [p[0], p[1], today, p[2]]; }));
  }
  name_(ss, 'PERM_LIST', sh.getRange('L5:O300'));

  sh.setColumnWidth(1, 260); sh.setColumnWidth(2, 150); sh.setColumnWidth(3, 280);
  sh.setColumnWidth(4, 30); sh.setColumnWidth(7, 30); sh.setColumnWidth(11, 30);
  sh.setColumnWidth(15, 220);
  ensureSettingsV2_(ss, sh);
  return sh;
}

// v2: 최소 인원, 공휴일 목록 (기존 설정 탭에도 안전하게 추가)
function ensureSettingsV2_(ss, sh) {
  if (!ss.getRangeByName('CFG_MIN_PEOPLE')) {
    sh.getRange('A9:B9').setValues([['최소 이용 인원 (대표 포함)', 3]]);
    name_(ss, 'CFG_MIN_PEOPLE', sh.getRange('B9'));
  }
  sh.getRange('A12').setValue('예약 검사 (Apps Script)');
  if (!ss.getRangeByName('HOLIDAYS')) {
    section_(sh.getRange('Q3'), '공휴일 (이 날짜 예약은 삭제 대상)');
    header_(sh.getRange('Q4:R4').setValues([['날짜', '이름']]));
    sh.getRange('Q5:Q100').setNumberFormat('yyyy-mm-dd (ddd)');
    var hol = SEED.HOLIDAYS.map(function (h) { var p = h[0].split('-').map(Number); return [new Date(p[0], p[1] - 1, p[2]), h[1]]; });
    if (hol.length) sh.getRange(5, 17, hol.length, 2).setValues(hol);
    name_(ss, 'HOLIDAYS', sh.getRange('Q5:R100'));
    sh.setColumnWidth(16, 30); sh.setColumnWidth(17, 130); sh.setColumnWidth(18, 140);
  }
}

// ------------------------------------------------------------
//  위반 기록
// ------------------------------------------------------------
function buildViolations_(ss) {
  var sh = ss.insertSheet(CONFIG.SHEETS.VIO);
  sh.getRange('A:A').setNumberFormat('@');
  sh.getRange('B:C').setNumberFormat('m/d');
  sh.getRange('D:H').setNumberFormat('@');
  sh.getRange('K:L').setNumberFormat('m/d');
  sh.getRange('O:O').setNumberFormat('m/d hh:mm');

  sh.getRange('A1:H1').setValues([VIO_COLS.slice(0, 8)]);
  // 수식 열: 헤더 칸 안에 넣어서, 데이터 행을 지워도 수식이 사라지지 않음
  sh.getRange('I1').setFormula('={"n번째"; ARRAYFORMULA(IF(G2:G="",, COUNTIFS(G2:G, G2:G, A2:A, A2:A, ROW(G2:G), "<="&ROW(G2:G))))}');
  sh.getRange('J1').setValue('구분');        // 수식은 upgradeToV8(rewriteSanctionFormulas_)이 제재 기준 표로 넣음
  sh.getRange('K1').setFormula('={"제한 시작"; ARRAYFORMULA(IF(LEFT(J2:J, 2)="제한", C2:C+1, ))}');
  sh.getRange('L1').setValue('제한 만료');
  sh.getRange('M1').setFormula('={"담당자"; ARRAYFORMULA(IF(B2:B="",, IFERROR(VLOOKUP(B2:B, {ROT_START, ROT_MGR}, 2, TRUE), )))}');
  sh.getRange('N1:P1').setValues([VIO_COLS.slice(13)]);

  header_(sh.getRange('A1:P1'));
  sh.getRange('I1:M1').setBackground('#374151');
  sh.getRange('I2:M').setBackground(STYLE.CALC_BG);
  sh.setFrozenRows(1);

  var widths = [80, 60, 60, 100, 60, 70, 115, 60, 55, 55, 70, 70, 60, 80, 85, 200];
  widths.forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  sh.hideColumns(8); // 예약ID

  // 구분/문자 상태 색
  var rules = [];
  var J = sh.getRange('J2:J'), N = sh.getRange('N2:N');
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('제한').setFontColor(STYLE.RED_FG).setBold(true).setRanges([J]).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=REGEXMATCH($N2, "^(실패|멈춤|확인 불가|기한 지남|번호 없음)$")')
    .setBackground(STYLE.RED_BG).setFontColor(STYLE.RED_FG).setRanges([N]).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('성공')
    .setFontColor(STYLE.GREEN_FG).setRanges([N]).build());
  sh.setConditionalFormatRules(rules);
  applyViolationSmsDropdown_(sh);
  return sh;
}

// ------------------------------------------------------------
//  삭제 처리
// ------------------------------------------------------------
function buildDeletions_(ss) {
  var sh = ss.insertSheet(CONFIG.SHEETS.DEL);
  styleDeletions_(sh);
  return sh;
}

// 헤더·서식·검증·색 (기존 탭 업그레이드에도 사용)
function styleDeletions_(sh) {
  if (sh.getMaxColumns() < DEL_COLS.length) sh.insertColumnsAfter(sh.getMaxColumns(), DEL_COLS.length - sh.getMaxColumns());
  sh.getRange('A:A').setNumberFormat('m/d (ddd)');
  sh.getRange('B:C').setNumberFormat('@');
  sh.getRange('E:E').setNumberFormat('@');
  sh.getRange('F:F').setNumberFormat('m/d');
  sh.getRange('G:G').setNumberFormat('m/d hh:mm');
  sh.getRange('J:J').setNumberFormat('m/d hh:mm');
  sh.getRange('K:K').setNumberFormat('@');
  sh.getRange('O:O').setNumberFormat('m/d hh:mm');

  sh.getRange(1, 1, 1, DEL_COLS.length).setValues([DEL_COLS]);
  header_(sh.getRange(1, 1, 1, DEL_COLS.length));
  sh.setFrozenRows(1);

  sh.getRange('H2:H').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(['대기', '완료', '예외'], true).build());
  sh.getRange('L2:L').clearDataValidations(); // 사유는 스크립트가 자세히 적음 (직접 입력도 가능)
  applyDeleteSmsDropdown_(sh);

  var rules = [];
  var row = sh.getRange('A2:L'), N = sh.getRange('N2:N');
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$H2="대기"')
    .setBackground(STYLE.RED_BG).setRanges([row]).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$H2="완료"')
    .setFontColor('#9ca3af').setRanges([row]).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=REGEXMATCH($N2&"", "^(실패|멈춤|확인 불가|기한 지남|번호 없음)$")')
    .setBackground(STYLE.RED_BG).setFontColor(STYLE.RED_FG).setRanges([N]).build());
  sh.setConditionalFormatRules(rules);

  var widths = [85, 100, 60, 70, 115, 70, 95, 60, 150, 95, 60, 380, 90, 80, 85];
  widths.forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  sh.getRange('L:L').setWrap(true);
  sh.hideColumns(DEL_ID_COL);
  sh.hideColumns(13); // 사유코드
}

// ------------------------------------------------------------
function buildLog_(ss) {
  var sh = ss.insertSheet(CONFIG.SHEETS.LOG);
  sh.getRange('A1:F1').setValues([['시각', '작업', '결과', '소요(초)', '요약', '상세']]);
  header_(sh.getRange('A1:F1'));
  sh.getRange('A:A').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sh.setFrozenRows(1);
  sh.setColumnWidth(5, 380); sh.setColumnWidth(6, 500);
  sh.hideSheet();
}

function buildArchive_(ss) {
  var sh = ss.insertSheet(CONFIG.SHEETS.ARCHIVE);
  sh.getRange(1, 1, 1, VIO_COLS.length).setValues([VIO_COLS]);
  header_(sh.getRange(1, 1, 1, VIO_COLS.length));
  sh.getRange('B:C').setNumberFormat('m/d');
  sh.getRange('K:L').setNumberFormat('m/d');
  sh.setFrozenRows(1);
  sh.hideSheet();
}

// ------------------------------------------------------------
//  대시보드
//  왼쪽(A~F): 삭제할 예약 — 개수 제한 없이 아래로 전부 표시
//  배치는 Dashboard.gs (v5)
// ------------------------------------------------------------
function buildDashboard_(ss) {
  return buildDashboardV5_(ss); // Dashboard.gs
}

// ============================================================
//  '문자 상태' 선택 목록 (삭제 처리 N열, 위반 기록 N열)
//  - 관리자가 고를 수 있는 값: 수동 발송 / 발송 안 함 / 성공 / 실패
//  - SeSMA가 쓰는 다른 값(멈춤, 확인 불가, 테스트·성공 등)도 그대로 들어갈 수 있게 목록 외 값 허용
//  - 이 칸이 비어 있지 않으면 SeSMA는 그 행에 문자를 보내지 않음 ('발송 안 함'으로 미리 막을 수 있음)
//  - 실패한 건은 직접 보낸 뒤 '수동 발송'으로 바꾸면 대시보드 '문자 발송 문제'에서 빠짐
// ============================================================
var DEL_SMS_CHOICES = ['수동 발송', '발송 안 함', '성공', '실패', '멈춤', '확인 불가', '기한 지남', '번호 없음', '이전 기록'];

function applyDeleteSmsDropdown_(sh) {
  sh.getRange(2, 14, sh.getMaxRows() - 1, 1).setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(DEL_SMS_CHOICES, true).setAllowInvalid(true)
    .setHelpText('직접 문자를 보냈으면 "수동 발송", 보내지 않을 거면 "발송 안 함". 비워두면 SeSMA가 자동 발송').build());
}

function applyViolationSmsDropdown_(sh) {
  sh.getRange(2, VIO_STATUS_COL, sh.getMaxRows() - 1, 1).setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(DEL_SMS_CHOICES, true).setAllowInvalid(true)
    .setHelpText('직접 문자를 보냈으면 "수동 발송", 보내지 않을 거면 "발송 안 함". 비워두면 SeSMA가 자동 발송 (누적일 2일 이내)').build());
}

// 두 탭 모두 적용 (이미 v8을 적용한 시트에서 편집기로 1회 실행, 여러 번 실행해도 안전)
function applySmsDropdowns() {
  applyDeleteSmsDropdown_(sheet_(CONFIG.SHEETS.DEL));
  applyViolationSmsDropdown_(sheet_(CONFIG.SHEETS.VIO));
  Logger.log('✅ 위반 기록·삭제 처리 문자 상태 선택 목록 적용');
}

// ============================================================
//  학기 마감: 위반 기록을 아카이브로 옮기고 새 학기 시작
//  예) startNewSemester('2027-1학기')
//  ※ 학기 값만 바꿔도 누적 횟수는 리셋되지만, 탭을 가볍게 하려면 이걸 쓰세요.
//    문자 발송 직후(같은 날)에는 실행하지 마세요.
// ============================================================
function startNewSemester(newSemester) {
  if (!newSemester) throw new Error('새 학기 이름을 넣어주세요. 예: startNewSemester("2027-1학기")');
  var vio = sheet_(CONFIG.SHEETS.VIO), arc = sheet_(CONFIG.SHEETS.ARCHIVE);
  syncPermanentList_(); // 제한3 대상자를 영구 명단에 먼저 반영
  var last = lastDataRow_(vio, 6);
  if (last >= 2) {
    var vals = vio.getRange(2, 1, last - 1, VIO_COLS.length).getValues(); // 수식 결과까지 값으로 보존
    var aLast = lastDataRow_(arc, 6);
    ensureRows_(arc, aLast + vals.length);
    arc.getRange(aLast + 1, 1, vals.length, VIO_COLS.length).setValues(vals);
    vio.getRange(2, 1, last - 1, VIO_RAW_WIDTH).clearContent();
    vio.getRange(2, VIO_STATUS_COL, last - 1, 3).clearContent();
  }
  named_('CFG_SEMESTER').setValue(newSemester);
  Logger.log('✅ ' + (last - 1) + '건 아카이브, 현재 학기 = ' + newSemester);
}
