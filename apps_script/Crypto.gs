// ============================================================
//  버전 기록 (최신이 위)
//  v8.0  2026-10-22  쓰지 않는 aesCbcDecrypt 삭제 (복호화는 decryptRaw_가 캐시로 처리)
//  v7.0  2026-10-22  firestoreQuery_: 조건 없이 전체 조회 가능 (예약 기록 가져오기용)
//  v2.0  2026-10-15  예약 파싱에 멤버·학번·생성 시각 추가, 복호화 키 캐시
//  v1.0  2026-10-15  Firebase 로그인·Firestore 조회·AES 복호화 분리
// ============================================================

// ============================================================
//  Crypto.gs - Firebase 로그인 / Firestore 조회 / AES 복호화
//  (복호화 알고리즘은 기존 코드 그대로, 키만 스크립트 속성에서 읽음)
// ============================================================

function getFirebaseToken() {
  var url = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + secret_('FB_API_KEY');
  try {
    var resp = UrlFetchApp.fetch(url, {
      method: 'POST', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify({ email: secret_('FB_EMAIL'), password: secret_('FB_PW'), returnSecureToken: true })
    });
    var data = JSON.parse(resp.getContentText());
    return data.idToken || null;
  } catch (e) { log('로그인 예외: ' + e.message); return null; }
}

function firestoreQuery_(token, where) {
  var url = 'https://firestore.googleapis.com/v1/projects/' + CONFIG.FB_PROJECT
          + '/databases/(default)/documents:runQuery';
  var q = { from: [{ collectionId: 'reservations' }] };
  if (where) q.where = where;            // 조건 없으면 전체 조회 (예약 기록 가져오기용)
  var body = { structuredQuery: q };
  try {
    var resp = UrlFetchApp.fetch(url, {
      method: 'POST', contentType: 'application/json', muteHttpExceptions: true,
      headers: { 'Authorization': 'Bearer ' + token },
      payload: JSON.stringify(body)
    });
    var data = JSON.parse(resp.getContentText());
    if (!Array.isArray(data)) { log('Firestore 오류: ' + resp.getContentText().substring(0, 300)); return null; }
    return data.filter(function (d) { return d.document; }).map(function (d) { return d.document; });
  } catch (e) { log('Firestore 예외: ' + e.message); return null; }
}

// 특정 날짜(toDateString 형식) + 미체크아웃
function queryFirestore(token, dateStr) {
  return firestoreQuery_(token, {
    compositeFilter: {
      op: 'AND',
      filters: [
        { fieldFilter: { field: { fieldPath: CONFIG.FIELDS.DATE }, op: 'EQUAL', value: { stringValue: dateStr } } },
        { fieldFilter: { field: { fieldPath: 'checkOut' }, op: 'EQUAL', value: { booleanValue: false } } }
      ]
    }
  });
}

// 미체크아웃 예약 전체 (예약 사이트가 +7일까지만 받으므로 상한 불필요)
function queryUpcomingReservations_(token) {
  return firestoreQuery_(token, {
    fieldFilter: { field: { fieldPath: 'checkOut' }, op: 'EQUAL', value: { booleanValue: false } }
  });
}

// Firestore 문서 → 사람이 읽을 수 있는 예약 정보
// schema: detectSchema_()가 찾은 멤버·학번 필드 (없으면 기본 정보만)
function parseReservation_(doc, schema) {
  var f = doc.fields || {};
  var get = function (k, t) { return f[k] && f[k][t]; };
  var timeFrom = get(CONFIG.FIELDS.TIME_FROM, 'integerValue');
  var timeTo = get(CONFIG.FIELDS.TIME_TO, 'integerValue');
  var roomIdx = get(CONFIG.FIELDS.ROOM, 'integerValue');
  var dateVal = get(CONFIG.FIELDS.DATE, 'stringValue');
  var d = dateVal ? new Date(dateVal) : null;
  var rawPhone = aesDecrypt(get(CONFIG.FIELDS.PHONE, 'stringValue')) || '';
  var r = {
    id: doc.name.split('/').pop(),
    createTime: doc.createTime ? new Date(doc.createTime) : null,
    name: (aesDecrypt(get(CONFIG.FIELDS.NAME, 'stringValue')) || '').trim(),
    rawPhone: rawPhone,
    phone: formatPhone(rawPhone),
    date: (d && !isNaN(d)) ? dateOnly_(d) : null,
    timeFrom: timeFrom != null ? Number(timeFrom) : null,
    timeTo: timeTo != null ? Number(timeTo) : null,
    time: (timeFrom != null && timeTo != null) ? slotToTime(Number(timeFrom)) + '~' + slotToTime(Number(timeTo)) : '',
    roomIdx: roomIdx != null ? Number(roomIdx) : 0,
    room: String(CONFIG.ROOM_MAP[roomIdx] || roomIdx || ''),
    studentId: null,
    members: null
  };
  if (schema && schema.ok) {
    r.studentId = plainValue_(f[schema.repIdKey]);
    var arr = f[schema.membersKey] && f[schema.membersKey].arrayValue;
    r.members = ((arr && arr.values) || []).map(function (v) {
      var mf = (v.mapValue && v.mapValue.fields) || {};
      return { name: plainValue_(mf[schema.memberNameKey]), id: plainValue_(mf[schema.memberIdKey]) };
    });
  }
  return r;
}

// Firestore 값 → 문자열 (암호화돼 있으면 복호화, 아니면 그대로)
function plainValue_(v) {
  if (!v) return '';
  if ('stringValue' in v) return tryDecrypt_(v.stringValue);
  if ('integerValue' in v) return String(v.integerValue);
  if ('doubleValue' in v) return String(v.doubleValue);
  return '';
}

// ── 복호화 (키 확장 결과를 캐시해서 수천 건도 빠르게) ──
var AES_CACHE_ = null;
function aesCache_() {
  if (!AES_CACHE_) {
    var key = hexToBytes(secret_('AES_KEY'));
    AES_CACHE_ = { w: keyExpansion(key), nr: key.length / 4 + 6, iv: hexToBytes(secret_('AES_IV')) };
  }
  return AES_CACHE_;
}

function decryptRaw_(base64Cipher) {
  var c = aesCache_(), cipher = base64ToBytes(base64Cipher);
  if (!cipher.length || cipher.length % 16) throw new Error('블록 길이 오류');
  var out = [], prev = c.iv.slice();
  for (var i = 0; i < cipher.length; i += 16) {
    var block = cipher.slice(i, i + 16), dec = decryptBlock(block, c.w, c.nr);
    for (var j = 0; j < 16; j++) dec[j] ^= prev[j];
    prev = block; out = out.concat(dec);
  }
  var pad = out[out.length - 1];
  if (pad > 0 && pad <= 16) {
    var ok = true;
    for (var k = out.length - pad; k < out.length; k++) if (out[k] !== pad) { ok = false; break; }
    if (ok) out = out.slice(0, out.length - pad);
  }
  return bytesToUtf8(out);
}

function aesDecrypt(base64Cipher) {
  if (!base64Cipher) return null;
  try { return decryptRaw_(base64Cipher); }
  catch (e) { log('복호화 예외: ' + e.message); return null; }
}

// 암호문처럼 보이면 복호화 시도, 결과가 사람이 읽을 수 있는 글자면 채택 (조용히 실패)
var READABLE_RE_ = /^[\x20-\x7EÀ-ɏ가-힣ㄱ-ㆎ\s]*$/;
function tryDecrypt_(s) {
  s = String(s || '');
  if (!s || s.length < 16 || s.length % 4 || !/^[A-Za-z0-9+\/]+=*$/.test(s)) return s.trim();
  try {
    var dec = decryptRaw_(s);
    if (dec && READABLE_RE_.test(dec)) return dec.trim();
  } catch (e) {}
  return s.trim();
}

var SBOX=[99,124,119,123,242,107,111,197,48,1,103,43,254,215,171,118,202,130,201,125,250,89,71,240,173,212,162,175,156,164,114,192,183,253,147,38,54,63,247,204,52,165,229,241,113,216,49,21,4,199,35,195,24,150,5,154,7,18,128,226,235,39,178,117,9,131,44,26,27,110,90,160,82,59,214,179,41,227,47,132,83,209,0,237,32,252,177,91,106,203,190,57,74,76,88,207,208,239,170,251,67,77,51,133,69,249,2,127,80,60,159,168,81,163,64,143,146,157,56,245,188,182,218,33,16,255,243,210,205,12,19,236,95,151,68,23,196,167,126,61,100,93,25,115,96,129,79,220,34,42,144,136,70,238,184,20,222,94,11,219,224,50,58,10,73,6,36,92,194,211,172,98,145,149,228,121,231,200,55,109,141,213,78,169,108,86,244,234,101,122,174,8,186,120,37,46,28,166,180,198,232,221,116,31,75,189,139,138,112,62,181,102,72,3,246,14,97,53,87,185,134,193,29,158,225,248,152,17,105,217,142,148,155,30,135,233,206,85,40,223,140,161,137,13,191,230,66,104,65,153,45,15,176,84,187,22];
var INV_SBOX=(function(){var t=new Array(256);for(var i=0;i<256;i++)t[SBOX[i]]=i;return t;})();
var RCON=[1,2,4,8,16,32,64,128,27,54,108,216,171,77,154,47,94,188,99,198,151,53,106,212,179,125,250,239,197,145];
function mul(a,b){var p=0,hb;for(var i=0;i<8;i++){if(b&1)p^=a;hb=a&0x80;a=(a<<1)&0xff;if(hb)a^=0x1b;b>>=1;}return p;}
function keyExpansion(key){var nk=key.length/4,nr=nk+6,w=[];for(var i=0;i<nk;i++)w[i]=[key[4*i],key[4*i+1],key[4*i+2],key[4*i+3]];for(var i=nk;i<4*(nr+1);i++){var t=w[i-1].slice();if(i%nk===0)t=[SBOX[t[1]]^RCON[i/nk-1],SBOX[t[2]],SBOX[t[3]],SBOX[t[0]]];else if(nk>6&&i%nk===4)t=[SBOX[t[0]],SBOX[t[1]],SBOX[t[2]],SBOX[t[3]]];w[i]=[w[i-nk][0]^t[0],w[i-nk][1]^t[1],w[i-nk][2]^t[2],w[i-nk][3]^t[3]];}return w;}
function addRK(s,w,r){for(var c=0;c<4;c++){s[0][c]^=w[r*4+c][0];s[1][c]^=w[r*4+c][1];s[2][c]^=w[r*4+c][2];s[3][c]^=w[r*4+c][3];}}
function invSB(s){for(var r=0;r<4;r++)for(var c=0;c<4;c++)s[r][c]=INV_SBOX[s[r][c]];}
function invSR(s){var t;t=s[1][3];s[1][3]=s[1][2];s[1][2]=s[1][1];s[1][1]=s[1][0];s[1][0]=t;t=s[2][0];s[2][0]=s[2][2];s[2][2]=t;t=s[2][1];s[2][1]=s[2][3];s[2][3]=t;t=s[3][0];s[3][0]=s[3][1];s[3][1]=s[3][2];s[3][2]=s[3][3];s[3][3]=t;}
function invMC(s){for(var c=0;c<4;c++){var s0=s[0][c],s1=s[1][c],s2=s[2][c],s3=s[3][c];s[0][c]=mul(s0,0x0e)^mul(s1,0x0b)^mul(s2,0x0d)^mul(s3,0x09);s[1][c]=mul(s0,0x09)^mul(s1,0x0e)^mul(s2,0x0b)^mul(s3,0x0d);s[2][c]=mul(s0,0x0d)^mul(s1,0x09)^mul(s2,0x0e)^mul(s3,0x0b);s[3][c]=mul(s0,0x0b)^mul(s1,0x0d)^mul(s2,0x09)^mul(s3,0x0e);}}
function decryptBlock(block,w,nr){var s=[[],[],[],[]];for(var r=0;r<4;r++)for(var c=0;c<4;c++)s[r][c]=block[r+4*c];addRK(s,w,nr);for(var round=nr-1;round>=1;round--){invSR(s);invSB(s);addRK(s,w,round);invMC(s);}invSR(s);invSB(s);addRK(s,w,0);var out=[];for(var c=0;c<4;c++)for(var r=0;r<4;r++)out.push(s[r][c]);return out;}
function hexToBytes(hex){var b=[];for(var i=0;i<hex.length;i+=2)b.push(parseInt(hex.substr(i,2),16));return b;}
function base64ToBytes(b64){return Array.from(Utilities.base64Decode(b64)).map(function(b){return b&0xff;});}
function bytesToUtf8(bytes){var str='',i=0;while(i<bytes.length){var b=bytes[i];if(b===0)break;if(b<128){str+=String.fromCharCode(b);i++;}else if((b&0xe0)===0xc0){str+=String.fromCharCode(((b&0x1f)<<6)|(bytes[i+1]&0x3f));i+=2;}else if((b&0xf0)===0xe0){str+=String.fromCharCode(((b&0x0f)<<12)|((bytes[i+1]&0x3f)<<6)|(bytes[i+2]&0x3f));i+=3;}else{i++;}}return str;}