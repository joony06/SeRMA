// ============================================================
//  버전 기록 (최신이 위)
//  v7.0p  2026-11-19  공개판: Firebase 프로젝트 ID를 예시 값으로
//  v7.0  2026-10-22  탭 이름에 '예약 기록' 추가
//  v2.0  2026-10-15  삭제 처리 열 추가: 사유코드, 문자 상태, 문자 시각
//  v1.0  2026-10-15  새 구조용 공통 설정 분리. 비밀 값(Firebase·AES)을 스크립트 속성으로 이동
// ============================================================

// ============================================================
//  Config.gs - 공통 설정과 도우미 함수
//  ※ 비밀 값(Firebase 계정, AES 키)은 코드에 두지 않고
//    [프로젝트 설정 → 스크립트 속성]에 저장합니다.
//    필요한 키: FB_API_KEY, FB_EMAIL, FB_PW, AES_KEY, AES_IV
// ============================================================

var CONFIG = {
  SHEETS: {
    DASH: '대시보드',
    VIO: '위반 기록',
    DEL: '삭제 처리',
    STATS: '통계',
    SET: '설정',
    LOG: '로그',
    RESV: '예약 기록',
    ARCHIVE: '아카이브'
  },

  FB_PROJECT: 'YOUR_FIREBASE_PROJECT_ID',   // 예약 사이트의 Firebase 프로젝트 ID

  FIELDS: {
    NAME: 'name',
    PHONE: 'phone',
    DATE: 'date',
    TIME_FROM: 'timeFrom',
    TIME_TO: 'timeTo',
    ROOM: 'roomId'
  },

  ROOM_MAP: {
    1: '90105', 2: '90106', 3: '90107', 4: '90108',
    5: '9B209', 6: '9B210', 7: '9B211', 8: '9B203'
  },

  ADMIN_NAME: 'ADMIN'
};

// 위반 기록 열 (I~M은 시트 수식이 자동 계산 → 스크립트가 절대 쓰지 않음)
var VIO_COLS = ['학기', '누적일', '예약일', '시간', '호실', '이름', '전화', '예약ID',
                'n번째', '구분', '제한 시작', '제한 만료', '담당자',
                '문자 상태', '문자 시각', '비고'];
var VIO_RAW_WIDTH = 8;     // A~H: 스크립트가 쓰는 원본 열
var VIO_STATUS_COL = 14;   // N: 문자 상태 (Python이 씀)

// 삭제 처리 열 (M~O는 v2에서 추가: 사유코드는 스크립트용, 문자 상태·시각은 Python이 씀)
var DEL_COLS = ['예약일', '시간', '호실', '이름', '전화', '제한 만료', '감지 시각',
                '상태', '처리자', '처리 일시', '예약ID', '사유', '사유코드', '문자 상태', '문자 시각'];
var DEL_STATUS_COL = 8;    // H
var DEL_ID_COL = 11;       // K
var DEL_REASON_COL = 12;   // L

// ------------------------------------------------------------
function secret_(key) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v) throw new Error('스크립트 속성 "' + key + '"이(가) 없습니다. 프로젝트 설정 → 스크립트 속성에서 추가하세요.');
  return v;
}

function sheet_(name) {
  var s = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!s) throw new Error('"' + name + '" 탭이 없습니다.');
  return s;
}

function named_(name) {
  var r = SpreadsheetApp.getActiveSpreadsheet().getRangeByName(name);
  if (!r) throw new Error('이름 있는 범위 "' + name + '"이(가) 없습니다.');
  return r;
}

// 열 하나에서 마지막으로 값이 있는 행 번호 (없으면 1 = 헤더)
function lastDataRow_(sheet, col) {
  var n = sheet.getMaxRows() - 1;
  if (n < 1) return 1;
  var vals = sheet.getRange(2, col, n, 1).getValues();
  for (var i = vals.length - 1; i >= 0; i--) {
    if (vals[i][0] !== '' && vals[i][0] !== null) return i + 2;
  }
  return 1;
}

function ensureRows_(sheet, upToRow) {
  var max = sheet.getMaxRows();
  if (upToRow > max) sheet.insertRowsAfter(max, upToRow - max + 50);
}

// ------------------------------------------------------------
function slotToTime(slot) {
  var totalMin = 9 * 60 + slot * 15;
  var h = Math.floor(totalMin / 60);
  var m = totalMin % 60;
  return h + ':' + (m === 0 ? '00' : m);
}

function formatPhone(phone) {
  phone = String(phone || '');
  var digits = phone.replace(/\D/g, '');
  if (digits.length === 11) return digits.slice(0, 3) + '-' + digits.slice(3, 7) + '-' + digits.slice(7);
  if (digits.length === 10) return digits.slice(0, 3) + '-' + digits.slice(3, 6) + '-' + digits.slice(6);
  return phone;
}

function dateOnly_(d) {
  var x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

// "9/13" 같은 문자열 또는 Date → 날짜(시각 0시). 연도는 오늘 기준으로 추정.
function parseMD_(v) {
  if (v === '' || v === null || v === undefined) return null;
  if (v instanceof Date) return isNaN(v) ? null : dateOnly_(v);
  var m = String(v).match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
  if (!m) return null;
  var today = dateOnly_(new Date());
  var d = new Date(today.getFullYear(), parseInt(m[1], 10) - 1, parseInt(m[2], 10));
  if (d - today > 60 * 86400000) d.setFullYear(d.getFullYear() - 1); // 1월에 12월 날짜를 읽는 경우
  return d;
}

// 로테이션 표에서 해당 날짜의 담당자
function managerOn_(date) {
  var starts = named_('ROT_START').getValues();
  var mgrs = named_('ROT_MGR').getValues();
  var d = dateOnly_(date);
  var found = '';
  for (var i = 0; i < starts.length; i++) {
    var s = starts[i][0];
    if (!(s instanceof Date)) continue;
    s = dateOnly_(s);
    var e = new Date(s); e.setDate(e.getDate() + 6);
    if (d >= s && d <= e) found = String(mgrs[i][0] || '');
  }
  return found;
}

// 스크립트 시간대가 서울이 아니면 날짜가 하루씩 밀릴 수 있어서 막아둠
function assertSeoulTz_() {
  var tz = Session.getScriptTimeZone();
  if (tz !== 'Asia/Seoul') {
    throw new Error('스크립트 시간대가 ' + tz + '입니다. 프로젝트 설정(톱니바퀴) → 시간대를 "(GMT+09:00) 서울"로 바꾼 뒤 다시 실행하세요.');
  }
}
