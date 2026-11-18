// ============================================================
//  버전 기록 (최신이 위)
//  v8.2p  2026-11-19  공개판: 예약 사이트 주소를 예시 값으로
//  v8.2  2026-10-22  정리: 옛 이름 relayoutDashboard, v3 업그레이드용 ensureSettingsV3_ 삭제
//                    (v8 설정 탭에서는 A14를 지워버릴 수 있어 위험)
//  v8.1  2026-10-22  시스템 상태 라벨 SeRMA → SeSMA (SeRMA = 시스템 전체, SeSMA = 문자 발송)
//  v8.0  2026-10-22  F2에 학기 전환 안내 (전환 필요 시 빨간색, 새 학기 1주 전 예고)
//  v6.1  2026-10-22  예약 검사 매시간 실행에 맞춰 '지연' 기준 7.2시간 → 3.6시간
//  v6.0  2026-10-22  목록 줄 수 자동 조절: 기본 10줄, 넘치면 5줄 단위(15·20·25)로 늘리고 줄어들면 다시 줄임,
//                    상한 25줄(넘으면 '+N건 더' 안내). 행 삽입·삭제로 조절해서 열 너비·정렬·글꼴·색 등
//                    직접 바꾼 서식이 그대로 유지됨. rebuildDashboard()는 탭을 지우지 않고 그 자리에서 다시 그림
//                    (대시보드 링크 유지). v5.3 배치는 그대로 이어받음
//  v5.3  2026-10-22  목록 줄 수 15줄, 시트 80행까지 유지
//  v5.2  2026-10-22  v4 배치로 되돌리고 삭제할 예약 아래에 문자 발송 문제 배치, 목록 줄 수 제한, 빈 행 삭제
//  v5.0  2026-10-22  (폐기) 노트북 한 화면 배치 시도
//  v4.0  2026-10-16  시스템 상태 순서(자동 입력/예약 검사/SeRMA), 6~7행 비움, 블록 위치 조정
//  v3.0  2026-10-15  대시보드 오른쪽 배치 분리 + 내용 있는 행만 자동 테두리
// ============================================================

// ============================================================
//  Dashboard.gs - 대시보드
//
//   1행    제목 (A:E) · 기준 시각 (F)          |  2~6행 시스템 상태 (H:L)
//   2행    사이트 바로가기 (A:E)
//   3~5행  카드 5개 (A:E)                       (1~6행 고정)
//   위 영역  (8행 제목, 9행 머리글, 10행부터 U줄)
//      왼쪽: 삭제할 예약 (A:F)                  |  오른쪽: 현재 제한자 (H:L)
//      10+U행: "+N건 더 있음" (25건 넘을 때만)
//   아래 영역 (제목 10+U+1행, 머리글 +2, 데이터 +3부터 W줄)
//      왼쪽: 문자 발송 문제 (A:E)                |  오른쪽: 오늘 기록된 위반 (H:L)
//
//  줄 수 U·W: 같은 영역 두 목록 중 많은 쪽 기준으로 10 → 15 → 20 → 25 (5줄 단위, 상한 25)
//  줄 수가 바뀌면 행을 '삽입·삭제'해서 맞춤 → 서식은 건드리지 않음
//  현재 줄 수는 대시보드 탭의 개발자 메타데이터(DASH_LAYOUT)에 저장
//
//  실행 시점: refreshDashboardBorders()가 부를 때마다 확인 (자동 실행 끝, 삭제 처리 상태 변경, 10분마다)
// ============================================================

var DASH = {
  SITE_URL: 'https://YOUR-RESERVATION-SITE.example/',   // 예약 사이트 주소
  //       A    B    C    D    E    F    G   H    I    J    K    L      (탭을 처음 만들 때만 적용)
  WIDTHS: [150, 140, 110, 150, 160, 320, 30, 140, 125, 110, 110, 110],
  FREEZE_ROWS: 6,
  INITIAL_ROWS: 80,      // 처음 만들 때 시트 행 수
  MIN_ROWS: 10, STEP: 5, MAX_ROWS: 25,
  UP_FIRST: 10,          // 위 영역 데이터 시작 행 (제목 8, 머리글 9)
  // [표시 이름, 설정 탭 상태 칸, 지연 판단 기준(일)]
  SYS: [
    ['자동 입력', 'ST_AUTOFILL', 1.1],
    ['예약 검사', 'ST_DETECT', 0.15],   // 매시간 실행, 밤 공백 최대 3시간 → 3.6시간 넘으면 지연
    ['SeSMA', 'ST_MAC', 0.3]   // 매시간 실행, 밤 23~5시 공백(6시간)보다 길면 지연
  ],
  BORDER: '#cbd5e1',
  META_KEY: 'DASH_LAYOUT'
};

var FAIL_RE_ = '"^(실패|멈춤|확인 불가|기한 지남|번호 없음)$"';
var DV_ = "'위반 기록'!", DD_ = "'삭제 처리'!";
var ACTIVE_ = DV_ + 'L2:L>=TODAY(), ' + DV_ + 'K2:K<=TODAY()';
var WAIT_ = '(' + DD_ + 'H2:H="대기")';

// ------------------------------------------------------------
//  위치 계산
// ------------------------------------------------------------
function dashPos_(U, W) {
  var up = DASH.UP_FIRST;
  return {
    upFirst: up, note: up + U,
    lowTitle: up + U + 1, lowHead: up + U + 2, lowFirst: up + U + 3, lowEnd: up + U + 3 + W - 1
  };
}

function dashBucket_(n) {
  n = Number(n) || 0;
  var b = Math.ceil(n / DASH.STEP) * DASH.STEP;
  return Math.min(DASH.MAX_ROWS, Math.max(DASH.MIN_ROWS, b));
}

// 목록 수식 (줄 수 n에 따라 달라지는 부분)
function dashListFormula_(kind, n) {
  var V = DV_, D = DD_;
  if (kind === 'DEL') return '=IFERROR(ARRAY_CONSTRAIN(SORT(FILTER({' + D + 'A2:A, ' + D + 'B2:B, ' + D + 'C2:C, '
    + D + 'D2:D, ' + D + 'E2:E, ' + D + 'L2:L}, ' + WAIT_ + '), 1, TRUE, 2, TRUE), ' + n + ', 6), "✅ 없음")';
  if (kind === 'RESTRICT') return '=IFERROR(ARRAY_CONSTRAIN(SORT(FILTER({' + V + 'F2:F, ' + V + 'J2:J, ' + V + 'K2:K, '
    + V + 'L2:L, ' + V + 'L2:L-TODAY()}, ' + ACTIVE_ + '), 4, TRUE), ' + n + ', 5), "✅ 없음")';
  if (kind === 'SMS') {
    var blank5 = '{"","","","",""}';
    return '=IFERROR(ARRAY_CONSTRAIN(QUERY({'
      + 'IFERROR(FILTER({IF(' + V + 'F2:F="",,"위반 안내"), ' + V + 'B2:B, ' + V + 'F2:F, ' + V + 'N2:N, ' + V + 'G2:G}, REGEXMATCH(' + V + 'N2:N&"", ' + FAIL_RE_ + ')), ' + blank5 + ');'
      + 'IFERROR(FILTER({IF(' + D + 'D2:D="",,"삭제 안내"), ' + D + 'A2:A, ' + D + 'D2:D, ' + D + 'N2:N, ' + D + 'E2:E}, REGEXMATCH(' + D + 'N2:N&"", ' + FAIL_RE_ + ')), ' + blank5 + ')'
      + '}, "select * where Col3 <> \'\' order by Col2 desc", 0), ' + n + ', 5), "✅ 없음")';
  }
  if (kind === 'VIO') return '=IFERROR(ARRAY_CONSTRAIN(FILTER({' + V + 'F2:F, ' + V + 'E2:E, ' + V + 'I2:I, '
    + V + 'J2:J, ' + V + 'N2:N}, ' + V + 'B2:B=TODAY()), ' + n + ', 5), "✅ 없음")';
}

function writeListFormulas_(sh, U, W) {
  var p = dashPos_(U, W);
  sh.getRange(p.upFirst, 1).setFormula(dashListFormula_('DEL', U));
  sh.getRange(p.upFirst, 8).setFormula(dashListFormula_('RESTRICT', U));
  sh.getRange(p.lowFirst, 1).setFormula(dashListFormula_('SMS', W));
  sh.getRange(p.lowFirst, 8).setFormula(dashListFormula_('VIO', W));
}

// ------------------------------------------------------------
//  현재 배치(U, W) 저장·읽기
// ------------------------------------------------------------
function getDashState_(sh) {
  var md = sh.getDeveloperMetadata().filter(function (m) { return m.getKey() === DASH.META_KEY; })[0];
  if (md) {
    try { var s = JSON.parse(md.getValue()); if (s.U && s.W) return s; } catch (e) {}
  }
  // 메타데이터가 없으면 v5.2·v5.3 배치에서 수식으로 추정해서 이어받음
  var f = sh.getRange(DASH.UP_FIRST, 1).getFormula();
  var m = f.match(/,\s*(\d+),\s*6\),\s*"✅ 없음"\)$/);
  if (!m) return null;
  var U = parseInt(m[1], 10);
  var g = sh.getRange(dashPos_(U, 1).lowFirst, 1).getFormula();
  var m2 = g.indexOf('QUERY(') >= 0 && g.match(/,\s*(\d+),\s*5\),\s*"✅ 없음"\)$/);
  if (!m2) return null;
  var st = { U: U, W: parseInt(m2[1], 10) };
  setDashState_(sh, st.U, st.W);
  return st;
}

function setDashState_(sh, U, W) {
  sh.getDeveloperMetadata().forEach(function (m) { if (m.getKey() === DASH.META_KEY) m.remove(); });
  sh.addDeveloperMetadata(DASH.META_KEY, JSON.stringify({ U: U, W: W }));
}

// ------------------------------------------------------------
//  줄 수 자동 조절 (서식 유지: 행 삽입·삭제만 함)
// ------------------------------------------------------------
function ensureDashboardSize_(sh) {
  var st = getDashState_(sh);
  if (!st) return null;
  SpreadsheetApp.flush();
  var v = sh.getRange('A4:D4').getValues()[0];   // 카드: 삭제할 예약, 오늘 기록된 위반, 현재 제한자, 문자 발송 문제
  var U = Math.max(dashBucket_(v[0]), dashBucket_(v[2]));
  var W = Math.max(dashBucket_(v[3]), dashBucket_(v[1]));
  if (U === st.U && W === st.W) return st;

  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(20000)) return st;
  try {
    st = getDashState_(sh);                        // 잠금 사이에 다른 실행이 바꿨을 수 있어 다시 읽음
    if (U !== st.U) {
      // 영역 '안쪽'(첫 데이터 행 다음)에 넣고 빼야 서식·조건부 서식 범위가 같이 따라옴
      if (U > st.U) sh.insertRowsAfter(DASH.UP_FIRST, U - st.U);
      else sh.deleteRows(DASH.UP_FIRST + 1, st.U - U);
    }
    var lowFirst = dashPos_(U, W).lowFirst;
    if (W !== st.W) {
      if (W > st.W) sh.insertRowsAfter(lowFirst, W - st.W);
      else sh.deleteRows(lowFirst + 1, st.W - W);
    }
    writeListFormulas_(sh, U, W);
    // 아래 여유 행이 너무 적으면 보충
    var need = dashPos_(U, W).lowEnd + 10;
    if (sh.getMaxRows() < need) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
    setDashState_(sh, U, W);
    Logger.log('대시보드 줄 수 조절: 위 ' + st.U + '→' + U + ', 아래 ' + st.W + '→' + W);
    return { U: U, W: W };
  } finally {
    lock.releaseLock();
  }
}

// 수동 실행용
function resizeDashboard() {
  var sh = sheet_(CONFIG.SHEETS.DASH);
  var st = ensureDashboardSize_(sh);
  if (!st) throw new Error('대시보드 배치를 알 수 없습니다. rebuildDashboard()를 한 번 실행하세요.');
  refreshDashboardBorders();
}

// ------------------------------------------------------------
//  처음 만들기 / 다시 그리기
//  ※ 탭은 지우지 않고 그 자리에서 다시 그림 (링크 유지, 열 너비 유지)
//  ※ 내용·서식은 초기화되므로 처음 한 번 또는 배치가 꼬였을 때만 사용
//    (줄 수 조절은 resizeDashboard / 자동 실행이 서식을 유지하면서 처리)
// ------------------------------------------------------------
function rebuildDashboard() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(CONFIG.SHEETS.DASH);
  var isNew = !sh;
  if (isNew) sh = ss.insertSheet(CONFIG.SHEETS.DASH, 0);
  drawDashboard_(sh, isNew);
  named_('CFG_DASH_URL').setValue(ss.getUrl() + '#gid=' + sh.getSheetId());
  SpreadsheetApp.flush();
  refreshDashboardBorders();
  Logger.log('✅ 대시보드 다시 그리기 완료');
}


// Setup.gs(setupNewStructure)에서 새 탭을 만들 때 사용
function buildDashboardV5_(ss) {
  var sh = ss.insertSheet(CONFIG.SHEETS.DASH);
  drawDashboard_(sh, true);
  return sh;
}

function drawDashboard_(sh, setWidths) {
  var U = DASH.MIN_ROWS, W = DASH.MIN_ROWS, p = dashPos_(U, W);
  var V = DV_, D = DD_;

  // 초기화 (열 너비는 유지)
  sh.setFrozenRows(0);
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).breakApart();
  sh.clear();
  sh.clearConditionalFormatRules();
  sh.getDeveloperMetadata().forEach(function (m) { if (m.getKey() === DASH.META_KEY) m.remove(); });
  if (sh.getMaxRows() > DASH.INITIAL_ROWS) sh.deleteRows(DASH.INITIAL_ROWS + 1, sh.getMaxRows() - DASH.INITIAL_ROWS);
  if (sh.getMaxRows() < DASH.INITIAL_ROWS) sh.insertRowsAfter(sh.getMaxRows(), DASH.INITIAL_ROWS - sh.getMaxRows());
  if (setWidths) DASH.WIDTHS.forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  sh.setHiddenGridlines(true);
  sh.getRange(1, 1, DASH.INITIAL_ROWS, 12).setVerticalAlignment('middle');

  // ── 1~2행 ──
  sh.getRange('A1:E1').merge().setValue('세미나실 관리 대시보드')
    .setBackground(STYLE.HEAD_BG).setFontColor(STYLE.HEAD_FG).setFontSize(18).setFontWeight('bold')
    .setHorizontalAlignment('center');
  sh.getRange('A2:E2').merge().setFormula('=HYPERLINK("' + DASH.SITE_URL + '", "세미나실 사이트 바로가기")')
    .setHorizontalAlignment('center');
  sh.getRange('F1').setFormula('="기준 "&TEXT(NOW(), "m/d (ddd) hh:mm")').setFontColor('#6b7280');
  sh.setRowHeight(1, 40);
  setSemesterNotice_(sh);

  // ── 3~5행: 카드 (A4~D4 값은 줄 수 조절에도 쓰이므로 위치 고정) ──
  var cards = [
    ['삭제할 예약', '=COUNTIF(' + D + 'H2:H, "대기")',
      '="제한 "&SUMPRODUCT(' + WAIT_ + '*REGEXMATCH(' + D + 'M2:M&"", "RESTRICT|PERM"))'
      + '&" · 정보 "&SUMPRODUCT(' + WAIT_ + '*REGEXMATCH(' + D + 'M2:M&"", "PEOPLE|STUDENT_ID|DUP_ID|NAME|PHONE"))'
      + '&" · 중복 "&SUMPRODUCT(' + WAIT_ + '*REGEXMATCH(' + D + 'M2:M&"", "DUP_RESV"))'
      + '&" · 공휴일 "&SUMPRODUCT(' + WAIT_ + '*REGEXMATCH(' + D + 'M2:M&"", "HOLIDAY"))'],
    ['오늘 기록된 위반', '=COUNTIF(' + V + 'B2:B, TODAY())', '=TEXT(TODAY()-1, "m/d")&" 미체크아웃"'],
    ['현재 제한자', '=IFERROR(ROWS(FILTER(' + V + 'F2:F, ' + ACTIVE_ + ')), 0)', '="영구 제한 "&COUNTA(INDEX(PERM_LIST, 0, 1))&"명"'],
    ['문자 발송 문제',
      '=SUMPRODUCT(--REGEXMATCH(' + V + 'N2:N&"", ' + FAIL_RE_ + '))+SUMPRODUCT(--REGEXMATCH(' + D + 'N2:N&"", ' + FAIL_RE_ + '))',
      '="직접 보낸 뒤 상태를 \'수동 발송\'으로"'],
    ['이번 주 담당', '=IFERROR(VLOOKUP(TODAY(), {ROT_START, ROT_MGR}, 2, TRUE), "미지정")',
      '=IFERROR("다음: "&INDEX(ROT_MGR, MATCH(TODAY(), ROT_START, 1)+1)&" ("&TEXT(INDEX(ROT_START, MATCH(TODAY(), ROT_START, 1)+1), "m/d")&"~)", "")']
  ];
  cards.forEach(function (c, i) {
    var col = i + 1;
    sh.getRange(3, col).setValue(c[0]).setFontColor('#6b7280');
    sh.getRange(4, col).setFormula(c[1]).setFontSize(26).setFontWeight('bold');
    sh.getRange(5, col).setFormula(c[2]).setFontColor('#6b7280').setFontSize(9).setWrap(true);
    sh.getRange(3, col, 3, 1).setBackground(STYLE.CARD_BG).setHorizontalAlignment('center')
      .setBorder(true, true, true, true, false, false, STYLE.BORDER, SpreadsheetApp.BorderStyle.SOLID);
  });
  sh.getRange('E4').setFontSize(20);
  sh.setRowHeight(4, 48);

  function title(row, col, formulaOrText) {
    var r = sh.getRange(row, col);
    if (String(formulaOrText).charAt(0) === '=') r.setFormula(formulaOrText); else r.setValue(formulaOrText);
    r.setFontWeight('bold').setFontSize(12);
  }
  function head(row, col, heads) {
    sh.getRange(row, col, 1, heads.length).setValues([heads])
      .setBackground(STYLE.HEAD_BG).setFontColor(STYLE.HEAD_FG).setFontWeight('bold');
  }
  var MAX = DASH.MAX_ROWS;
  function more(countCell) { return '&IF(' + countCell + '>' + MAX + ', "  (위 ' + MAX + '건만 표시)", "")'; }
  var rules = [];

  // ── 시스템 상태 (H2:L6) ──
  sh.getRange('H2').setValue('시스템 상태').setFontWeight('bold').setFontSize(12);
  head(3, 8, ['작업', '마지막 실행', '상태', '결과']);
  DASH.SYS.forEach(function (x, i) {
    var r = 4 + i;
    sh.getRange(r, 8).setValue(x[0]);
    sh.getRange(r, 9).setFormula('=IFERROR(INDEX(' + x[1] + ', 1, 1), "")').setNumberFormat('m/d hh:mm');
    sh.getRange(r, 10).setFormula('=IF(I' + r + '="", "⚪ 기록 없음", IF(LEFT(K' + r + ', 2)="실패", "🔴 실패", IF(NOW()-I' + r + '>' + x[2] + ', "🔴 지연", "🟢 정상")))');
    sh.getRange(r, 11, 1, 2).merge().setFormula('=IFERROR(INDEX(' + x[1] + ', 1, 2), "")').setFontSize(9).setWrap(true);
  });
  sh.getRange(3, 11, 1, 2).merge();
  sh.getRange(3, 8, 4, 5).setBorder(true, true, true, true, true, true, DASH.BORDER, SpreadsheetApp.BorderStyle.SOLID);
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('🔴')
    .setBackground(STYLE.RED_BG).setFontColor(STYLE.RED_FG).setRanges([sh.getRange('J4:J6')]).build());

  // ── 위 영역: 삭제할 예약 (A:F) / 현재 제한자 (H:L) ──
  title(8, 1, '="삭제할 예약 ("&A4&"건)  ·  사이트에서 삭제 후 삭제 처리 탭 상태를 \'완료\'로"');
  head(9, 1, ['예약일', '시간', '호실', '이름', '전화', '사유']);
  sh.getRange(p.upFirst, 1, U, 1).setNumberFormat('m/d (ddd)').setHorizontalAlignment('left');
  sh.getRange(p.note, 1, 1, 6).merge()
    .setFormula('=IF(A4>' + MAX + ', "+"&(A4-' + MAX + ')&"건 더 있음 → \'삭제 처리\' 탭에서 확인", "")')
    .setFontColor(STYLE.RED_FG).setFontWeight('bold');
  var a = '$A' + p.upFirst;
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=AND(ISNUMBER(' + a + '), ' + a + '<TODAY()+2)')
    .setFontColor(STYLE.RED_FG).setBold(true).setRanges([sh.getRange(p.upFirst, 1, U, 6)]).build()); // 오늘·내일 예약 강조

  title(8, 8, '="현재 제한자 ("&C4&"명)"' + more('C4'));
  head(9, 8, ['이름', '구분', '시작', '만료', '남은 기간']);
  sh.getRange(p.upFirst, 10, U, 2).setNumberFormat('m/d');
  sh.getRange(p.upFirst, 12, U, 1).setNumberFormat('"D-"0');

  // ── 아래 영역: 문자 발송 문제 (A:E) / 오늘 기록된 위반 (H:L) ──
  title(p.lowTitle, 1, '="문자 발송 문제 ("&D4&"건)"' + more('D4'));
  head(p.lowHead, 1, ['종류', '날짜', '이름', '상태', '전화']);
  sh.getRange(p.lowFirst, 2, W, 1).setNumberFormat('m/d').setHorizontalAlignment('left');

  title(p.lowTitle, 8, '="오늘 기록된 위반 ("&B4&"명)"' + more('B4'));
  head(p.lowHead, 8, ['이름', '호실', 'n번째', '구분', '문자 상태']);
  sh.getRange(p.lowFirst, 10, W, 1).setNumberFormat('0"회"');
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('제한')
    .setFontColor(STYLE.RED_FG).setBold(true).setRanges([sh.getRange(p.lowFirst, 11, W, 1)]).build());

  // ── 카드 색 ──
  [sh.getRange('A4'), sh.getRange('D4')].forEach(function (r) {
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(0)
      .setBackground(STYLE.RED_BG).setFontColor(STYLE.RED_FG).setRanges([r]).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenNumberEqualTo(0)
      .setBackground(STYLE.GREEN_BG).setFontColor(STYLE.GREEN_FG).setRanges([r]).build());
  });
  sh.setConditionalFormatRules(rules);
  addSemesterNoticeRule_(sh);

  writeListFormulas_(sh, U, W);
  setDashState_(sh, U, W);
  sh.setFrozenRows(DASH.FREEZE_ROWS);
}

// ------------------------------------------------------------
//  F2: 학기 전환 안내 (설정 탭 학기 기간 표 기준)
// ------------------------------------------------------------
var SEM_NOTICE_FORMULA_ = '=IFERROR(LET('
  + 'cur, INDEX(SORT(FILTER({SEM_START, SEM_NAME}, SEM_NAME<>"", SEM_START<=TODAY()), 1, FALSE), 1, 2), '
  + 'IF(cur<>CFG_SEMESTER, "⚠️ 학기 전환 필요: "&CFG_SEMESTER&" → "&cur&" (메뉴 > SeRMA 관리 > 학기 전환)", '
  + 'IFERROR(LET(nx, SORT(FILTER({SEM_START, SEM_NAME}, SEM_NAME<>"", SEM_START>TODAY()), 1, TRUE), '
  + 'IF(INDEX(nx, 1, 1)-TODAY()<=7, "📅 "&TEXT(INDEX(nx, 1, 1), "m/d")&" "&INDEX(nx, 1, 2)&" 시작 예정", "")), ""))), "")';

function setSemesterNotice_(sh) {
  sh.getRange('F2').setFormula(SEM_NOTICE_FORMULA_).setFontSize(10).setFontWeight('bold').setFontColor('#6b7280');
}

function addSemesterNoticeRule_(sh) {
  var rules = sh.getConditionalFormatRules().filter(function (r) {
    return !r.getRanges().some(function (g) { return g.getA1Notation() === 'F2'; });
  });
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('⚠️')
    .setBackground(STYLE.RED_BG).setFontColor(STYLE.RED_FG).setRanges([sh.getRange('F2')]).build());
  sh.setConditionalFormatRules(rules);
}

// v8: 지금 대시보드에 학기 안내만 추가 (다른 서식은 건드리지 않음)
function upgradeDashboardV8_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEETS.DASH);
  if (!sh) return;
  setSemesterNotice_(sh);
  addSemesterNoticeRule_(sh);
}

// ------------------------------------------------------------
//  줄 수 확인 + 내용 있는 행까지만 테두리
//  (자동 실행 끝, 삭제 처리 상태 변경, 10분마다 호출됨)
// ------------------------------------------------------------
function refreshDashboardBorders() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEETS.DASH);
  if (!sh) return;
  var st;
  try { st = ensureDashboardSize_(sh); } catch (e) { Logger.log('줄 수 조절 실패: ' + e.message); st = getDashState_(sh); }
  if (!st) return;   // 예전 배치 → rebuildDashboard() 필요
  var p = dashPos_(st.U, st.W);
  [[p.upFirst, 1, st.U, 6], [p.upFirst, 8, st.U, 5], [p.lowFirst, 1, st.W, 5], [p.lowFirst, 8, st.W, 5]]
    .forEach(function (b) {
      var rg = sh.getRange(b[0], b[1], b[2], b[3]);
      var vals = rg.getDisplayValues();
      var n = 0;
      for (var i = vals.length - 1; i >= 0; i--) {
        if (vals[i].some(function (x) { return x !== ''; })) { n = i + 1; break; }
      }
      rg.setBorder(false, false, false, false, false, false);
      if (n) {
        sh.getRange(b[0], b[1], n, b[3])
          .setBorder(true, true, true, true, true, true, DASH.BORDER, SpreadsheetApp.BorderStyle.SOLID);
      }
    });
}
