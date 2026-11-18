// ============================================================
//  버전 기록 (최신이 위)
//  v2.0  2026-10-15  예약 정보 검사 신규: 인원·학번·학번 중복·이름·전화·공휴일·중복 예약, DB 구조 자동 감지
// ============================================================

// ============================================================
//  Validation.gs - 예약 정보 검사
//
//  검사 항목 (걸리면 '삭제 처리' 탭에 대기로 기록)
//   PEOPLE   : 이용 인원 미달 (대표 + 멤버, 학번 기준 중복 제외, 설정 탭 최소 인원)
//   STUDENT_ID : 학번이 10자리 숫자가 아님 / 빈칸
//   DUP_ID   : 멤버끼리 같은 학번이 2번 이상 (대표가 멤버에 또 적힌 건 허용, 1명으로 셈)
//   NAME     : 이름이 빈칸, 숫자 포함, 자음·모음만, 한 글자
//   PHONE    : 대표 전화가 010 + 8자리가 아님
//   HOLIDAY  : 설정 탭 공휴일 목록에 있는 날짜
//   DUP_RESV : 같은 날·호실·시간·대표자 예약이 여러 건 → 가장 먼저 만든 1건만 남기고 나머지
//  (제한자 예약 RESTRICT1/RESTRICT2/PERM 은 RestrictedCheck.gs)
//
//  멤버·학번 필드 이름은 사이트 DB 구조를 자동으로 찾음 (detectSchema_).
//  자동 감지가 틀리면 CONFIG.SCHEMA_OVERRIDE 에 직접 적으면 됨.
// ============================================================

// 필드 이름을 알면 여기에 적기 (비워두면 자동 감지)
CONFIG.SCHEMA_OVERRIDE = {
  membersKey: '',     // 예: 'members'
  memberNameKey: '',  // 예: 'name'
  memberIdKey: '',    // 예: 'studentId'
  repIdKey: ''        // 예: 'studentId'
};

// 사유 코드 → 관리자용 표시 문구
var REASON_LABEL = {
  RESTRICT1: '제한1 기간 중 예약',
  RESTRICT2: '제한2 기간 중 예약',
  PERM: '영구 제한자 예약',
  HOLIDAY: '공휴일 예약',
  PEOPLE: '인원 미달',
  STUDENT_ID: '학번 오류',
  DUP_ID: '학번 중복',
  NAME: '이름 오류',
  PHONE: '전화번호 오류',
  DUP_RESV: '중복 예약'
};

// ------------------------------------------------------------
//  사이트 DB 구조 자동 감지
// ------------------------------------------------------------
function detectSchema_(docs) {
  var o = CONFIG.SCHEMA_OVERRIDE || {};
  if (o.membersKey && o.memberNameKey && o.memberIdKey && o.repIdKey) {
    return { ok: true, membersKey: o.membersKey, memberNameKey: o.memberNameKey, memberIdKey: o.memberIdKey, repIdKey: o.repIdKey, source: '직접 지정' };
  }
  var known = {};
  [CONFIG.FIELDS.NAME, CONFIG.FIELDS.PHONE, CONFIG.FIELDS.DATE, CONFIG.FIELDS.TIME_FROM,
   CONFIG.FIELDS.TIME_TO, CONFIG.FIELDS.ROOM, 'checkOut'].forEach(function (k) { known[k] = true; });

  var sample = docs.slice(0, 60);
  var arrStats = {}, topStats = {};
  sample.forEach(function (doc) {
    var f = doc.fields || {};
    Object.keys(f).forEach(function (k) {
      if (known[k]) return;
      var v = f[k];
      if (v.arrayValue) {
        (v.arrayValue.values || []).forEach(function (item) {
          if (!item.mapValue) return;
          var mf = item.mapValue.fields || {};
          arrStats[k] = arrStats[k] || {};
          Object.keys(mf).forEach(function (mk) {
            var s = plainValue_(mf[mk]);
            if (s === '') return;
            var st = arrStats[k][mk] = arrStats[k][mk] || { n: 0, digits: 0 };
            st.n++; if (/^\d{7,12}$/.test(s.replace(/\s/g, ''))) st.digits++;
          });
        });
      } else if ('stringValue' in v || 'integerValue' in v) {
        var s = plainValue_(v);
        if (s === '') return;
        var st = topStats[k] = topStats[k] || { n: 0, digits: 0 };
        st.n++; if (/^\d{7,12}$/.test(s.replace(/\s/g, ''))) st.digits++;
      }
    });
  });

  var res = { ok: false };
  // 멤버 배열: 숫자 위주 키(학번) + 글자 키(이름)를 둘 다 가진 배열 필드
  Object.keys(arrStats).forEach(function (k) {
    if (res.membersKey) return;
    var keys = Object.keys(arrStats[k]);
    var idKey = pickKey_(keys.filter(function (mk) { var s = arrStats[k][mk]; return s.digits / s.n >= 0.7; }), /stu|id|hak|num|no/i);
    var nameKey = pickKey_(keys.filter(function (mk) { var s = arrStats[k][mk]; return s.digits / s.n < 0.3; }), /name|이름/i);
    if (idKey && nameKey) { res.membersKey = k; res.memberIdKey = idKey; res.memberNameKey = nameKey; }
  });
  // 대표 학번: 최상위에서 숫자 위주인 필드
  res.repIdKey = pickKey_(Object.keys(topStats).filter(function (k) { var s = topStats[k]; return s.digits / s.n >= 0.7; }), /stu|id|hak|num|no/i);

  ['membersKey', 'memberNameKey', 'memberIdKey', 'repIdKey'].forEach(function (k) { if (o[k]) res[k] = o[k]; });
  res.ok = !!(res.membersKey && res.memberNameKey && res.memberIdKey && res.repIdKey);
  res.source = '자동 감지';
  return res;
}

function pickKey_(keys, prefer) {
  if (!keys.length) return '';
  var p = keys.filter(function (k) { return prefer.test(k); });
  return (p.length ? p : keys)[0];
}

function describeSchema_(s) {
  if (!s.ok) return '구조 감지 실패(멤버 ' + (s.membersKey || '?') + ', 대표학번 ' + (s.repIdKey || '?') + ') → 정보 검사 생략';
  return s.source + ': 멤버=' + s.membersKey + '[' + s.memberNameKey + ',' + s.memberIdKey + '], 대표학번=' + s.repIdKey;
}

// ------------------------------------------------------------
//  검사 규칙
// ------------------------------------------------------------
function isValidStudentId_(s) { return /^\d{10}$/.test(String(s || '').replace(/\s/g, '')); }

function isValidName_(s) {
  s = String(s || '').trim();
  if (/^[가-힣]{2,}$/.test(s)) return true;                         // 한글 2자 이상
  if (/^[A-Za-zÀ-ɏ][A-Za-zÀ-ɏ .'\-]*[A-Za-zÀ-ɏ.]$/.test(s)) return true; // 외국 이름
  return false;
}

function isValidPhone_(raw) { return /^010\d{8}$/.test(String(raw || '').replace(/\D/g, '')); }

/** 예약 1건의 정보 오류 → [{code, detail}] */
function validateInfo_(r, minPeople) {
  var issues = [];
  var short = function (s) { s = String(s || ''); return s ? s : '빈칸'; };

  if (!isValidName_(r.name)) issues.push({ code: 'NAME', detail: '대표 ' + short(r.name) });
  if (!isValidPhone_(r.rawPhone)) issues.push({ code: 'PHONE', detail: short(r.phone || r.rawPhone) });
  if (!isValidStudentId_(r.studentId)) issues.push({ code: 'STUDENT_ID', detail: '대표 ' + short(r.studentId) });

  var repId = String(r.studentId || '').replace(/\s/g, '');
  var seen = {}, dupIds = {}, unique = {};
  if (repId) unique[repId] = true;
  (r.members || []).forEach(function (m, i) {
    var name = String(m.name || '').trim(), id = String(m.id || '').replace(/\s/g, '');
    if (!name && !id) return; // 완전히 빈 칸은 무시 (인원에도 안 셈)
    var who = name || ((i + 1) + '번째 멤버');
    if (!isValidName_(name)) issues.push({ code: 'NAME', detail: (i + 1) + '번째 ' + short(name) });
    if (!isValidStudentId_(id)) issues.push({ code: 'STUDENT_ID', detail: who + ' ' + short(id) });
    if (id) {
      if (seen[id]) dupIds[id] = true;
      seen[id] = true;
      unique[id] = true;
    } else {
      unique['__noid_' + i] = true; // 학번이 없어도 사람 수에는 포함 (학번 오류로 따로 걸림)
    }
  });
  Object.keys(dupIds).forEach(function (id) { issues.push({ code: 'DUP_ID', detail: id }); });

  var count = Object.keys(unique).length || 1;
  if (count < minPeople) issues.push({ code: 'PEOPLE', detail: count + '명' });
  return issues;
}

/** 같은 날·호실·시간·대표자 예약 묶음 → {id: {keep:false, total:n}} (가장 먼저 만든 1건 제외) */
function findDuplicateReservations_(resvs) {
  var groups = {};
  resvs.forEach(function (r) {
    if (!r.date) return;
    var who = String(r.rawPhone || '').replace(/\D/g, '') || r.name;
    var k = [r.date.getTime(), r.roomIdx, r.timeFrom, r.timeTo, who].join('|');
    (groups[k] = groups[k] || []).push(r);
  });
  var out = {};
  Object.keys(groups).forEach(function (k) {
    var g = groups[k];
    if (g.length < 2) return;
    g.sort(function (a, b) { return (a.createTime || 0) - (b.createTime || 0); });
    g.slice(1).forEach(function (r) { out[r.id] = { total: g.length, keepId: g[0].id }; });
  });
  return out;
}

function holidaySet_() {
  var set = {};
  try {
    named_('HOLIDAYS').getValues().forEach(function (row) {
      if (row[0] instanceof Date) set[dateOnly_(row[0]).getTime()] = String(row[1] || '공휴일');
    });
  } catch (e) { log('공휴일 목록 없음: ' + e.message); }
  return set;
}

// [{code, detail}] → 표시 문구 / 코드 문자열
function reasonText_(issues) {
  var byCode = {}, order = [];
  issues.forEach(function (x) {
    if (!byCode[x.code]) { byCode[x.code] = []; order.push(x.code); }
    if (x.detail) byCode[x.code].push(x.detail);
  });
  return order.map(function (c) {
    var d = byCode[c].join(', ');
    return REASON_LABEL[c] + (d ? '(' + d + ')' : '');
  }).join(' · ');
}

function reasonCodes_(issues) {
  var seen = {};
  return issues.map(function (x) { return x.code; }).filter(function (c) { return seen[c] ? false : (seen[c] = true); }).join(',');
}

// ------------------------------------------------------------
//  디버그: 예약 데이터 구조 확인 (값은 첫 글자만 보이게 가림)
// ------------------------------------------------------------
function inspectReservationFields() {
  var docs = queryUpcomingReservations_(getFirebaseToken());
  if (!docs || !docs.length) { Logger.log('예약 없음'); return; }
  Logger.log(describeSchema_(detectSchema_(docs)));
  var doc = docs.filter(function (d) { return Object.keys(d.fields || {}).length > 6; })[0] || docs[0];
  Logger.log('createTime: ' + doc.createTime + ' / 필드: ' + Object.keys(doc.fields).join(', '));
  Logger.log(JSON.stringify(maskFields_(doc.fields), null, 2));
}
function maskFields_(fields) { var o = {}; for (var k in fields) o[k] = maskValue_(fields[k]); return o; }
function maskValue_(v) {
  var mask = function (s) { s = String(s); return s.charAt(0) + new Array(Math.max(0, s.length)).join('*') + ' (' + s.length + '자)'; };
  if ('stringValue' in v) { var p = tryDecrypt_(v.stringValue); return (p !== v.stringValue.trim() ? '암호화 → ' : '문자열 ') + mask(p); }
  if ('integerValue' in v) return '정수';
  if ('booleanValue' in v) return '참/거짓';
  if ('timestampValue' in v) return '시각';
  if ('arrayValue' in v) { var a = v.arrayValue.values || []; return a.length ? ['배열 ' + a.length + '개, 첫 항목:', maskValue_(a[0])] : '빈 배열'; }
  if ('mapValue' in v) return maskFields_(v.mapValue.fields || {});
  return Object.keys(v)[0];
}
