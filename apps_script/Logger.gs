// ============================================================
//  버전 기록 (최신이 위)
//  v4.1  2026-10-16  로그 요약·상세 앞에 ' 추가 ('='로 시작하면 #ERROR 나던 문제)
//  v3.0  2026-10-15  실행 끝날 때 대시보드 테두리 갱신
//  v1.0  2026-10-15  실행당 로그 1줄 요약 + 설정 탭 시스템 상태 기록
// ============================================================

// ============================================================
//  Logger.gs - 실행 기록
//  실행당 '로그' 탭에 1줄만 남기고, 마지막 실행 시각과 결과를
//  설정 탭(시스템 상태)에 찍어서 대시보드가 읽게 합니다.
// ============================================================

var RUN_LOG_ = [];
var LOG_MAX_ROWS = 1500;   // 넘으면 오래된 것부터 정리

function log(msg) {
  Logger.log(msg);
  RUN_LOG_.push(String(msg));
}

/**
 * 실행 결과 기록
 * @param {string} task      작업 이름 (예: '자동 입력')
 * @param {boolean} ok       성공 여부
 * @param {string} summary   한 줄 요약
 * @param {Date} start       시작 시각
 * @param {string} statusRange 설정 탭 상태 칸 이름 (ST_AUTOFILL / ST_DETECT), 없으면 생략
 */
function finishRun_(task, ok, summary, start, statusRange) {
  var now = new Date();
  var secs = Math.round((now - start) / 100) / 10;
  try {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEETS.LOG);
    if (sh) {
      var detail = RUN_LOG_.join(' / ');
      if (detail.length > 1000) detail = detail.substring(0, 1000) + '…';
      sh.appendRow([now, task, ok ? '성공' : '실패', secs, "'" + summary, "'" + detail]); // ' 붙여서 '='로 시작해도 수식으로 안 읽히게
      var last = sh.getLastRow();
      if (last > LOG_MAX_ROWS) sh.deleteRows(2, last - LOG_MAX_ROWS + 200);
    }
  } catch (e) { Logger.log('로그 기록 실패: ' + e.message); }

  if (statusRange) {
    try {
      named_(statusRange).setValues([[now, (ok ? '성공: ' : '실패: ') + summary]]);
    } catch (e) { Logger.log('상태 기록 실패: ' + e.message); }
  }
  try { refreshDashboardBorders(); } catch (e) { Logger.log('테두리 갱신 실패: ' + e.message); }
  RUN_LOG_ = [];
}
