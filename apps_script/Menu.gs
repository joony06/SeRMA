// ============================================================
//  버전 기록 (최신이 위)
//  v8.2  2026-10-22  메뉴 함수 이름 정리 (menuImportOldSemester)
//  v8.1  2026-10-22  '이전 학기 위반 기록 가져오기'(시트 링크 입력), '가져온 기록 되돌리기' 추가
//  v8.0  2026-10-22  'SeRMA 관리' 메뉴 신규
// ============================================================

// ============================================================
//  Menu.gs - 시트를 열면 상단에 'SeRMA 관리' 메뉴가 생김
// ============================================================

function onOpen() {
  SpreadsheetApp.getUi().createMenu('SeRMA 관리')
    .addItem('통계 새로고침', 'refreshStats')
    .addSeparator()
    .addItem('로테이션 채우기…', 'menuFillRotation')
    .addItem('공휴일 불러오기', 'menuImportHolidays')
    .addItem('학기 전환…', 'menuSwitchSemester')
    .addSeparator()
    .addItem('대시보드 줄 수 맞추기', 'resizeDashboard')
    .addItem('대시보드 다시 그리기 (서식 초기화)…', 'menuRebuildDashboard')
    .addSeparator()
    .addItem('예약 검사 지금 실행', 'checkReservations')
    .addItem('예약 기록 가져오기 (사이트에 남은 예약)', 'backfillReservations')
    .addItem('이전 학기 위반 기록 가져오기…', 'menuImportOldSemester')
    .addItem('가져온 기록 되돌리기…', 'menuUndoImport')
    .addToUi();
}

function menuRebuildDashboard() {
  var ui = SpreadsheetApp.getUi();
  var ok = ui.alert('대시보드 다시 그리기', '대시보드의 직접 꾸민 서식(열 너비 제외)이 초기화됩니다. 계속할까요?', ui.ButtonSet.OK_CANCEL);
  if (ok === ui.Button.OK) rebuildDashboard();
}
