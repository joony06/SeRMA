// ============================================================
//  버전 기록 (최신이 위)
//  v8.3p  2026-11-19  공개판: 최고 관리자 기본 전화번호 제거
//  v8.3  2026-10-22  upgradeToV8에서 위반 기록 문자 상태 선택 목록도 적용
//  v8.2  2026-10-22  정리: 테스트용 fixSanctionFormulas 삭제 (upgradeToV8이 같은 수식을 씀), 완료 안내 문구 수정,
//                    삭제 처리 '문자 상태' 선택 목록도 함께 적용 (upgradeToV5 삭제 대신)
//  v8.1  2026-10-22  J열 '구분' 수식을 VLOOKUP으로 변경 (INDEX는 ARRAYFORMULA에서 첫 행만 계산돼 전부 비던 버그),
//                    fixSanctionFormulas() 추가, 문자 발송 봇 이름 SeRMA → SeSMA
//  v8.0  2026-10-22  설정 탭 개편 신규: 기본 규칙 / 제재 기준 표(표대로 계산) / 학기 기간 / 예약 검사 켜기·끄기 /
//                    시스템 상태(아래로), 관리자 연락처에 최고 관리자 칸, 탭 보호(본인만),
//                    로테이션 채우기·공휴일 불러오기·학기 전환(메뉴), 학기 전환 알림(이메일), upgradeToV8
// ============================================================

// ============================================================
//  Settings.gs - 설정 탭과 관련 기능
//
//  설정 탭 왼쪽(A:D) 구성
//    3  기본 규칙         4 현재 학기 / 5 최소 이용 인원 / 6 대시보드 링크
//    8  제재 기준         9 머리글, 10~12 제한1·제한2·제한3(영구)  ← 횟수·기간·단위만 수정
//   14  학기 기간         15 머리글, 16~23 학기·시작·종료
//   26  예약 검사 항목    27 머리글, 28~36 검사·사용(체크박스)·코드
//   38  시스템 상태       39 자동 입력 / 40 예약 검사 / 41 SeSMA  (스크립트가 기록)
//  오른쪽: 관리자 연락처(+최고 관리자) / 로테이션 / 영구 제한자 / 공휴일 (위치는 이전과 같고 한 칸씩 오른쪽)
// ============================================================

var SANCTION_DEFAULT = [['제한1', 3, 7, '일'], ['제한2', 6, 1, '개월'], ['제한3', 9, '', '영구']];
var SEMESTER_DEFAULT = [['2026-1학기', '2026-03-01', '2026-06-19'], ['2026-2학기', '2026-08-31', '2026-12-18']];
var CHECK_ITEMS = [
  ['제한 기간 중 예약', 'RESTRICT'], ['영구 제한자 예약', 'PERM'], ['공휴일 예약', 'HOLIDAY'],
  ['중복 예약', 'DUP_RESV'], ['인원 미달', 'PEOPLE'], ['학번 오류', 'STUDENT_ID'],
  ['학번 중복', 'DUP_ID'], ['이름 오류', 'NAME'], ['전화번호 오류', 'PHONE']
];
var HOLIDAY_CAL_ID = 'ko.south_korea#holiday@group.v.calendar.google.com';
var SUPER_ADMIN_DEFAULT_PHONE = '';   // 최고 관리자 전화(숫자만). 비워두면 자동 체크 안 함

function ymd_(s) { var p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }

function setNamed_(ss, name, range) {
  var nr = ss.getNamedRanges().filter(function (n) { return n.getName() === name; })[0];
  if (nr) nr.setRange(range); else ss.setNamedRange(name, range);   // setRange: 이 이름을 쓰는 수식이 그대로 유지됨
}

// ------------------------------------------------------------
//  v8 업그레이드: 운영 시트에서 1회 실행 (새 시트는 setupNewStructure가 마지막에 부름)
// ------------------------------------------------------------
function upgradeToV8() {
  assertSeoulTz_();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getRangeByName('SANCTION_STAGE')) throw new Error('이미 v8 설정 탭입니다.');
  upgradeSettingsV8_(ss);
  rewriteSanctionFormulas_();
  rebuildStatsSheet_(ss);
  upgradeDashboardV8_();
  applyDeleteSmsDropdown_(sheet_(CONFIG.SHEETS.DEL));       // 문자 상태 선택 목록 (이미 있어도 안전)
  applyViolationSmsDropdown_(sheet_(CONFIG.SHEETS.VIO));
  protectSettings_();
  SpreadsheetApp.flush();
  try { refreshStats(); } catch (e) { Logger.log('통계 계산 실패: ' + e.message); }
  Logger.log('✅ v8 완료. 다음: 시트 새로고침 → 메뉴 > SeRMA 관리 > 공휴일 불러오기, 예약 기록 가져오기');
}

function upgradeSettingsV8_(ss) {
  var sh = sheet_(CONFIG.SHEETS.SET);

  // 1) 지금 값 보관
  var keep = {
    sem: named_('CFG_SEMESTER').getValue(),
    min: ss.getRangeByName('CFG_MIN_PEOPLE') ? named_('CFG_MIN_PEOPLE').getValue() : 3,
    url: named_('CFG_DASH_URL').getValue(),
    st: ['ST_AUTOFILL', 'ST_DETECT', 'ST_MAC'].map(function (n) { return named_(n).getValues()[0]; })
  };

  // 2) 관리자 연락처 옆에 '최고 관리자' 열 추가 (F 다음에 한 열 삽입 → 오른쪽 표·이름 범위가 함께 이동)
  sh.insertColumnAfter(6);
  sh.setColumnWidth(7, 90);
  header_(sh.getRange('G4').setValue('최고 관리자'));
  var superRange = sh.getRange('G5:G14');
  superRange.insertCheckboxes();
  var contacts = sh.getRange('E5:F14').getValues();
  contacts.forEach(function (c, i) {
    if (String(c[1]).replace(/\D/g, '') === SUPER_ADMIN_DEFAULT_PHONE) sh.getRange(5 + i, 7).check();
  });
  setNamed_(ss, 'MGR_SUPER', superRange);

  // 3) 왼쪽 A:D 다시 구성
  var area = sh.getRange('A3:D60');
  area.breakApart(); area.clear(); area.clearDataValidations();
  sh.setColumnWidth(1, 220); sh.setColumnWidth(2, 130); sh.setColumnWidth(3, 300); sh.setColumnWidth(4, 70);

  section_(sh.getRange('A3'), '기본 규칙');
  sh.getRange('A4:A6').setValues([['현재 학기 (바꾸면 누적 리셋 → 메뉴 > 학기 전환 사용)'], ['최소 이용 인원 (대표 포함)'], ['대시보드 링크']]);
  sh.getRange('B4').setNumberFormat('@').setValue(keep.sem);
  sh.getRange('B5').setValue(keep.min);
  sh.getRange('B6:D6').merge().setValue(keep.url).setBackground(STYLE.CALC_BG).setFontSize(9);
  setNamed_(ss, 'CFG_SEMESTER', sh.getRange('B4'));
  setNamed_(ss, 'CFG_MIN_PEOPLE', sh.getRange('B5'));
  setNamed_(ss, 'CFG_DASH_URL', sh.getRange('B6'));

  section_(sh.getRange('A8'), '제재 기준 (횟수·기간·단위만 수정, 단계 이름은 그대로)');
  header_(sh.getRange('A9:D9').setValues([['단계', '위반 횟수', '기간', '단위']]));
  sh.getRange('A10:D12').setValues(SANCTION_DEFAULT);
  sh.getRange('A10:A12').setBackground(STYLE.CALC_BG);
  sh.getRange('C12:D12').setBackground(STYLE.CALC_BG);
  sh.getRange('D10:D11').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(['일', '개월'], true).setAllowInvalid(false).build());
  sh.getRange('B10:C11').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireNumberGreaterThan(0).setAllowInvalid(false).build());
  sh.getRange('A13').setValue('제한3 = 영구 제한(계정 삭제). 이 횟수와 같아지는 위반에서 제재가 걸리고, 그 사이 위반은 \'부재\'')
    .setFontColor('#6b7280').setFontSize(9);
  setNamed_(ss, 'SANCTION_STAGE', sh.getRange('A10:A12'));
  setNamed_(ss, 'SANCTION_COUNT', sh.getRange('B10:B12'));
  setNamed_(ss, 'SANCTION_LEN', sh.getRange('C10:C12'));
  setNamed_(ss, 'SANCTION_UNIT', sh.getRange('D10:D12'));

  section_(sh.getRange('A14'), '학기 기간');
  header_(sh.getRange('A15:C15').setValues([['학기', '시작', '종료']]));
  sh.getRange('A16:A23').setNumberFormat('@');
  sh.getRange('B16:C23').setNumberFormat('yyyy-mm-dd (ddd)');
  sh.getRange(16, 1, SEMESTER_DEFAULT.length, 3).setValues(SEMESTER_DEFAULT.map(function (s) { return [s[0], ymd_(s[1]), ymd_(s[2])]; }));
  sh.getRange('A24').setValue('방학 중 위반은 직전 학기로 셈 · 새 학기 시작일에 메뉴 > 학기 전환 (1주 전·당일 이메일 알림)')
    .setFontColor('#6b7280').setFontSize(9);
  setNamed_(ss, 'SEM_NAME', sh.getRange('A16:A23'));
  setNamed_(ss, 'SEM_START', sh.getRange('B16:B23'));
  setNamed_(ss, 'SEM_END', sh.getRange('C16:C23'));
  sh.getRange('B4').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInRange(sh.getRange('A16:A23'), true).setAllowInvalid(false).build());

  section_(sh.getRange('A26'), '예약 검사 항목');
  header_(sh.getRange('A27:C27').setValues([['검사', '사용', '코드']]));
  sh.getRange(28, 1, CHECK_ITEMS.length, 1).setValues(CHECK_ITEMS.map(function (c) { return [c[0]]; }));
  sh.getRange(28, 2, CHECK_ITEMS.length, 1).insertCheckboxes().check();
  sh.getRange(28, 3, CHECK_ITEMS.length, 1).setValues(CHECK_ITEMS.map(function (c) { return [c[1]]; }))
    .setFontColor('#9ca3af').setFontSize(9);
  setNamed_(ss, 'CHECK_LIST', sh.getRange(28, 1, CHECK_ITEMS.length, 3));

  section_(sh.getRange('A38'), '시스템 상태 (스크립트가 기록)');
  sh.getRange('A39:A41').setValues([['자동 입력 (Apps Script)'], ['예약 검사 (Apps Script)'], ['SeSMA 문자 발송 (Python)']]);
  sh.getRange('B39:C41').setValues(keep.st).setBackground(STYLE.CALC_BG);
  sh.getRange('B39:B41').setNumberFormat('m/d hh:mm');
  sh.getRange('C39:C41').setFontSize(9);
  setNamed_(ss, 'ST_AUTOFILL', sh.getRange('B39:C39'));
  setNamed_(ss, 'ST_DETECT', sh.getRange('B40:C40'));
  setNamed_(ss, 'ST_MAC', sh.getRange('B41:C41'));
}

// 위반 기록 구분·제한 만료 수식을 제재 기준 표로 계산하게 변경
function rewriteSanctionFormulas_() {
  var vio = sheet_(CONFIG.SHEETS.VIO);
  vio.getRange('J1').setFormula('={"구분"; ARRAYFORMULA(IF(I2:I="",, IFERROR(VLOOKUP(I2:I, {SANCTION_COUNT, SANCTION_STAGE}, 2, FALSE), "부재")))}');
  vio.getRange('L1').setFormula('={"제한 만료"; ARRAYFORMULA(IFERROR(IF((J2:J="")+(J2:J="부재")+(J2:J="제한3"),, '
    + 'IF(VLOOKUP(J2:J, {SANCTION_STAGE, SANCTION_UNIT}, 2, FALSE)="개월", '
    + 'EDATE(K2:K, VLOOKUP(J2:J, {SANCTION_STAGE, SANCTION_LEN}, 2, FALSE)), '
    + 'K2:K+VLOOKUP(J2:J, {SANCTION_STAGE, SANCTION_LEN}, 2, FALSE))), ))}');
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ['CFG_CYCLE', 'CFG_DAYS1', 'CFG_MONTHS2'].forEach(function (n) { if (ss.getRangeByName(n)) ss.removeNamedRange(n); });
}

// 설정 탭 보호: 본인만 편집 (SeSMA가 쓰는 칸은 예외)
function protectSettings_() {
  var sh = sheet_(CONFIG.SHEETS.SET);
  sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(function (p) { p.remove(); });
  var p = sh.protect().setDescription('설정 탭: 최고 관리자만 편집');
  p.setUnprotectedRanges([named_('ST_MAC')]);   // SeSMA(서비스 계정)가 하트비트를 써야 함
  var me = Session.getEffectiveUser();
  p.addEditor(me);
  p.removeEditors(p.getEditors().filter(function (u) { return u.getEmail() !== me.getEmail(); }));
  if (p.canDomainEdit()) p.setDomainEdit(false);
}

// ------------------------------------------------------------
//  예약 검사 켜기·끄기 (RestrictedCheck.gs에서 사용)
// ------------------------------------------------------------
function enabledChecks_() {
  var on = {};
  CHECK_ITEMS.forEach(function (c) { on[c[1]] = true; });   // 표가 없으면 전부 켜짐
  try {
    named_('CHECK_LIST').getValues().forEach(function (r) { if (r[2]) on[String(r[2])] = r[1] === true; });
  } catch (e) {}
  return on;
}

function checkEnabled_(on, code) {
  if (code === 'RESTRICT1' || code === 'RESTRICT2') return on.RESTRICT !== false;
  return on[code] !== false;
}

// ------------------------------------------------------------
//  학기
// ------------------------------------------------------------
function semesters_() {
  var out = [];
  try {
    var n = named_('SEM_NAME').getValues(), s = named_('SEM_START').getValues(), e = named_('SEM_END').getValues();
    n.forEach(function (r, i) {
      if (String(r[0]).trim() && s[i][0] instanceof Date) {
        out.push({ name: String(r[0]).trim(), start: dateOnly_(s[i][0]), end: e[i][0] instanceof Date ? dateOnly_(e[i][0]) : null });
      }
    });
  } catch (err) {}
  return out.sort(function (a, b) { return a.start - b.start; });
}

// 오늘 기준 '현재 학기'(가장 최근에 시작한 학기 = 방학은 직전 학기), 다음 학기
function semesterNow_(today) {
  today = dateOnly_(today || new Date());
  var list = semesters_(), cur = null, next = null;
  list.forEach(function (s) { if (s.start <= today) cur = s; else if (!next) next = s; });
  return { cur: cur, next: next, list: list };
}

// 매일 00:05 자동 입력 뒤에 호출: 1주 전·시작일·그 뒤 3일마다(전환 안 했으면) 이메일
function checkSemesterAlert_() {
  var today = dateOnly_(new Date());
  var info = semesterNow_(today);
  var setting = String(named_('CFG_SEMESTER').getValue()).trim();
  var props = PropertiesService.getScriptProperties();
  var key = 'TERM_ALERT_' + Utilities.formatDate(today, 'Asia/Seoul', 'yyyyMMdd');
  if (props.getProperty(key)) return;
  var url = SpreadsheetApp.getActiveSpreadsheet().getUrl();
  var subject = '', body = '';

  if (info.next && Math.round((info.next.start - today) / 86400000) === 7) {
    subject = '[세미나실] 1주 뒤 ' + info.next.name + ' 시작';
    body = info.next.name + '이(가) ' + Utilities.formatDate(info.next.start, 'Asia/Seoul', 'M/d') + '에 시작합니다.\n'
      + '시작일에 관리 시트에서 메뉴 > SeRMA 관리 > 학기 전환을 실행해주세요.\n' + url;
  } else if (info.cur && info.cur.name !== setting) {
    var days = Math.round((today - info.cur.start) / 86400000);
    if (days % 3 === 0) {
      subject = '[세미나실] 학기 전환 필요: ' + setting + ' → ' + info.cur.name;
      body = info.cur.name + '이(가) ' + Utilities.formatDate(info.cur.start, 'Asia/Seoul', 'M/d') + '에 시작했지만 설정은 아직 ' + setting + '입니다.\n'
        + '메뉴 > SeRMA 관리 > 학기 전환을 실행하면 위반 기록이 아카이브로 옮겨지고 누적이 리셋됩니다.\n' + url;
    }
  }
  if (!subject) return;
  MailApp.sendEmail(Session.getEffectiveUser().getEmail(), subject, body);
  props.setProperty(key, '1');
  log('학기 알림 이메일: ' + subject);
}

// 메뉴: 학기 전환
function menuSwitchSemester() {
  var ui = SpreadsheetApp.getUi();
  var info = semesterNow_();
  var setting = String(named_('CFG_SEMESTER').getValue()).trim();
  var target = info.cur && info.cur.name !== setting ? info.cur.name : (info.next ? info.next.name : '');
  var res = ui.prompt('학기 전환',
    '현재 설정: ' + setting + '\n전환할 학기 이름을 확인해주세요.\n\n'
    + '· 위반 기록 탭의 행이 아카이브로 옮겨지고 누적 횟수가 리셋됩니다.\n'
    + '· 진행 중인 제한은 아카이브에서도 계속 감지됩니다.', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  var name = res.getResponseText().trim() || target;
  if (!name) { ui.alert('학기 이름이 없습니다. 설정 탭 학기 기간 표를 확인해주세요.'); return; }
  if (!semesters_().some(function (s) { return s.name === name; })) {
    ui.alert('"' + name + '"은(는) 설정 탭 학기 기간 표에 없습니다. 먼저 표에 추가해주세요.'); return;
  }
  if (name === setting) { ui.alert('이미 ' + name + '입니다.'); return; }
  startNewSemester(name);
  try { refreshStats(); } catch (e) {}
  ui.alert('✅ ' + name + '(으)로 전환했습니다.');
}

// ------------------------------------------------------------
//  로테이션 채우기: 마지막 주 다음부터 관리자 연락처 순서대로 이어서
// ------------------------------------------------------------
function menuFillRotation() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt('로테이션 채우기', '몇 주를 더 채울까요? (관리자 연락처 순서대로 이어서 채움)', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  var n = parseInt(res.getResponseText(), 10) || 8;
  var added = fillRotation_(n);
  ui.alert('✅ ' + added + '주 추가했습니다.');
}

function fillRotation_(weeks) {
  var starts = named_('ROT_START'), mgrs = named_('ROT_MGR');
  var sv = starts.getValues(), mv = mgrs.getValues();
  var names = named_('MGR_CONTACTS').getValues().map(function (r) { return String(r[0]).trim(); }).filter(String);
  if (!names.length) throw new Error('관리자 연락처가 비어 있습니다.');
  var last = -1;
  sv.forEach(function (r, i) { if (r[0] instanceof Date) last = i; });
  var nextStart, idx;
  if (last < 0) {
    nextStart = dateOnly_(new Date()); nextStart.setDate(nextStart.getDate() - ((nextStart.getDay() + 6) % 7)); // 이번 주 월요일
    idx = 0;
  } else {
    nextStart = dateOnly_(sv[last][0]); nextStart.setDate(nextStart.getDate() + 7);
    idx = (names.indexOf(String(mv[last][0]).trim()) + 1) % names.length;
  }
  var room = sv.length - (last + 1), n = Math.min(weeks, room);
  if (n <= 0) throw new Error('로테이션 표에 빈 칸이 없습니다.');
  var addS = [], addM = [];
  for (var w = 0; w < n; w++) {
    var d = new Date(nextStart); d.setDate(d.getDate() + 7 * w);
    addS.push([d]); addM.push([names[(idx + w) % names.length]]);
  }
  starts.offset(last + 1, 0, n, 1).setValues(addS);
  mgrs.offset(last + 1, 0, n, 1).setValues(addM);
  return n;
}

// ------------------------------------------------------------
//  공휴일 불러오기: 구글 캘린더 '대한민국의 휴일'에서 오늘~1년 뒤, 일요일 제외, 기념일 제외
// ------------------------------------------------------------
function menuImportHolidays() {
  var r = importHolidays_();
  SpreadsheetApp.getUi().alert('✅ 공휴일 ' + r.added + '개 추가 (이미 있음 ' + r.skipped + '개, 일요일·기념일 제외 ' + r.excluded + '개)\n'
    + '학교 자체 휴일은 직접 추가해주세요.');
}

function importHolidays_() {
  var cal = CalendarApp.getCalendarById(HOLIDAY_CAL_ID);
  if (!cal) {
    CalendarApp.subscribeToCalendar(HOLIDAY_CAL_ID);
    cal = CalendarApp.getCalendarById(HOLIDAY_CAL_ID);
  }
  if (!cal) throw new Error('대한민국 공휴일 캘린더를 열 수 없습니다.');
  var from = dateOnly_(new Date()), to = new Date(from); to.setFullYear(to.getFullYear() + 1);
  var range = named_('HOLIDAYS'), vals = range.getValues();
  var have = {}, lastIdx = -1;
  vals.forEach(function (r, i) { if (r[0] instanceof Date) { have[dateOnly_(r[0]).getTime()] = true; lastIdx = i; } });
  var res = { added: 0, skipped: 0, excluded: 0 }, rows = [];
  cal.getEvents(from, to).forEach(function (ev) {
    var desc = String(ev.getDescription() || '');
    if (/기념일|Observance/i.test(desc)) { res.excluded++; return; }
    var d = dateOnly_(ev.isAllDayEvent() ? ev.getAllDayStartDate() : ev.getStartTime());
    if (d.getDay() === 0) { res.excluded++; return; }
    if (have[d.getTime()]) { res.skipped++; return; }
    have[d.getTime()] = true;
    rows.push([d, ev.getTitle()]);
  });
  if (rows.length) {
    if (lastIdx + 1 + rows.length > vals.length) throw new Error('공휴일 표 칸이 부족합니다.');
    range.offset(lastIdx + 1, 0, rows.length, 2).setValues(rows);
    // 날짜순 정렬
    var used = range.offset(0, 0, lastIdx + 1 + rows.length, 2);
    used.sort({ column: used.getColumn(), ascending: true });
    res.added = rows.length;
  }
  return res;
}
