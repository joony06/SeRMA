"""
SeSMA (Seminar Sending Message Automation) - 세미나실 문자 자동 발송 (맥북 · iMessage)
SeRMA(세미나실 관리 자동화 시스템 전체) 중 문자 발송 부분

버전 기록 (최신이 위)
  v4.9p 2026-11-19  공개판: 시트 ID·관리자 번호·테스트 번호를 config.json에서 읽음 (코드에 개인정보 없음)
  v4.9  2026-11-11  학생 문자 문단 나누기(빈 줄), 날짜·기간·사유를 '- 항목: 값' 줄로 분리,
                    제한2·3 '6회/9회 이상' → '6회/9회', 제한3 회신 안내 '이 번호로', 교대 안내 링크 앞 빈 줄
  v4.8  2026-11-03  중복 예약으로만 삭제된 건은 문자를 보내지 않음(문자 상태 '발송 안 함'으로 기록),
                    이상 알림은 최고 관리자(ADMIN_PHONE_NUMBER)에게만 (그 주 담당자에게는 보내지 않음)
  v4.7  2026-10-22  관리자가 문자 상태를 '수동 발송'·'발송 안 함'으로 바꾼 행은 재확인·상태 기록으로 덮어쓰지 않음
                    (발송 직후 '성공'이었다가 나중에 실패로 바뀐 건을 직접 보낸 경우 알림·덮어쓰기 방지)
  v4.6  2026-10-22  이름 변경: 문자 발송 봇 = SeSMA (시스템 전체는 SeRMA). 코드 동작은 그대로
  v4.5  2026-10-22  실행 간격 5~23시 매시간으로 변경 (plist), 설명 갱신. 코드 동작은 그대로
  v4.4  2026-10-22  멈춤 방지: 구글 시트 요청 시간 제한(60초), 전체 실행 시간 제한(15분, 넘으면 스스로 종료·알림),
                    로그 즉시 기록(멈춰도 어디서 멈췄는지 남도록)
  v4.3  2026-10-18  관리자 교대 안내 문구 '-다'체로 통일
  v4.2  2026-10-17  새 시트 ID 적용 / 테스트 모드 발송이 실제 발송을 막지 않게 /
                    7시 전 '대상 없음' 로그 문구 수정 / 옛 버전 재확인 항목 처리
  v4.1  2026-10-16  위반 안내는 7시 이후만, 같은 관리자 알림 12시간 내 반복 안 함
  v2.0  2026-10-15  예약 삭제 안내 문자 추가 (삭제 처리 '완료' 후 발송, 중복 예약은 1통)
  v1.0  2026-10-15  개편: 시트 수식 열을 읽어 발송, 헤더 이름으로 읽기, 전화번호 기준 횟수,
                    문자 상태 시트 기록, 하트비트, 관리자 교대 안내

바뀐 점 (이전 버전 대비)
- 시트가 계산하고, 이 스크립트는 읽고 보내기만 함
  · n번째(전화번호 기준, 학기별) / 구분(부재·제한1·제한2·제한3) / 제한 시작·만료는
    '위반 기록' 탭의 수식 열을 그대로 읽음 → 이름 중복(동명이인) 문제 없음
- 열 위치가 아니라 헤더 이름으로 읽음 → 시트 열 순서가 바뀌어도 안전
- 발송 결과를 시트 '문자 상태'·'문자 시각' 열에 직접 기록 (대시보드 '문자 발송 문제'가 여기서 읽음)
- 실행할 때마다 설정 탭에 하트비트(마지막 실행 시각/결과) 기록
- 관리자 교대 안내: 일요일 저녁(18시 이후 실행), 월요일 오전(9~15시 실행)에
  끝나는 관리자·시작하는 관리자 모두에게 발송
- 이상 알림은 ADMIN_PHONE_NUMBER에게만
- 예약 삭제 안내: '삭제 처리' 탭에서 상태가 '완료'가 된 건(= 사이트에서 실제로 삭제됨)에만
  예약자에게 사유를 담아 발송. 같은 예약은 1통으로 묶음. 중복 예약으로만 지운 건은 보내지 않음('발송 안 함'). 시간대 제한 없음.
- 실행 시각: plist 기준 5~23시 매시간. 위반 안내만 7시 이후 실행에서 발송.

발송 대상 규칙
- '문자 상태'가 비어 있고, 구분이 있고, 누적일이 오늘~LOOKBACK_DAYS일 전 사이인 행
- 그보다 오래됐는데 비어 있으면 '기한 지남'으로 표시하고 알림 (맥이 며칠 꺼져 있던 경우)

전달 확인 방식은 이전과 동일 (chat.db 실측 기준)
- 성공 : error = 0 AND is_sent = 1
- 실패 : error != 0
- 멈춤 : error = 0 AND is_sent = 0
- 발송 직후 확인 + 다음 실행 때 재확인 2단계 (pending_verification.json)

필요: 서비스 계정이 시트에 '편집자'로 공유되어 있어야 함 (상태를 써야 하므로)
"""

import json
import signal
import sys
import sqlite3
import subprocess
import time
import traceback
from datetime import date, datetime, timedelta
from pathlib import Path

import gspread
import requests

# 로그를 줄마다 바로 파일에 씀 (멈춰도 어디까지 진행됐는지 log.txt에 남도록)
try:
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.reconfigure(line_buffering=True)
except Exception:  # noqa: BLE001
    pass

# ── 설정 ──────────────────────────────────────────────
# 사본에서 테스트할 때는 사본 ID로 바꾸고, 전환할 때 운영 시트 ID로 되돌리기
SCRIPT_DIR = Path(__file__).parent
CONFIG_FILE = SCRIPT_DIR / "config.json"   # config.example.json을 복사해 채움 (git에 올리지 않음)
try:
    _CFG = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
except FileNotFoundError:
    sys.exit("config.json이 없습니다. config.example.json을 복사해 config.json을 만들고 값을 채우세요.")
SPREADSHEET_ID = _CFG["spreadsheet_id"]
VIO_SHEET = "위반 기록"
DEL_SHEET = "삭제 처리"

SERVICE_ACCOUNT_FILE = SCRIPT_DIR / "service-account.json"
SENT_LOG_FILE = SCRIPT_DIR / "sent_keys.json"          # 발송한 행 키 (시트 기록 실패 대비 이중 안전장치)
HISTORY_FILE = SCRIPT_DIR / "history.json"             # 발송 결과 상세 기록
PENDING_FILE = SCRIPT_DIR / "pending_verification.json"
ROTATION_LOG_FILE = SCRIPT_DIR / "rotation_log.json"   # 교대 안내 중복 방지
ALERT_FILE = SCRIPT_DIR / "ALERT.txt"
ALERT_SENT_FILE = SCRIPT_DIR / "alert_sent.json"  # 같은 알림 반복 방지
# 멈춤 방지
SHEETS_TIMEOUT = 60        # 구글 시트 요청 하나가 이 시간(초) 넘게 응답이 없으면 실패 처리 (재시도는 그대로)
MAX_RUN_SECONDS = 15 * 60  # 실행 전체가 이 시간을 넘으면 스스로 종료 (다음 정시 실행이 막히지 않게)
CHAT_DB_PATH = Path.home() / "Library" / "Messages" / "chat.db"

# 테스트 모드: True면 모든 문자를 TEST_PHONE_NUMBER로만 보내고, 시트 상태는 '테스트·성공'처럼 기록
TEST_MODE = bool(_CFG.get("test_mode", True))
TEST_PHONE_NUMBER = _CFG["test_phone_number"]

# 이상 상태 알림 받을 번호 (발신 아이폰 번호와 같으면 알림이 안 울릴 수 있음)
ADMIN_PHONE_NUMBER = _CFG["admin_phone_number"]

LOOKBACK_DAYS = 2          # 누적일이 이 기간 안이면 늦게라도 발송
VIOLATION_SEND_FROM = 7    # 위반 안내는 이 시각 이후 실행에서만 (5시 실행 때는 보내지 않음)
ALERT_REPEAT_HOURS = 12    # 같은 내용의 관리자 알림은 이 시간 안에 다시 보내지 않음
DELETE_LOOKBACK_DAYS = 2   # 삭제 처리 후 이 기간 안이면 삭제 안내 발송
DELIVERY_TIMEOUT = 45
DELIVERY_INTERVAL = 5
RECHECK_AFTER_HOURS = 6
MANUAL_STATUSES = ("수동 발송", "발송 안 함")   # 관리자가 직접 처리한 표시 → 스크립트가 덮어쓰지 않음
RECHECK_GIVE_UP_DAYS = 3

# 교대 안내 발송 시간대
SUNDAY_EVENING_FROM = 18   # 일요일 이 시각 이후 실행에서 발송
MONDAY_MORNING = (9, 15)   # 월요일 이 시간대 실행에서 발송

# 시트에 쓰는 상태 문구 (대시보드가 '실패|멈춤|확인 불가|기한 지남|번호 없음'을 문제로 표시)
STATUS_LABEL = {
    "success": "성공",
    "failed": "실패",
    "stuck": "멈춤",
    "unverified": "확인 불가",
}

TEMPLATES = {
    "부재": (
        "[세미나실 체크아웃 안내]\n"
        "안녕하세요 {name}님, 글로벌경영학과 17대 학생회 행정복지부입니다.\n\n"
        "지난 {res_date} 세미나실 이용의 체크아웃이 원활히 이루어지지 않아 문자드립니다.\n\n"
        "체크아웃 부재가 3회 누적될 경우 제재 1회가 부과되어 세미나실 이용이 제한되오니 참고 부탁드립니다.\n\n"
        "글로벌경영학과 모두의 쾌적한 세미나실 이용을 위한 절차이오니 학우분들의 양해 부탁드립니다. 감사합니다."
    ),
    "제한1": (
        "[세미나실 이용 제한 안내]\n"
        "안녕하세요 {name}님, 글로벌경영학과 17대 학생회 행정복지부입니다.\n\n"
        "<글로벌경영학과 세미나실 이용수칙> 위반이 3회 누적되어 세미나실 이용 제한 대상이 되셨음을 알려드립니다.\n\n"
        "- 제한 횟수: 1회\n"
        "- 제한 기간: {start_date} ~ {end_date}\n\n"
        "글로벌경영학과 모두의 쾌적한 세미나실 이용을 위한 절차이오니 학우분들의 양해 부탁드립니다. 감사합니다."
    ),
    "제한2": (
        "[세미나실 이용 제한 안내]\n"
        "안녕하세요 {name}님, 글로벌경영학과 17대 학생회 행정복지부입니다.\n\n"
        "<글로벌경영학과 세미나실 이용수칙>에 따라 위반 3회당 제재 1회가 부과되며, "
        "누적 위반 6회가 확인되어 제재 2회가 부과되었습니다.\n\n"
        "- 제한 횟수: 2회\n"
        "- 제한 기간: {start_date} ~ {end_date} (1개월)\n\n"
        "제재가 3회 누적되면 세미나실 이용 계정이 삭제되어 이후 이용이 불가능하오니, "
        "수칙을 반드시 준수해 주시기 바랍니다. 감사합니다."
    ),
    "제한3": (
        "[세미나실 이용 계정 삭제 안내]\n"
        "안녕하세요 {name}님, 글로벌경영학과 17대 학생회 행정복지부입니다.\n\n"
        "<글로벌경영학과 세미나실 이용수칙>에 따라 위반 3회당 제재 1회가 부과되며, "
        "누적 위반 9회가 확인되어 제재 3회가 부과되었습니다.\n\n"
        "이에 따라 {name}님의 세미나실 이용 계정이 삭제되어 향후 세미나실 예약 및 이용이 불가능합니다.\n\n"
        "문의사항이 있으시면 이 번호로 회신 부탁드립니다. 감사합니다."
    ),
}

ROTATION_TEMPLATES = {
    # 일요일 저녁
    ("sun", "in"): (
        "[세미나실 관리 안내]\n{name}님, 내일({start})부터 {end}까지 세미나실 관리 담당입니다.\n"
        "매일 대시보드에서 '삭제할 예약'을 확인하고 예약 사이트에서 삭제해 주시기 바랍니다.\n"
        "현재 삭제할 예약 {pending}건 · 제한자 {restricted}명\n\n{link}"
    ),
    ("sun", "out"): (
        "[세미나실 관리 안내]\n{name}님, 이번 주 세미나실 관리 수고하셨습니다. 오늘이 담당 마지막 날입니다.\n"
        "{pending_line}\n\n{link}"
    ),
    ("sun", "both"): (
        "[세미나실 관리 안내]\n{name}님, 다음 주({start}~{end})도 세미나실 관리 담당입니다.\n"
        "현재 삭제할 예약 {pending}건 · 제한자 {restricted}명\n\n{link}"
    ),
    # 월요일 아침
    ("mon", "in"): (
        "[세미나실 관리 시작]\n{name}님, 오늘부터 {end}까지 세미나실 관리 담당입니다.\n"
        "지금 삭제할 예약 {pending}건 · 제한자 {restricted}명 · 문자 발송 문제 {sms_issues}건\n\n{link}"
    ),
    ("mon", "out"): (
        "[세미나실 관리 종료]\n{name}님, 지난주 관리 담당이 끝났습니다. 수고 많으셨습니다!\n"
        "{handover_line}"
    ),
}


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


# ── 날짜 변환 (시트 SERIAL_NUMBER ↔ date) ─────────────────
SHEET_EPOCH = datetime(1899, 12, 30)


def serial_to_date(v) -> date | None:
    if v in ("", None):
        return None
    try:
        return (SHEET_EPOCH + timedelta(days=float(v))).date()
    except (TypeError, ValueError):
        return None


def datetime_to_serial(dt: datetime) -> float:
    return (dt - SHEET_EPOCH).total_seconds() / 86400


def format_kdate(d: date) -> str:
    return f"{d.month}월 {d.day}일"


def format_md(d: date) -> str:
    return f"{d.month}/{d.day}"


# ── 파일 입출력 ──────────────────────────────────────
def _load_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError:
        log(f"  ⚠ {path.name} 손상 — 빈 값으로 시작 (원본은 .broken으로 백업)")
        path.rename(path.with_suffix(path.suffix + ".broken"))
        return default


def _save_json(path: Path, data) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2))


# ── 구글 시트 ─────────────────────────────────────────
class Sheet:
    """시트 접근을 한 곳에 모음. API 일시 오류는 재시도."""

    def __init__(self):
        self.gc = gspread.service_account(filename=str(SERVICE_ACCOUNT_FILE))
        # 기본값은 시간 제한 없음 → 연결이 끊기면 무한 대기 (gspread 버전에 따라 설정 방법이 다름)
        try:
            self.gc.set_timeout(SHEETS_TIMEOUT)
        except Exception:  # noqa: BLE001
            try:
                self.gc.http_client.timeout = SHEETS_TIMEOUT
            except Exception:  # noqa: BLE001
                log("  ⚠ 구글 시트 시간 제한 설정 실패 (실행 시간 제한으로만 보호됨)")
        self.ss = self._retry(lambda: self.gc.open_by_key(SPREADSHEET_ID))

    @staticmethod
    def _retry(fn, tries: int = 5, delay: int = 10):
        last = None
        for i in range(1, tries + 1):
            try:
                return fn()
            except (gspread.exceptions.APIError, requests.exceptions.RequestException) as e:
                last = e
                log(f"  ⚠ 구글 시트 요청 실패 ({i}/{tries}): {e}")
                if i < tries:
                    time.sleep(delay)
        raise last

    def named(self, name: str) -> list[list]:
        """이름 있는 범위 값 (날짜는 serial number로)."""
        res = self._retry(lambda: self.ss.values_get(name, params={
            "valueRenderOption": "UNFORMATTED_VALUE",
            "dateTimeRenderOption": "SERIAL_NUMBER",
        }))
        return res.get("values", [])

    def write_named(self, name: str, values: list[list]) -> None:
        self._retry(lambda: self.ss.values_update(name, params={"valueInputOption": "RAW"},
                                                  body={"values": values}))

    def read_tab(self, tab: str, need: list[str]) -> tuple[dict, list[dict]]:
        """탭 전체를 {헤더: 값} 목록으로 (날짜는 serial number). 빈 행(4번째 열 기준) 제외."""
        res = self._retry(lambda: self.ss.values_get(f"'{tab}'!A1:Z", params={
            "valueRenderOption": "UNFORMATTED_VALUE",
            "dateTimeRenderOption": "SERIAL_NUMBER",
        }))
        values = res.get("values", [])
        if not values:
            raise RuntimeError(f"{tab} 탭이 비어 있음")
        headers = [str(h).strip() for h in values[0]]
        missing = [h for h in need if h not in headers]
        if missing:
            raise RuntimeError(f"{tab} 헤더 없음: {missing}")
        col = {h: i for i, h in enumerate(headers)}
        rows = []
        for i, raw in enumerate(values[1:], start=2):
            raw = list(raw) + [""] * (len(headers) - len(raw))
            r = {h: raw[col[h]] for h in headers}
            if not str(r.get("이름", "")).strip():
                continue
            r["_row"] = i
            rows.append(r)
        return col, rows

    def read_violations(self) -> tuple[dict, list[dict]]:
        return self.read_tab(VIO_SHEET, ["누적일", "예약일", "이름", "전화", "예약ID", "n번째", "구분",
                                         "제한 시작", "제한 만료", "문자 상태", "문자 시각"])

    def read_deletions(self) -> tuple[dict, list[dict]]:
        return self.read_tab(DEL_SHEET, ["예약일", "시간", "호실", "이름", "전화", "상태", "처리자", "처리 일시",
                                         "예약ID", "사유", "사유코드", "문자 상태", "문자 시각"])

    def write_statuses(self, updates: dict[tuple[str, str], tuple[str, datetime | None]]) -> None:
        """
        (탭, 행 키)별 (상태, 시각)을 '문자 상태'·'문자 시각' 열에 기록.
        읽은 뒤 행이 지워졌을 수 있어서, 쓰기 직전에 다시 읽어 키로 행을 찾음.
        """
        data = []
        for tab in sorted({t for t, _ in updates}):
            col, rows = self.read_violations() if tab == VIO_SHEET else self.read_deletions()
            keyf = row_key if tab == VIO_SHEET else (lambda r: str(r.get("예약ID", "")).strip())
            by_key = {keyf(r): r["_row"] for r in rows}
            s_col, t_col = col_letter(col["문자 상태"]), col_letter(col["문자 시각"])
            for (t, key), (status, at) in updates.items():
                if t != tab:
                    continue
                row = by_key.get(key)
                if row is None:
                    log(f"  ⚠ {tab}에서 행을 못 찾아 상태 기록 생략: {key}")
                    continue
                cur = str(next((r.get("문자 상태", "") for r in rows if r["_row"] == row), "")).strip()
                if cur in MANUAL_STATUSES:
                    log(f"  - 관리자가 '{cur}'(으)로 처리한 행이라 상태 기록 생략: {key}")
                    continue
                data.append({"range": f"'{tab}'!{s_col}{row}", "values": [[status]]})
                if at is not None:
                    data.append({"range": f"'{tab}'!{t_col}{row}", "values": [[datetime_to_serial(at)]]})
        if data:
            self._retry(lambda: self.ss.values_batch_update(body={"valueInputOption": "RAW", "data": data}))

    def heartbeat(self, ok: bool, summary: str) -> None:
        self.write_named("ST_MAC", [[datetime_to_serial(datetime.now()), ("성공: " if ok else "실패: ") + summary]])


def col_letter(idx0: int) -> str:
    s, n = "", idx0 + 1
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def row_key(r: dict) -> str:
    """행 고유 키: 예약ID가 있으면 그것, 없으면 전화|누적일|n번째."""
    rid = str(r.get("예약ID", "")).strip()
    if rid:
        return rid
    return f"{str(r.get('전화', '')).strip()}|{r.get('누적일', '')}|{r.get('n번째', '')}"


def already_handled(status) -> bool:
    """문자 상태 칸이 '처리됨'인지. 테스트 모드에서 남긴 '테스트·…'는 실제 모드에선 안 보낸 것으로 봄."""
    s = str(status or "").strip()
    if not s:
        return False
    if s.startswith("테스트·") and not TEST_MODE:
        return False
    return True


def status_text(status: str) -> str:
    label = STATUS_LABEL.get(status, status)
    return f"테스트·{label}" if TEST_MODE else label


# ── 발송 대상 선정 & 문구 ─────────────────────────────
def select_targets(rows: list[dict], today: date) -> tuple[list[dict], list[dict]]:
    """(보낼 행, 기한 지난 행) 반환."""
    targets, expired = [], []
    for r in rows:
        if already_handled(r.get("문자 상태")):
            continue
        if not str(r.get("구분", "")).strip():
            continue
        acc = serial_to_date(r.get("누적일"))
        if acc is None or acc > today:
            continue
        if acc >= today - timedelta(days=LOOKBACK_DAYS):
            targets.append(r)
        else:
            expired.append(r)
    return targets, expired


def build_message(r: dict) -> str:
    case = r["구분"]
    name = str(r["이름"]).strip()
    if case == "제한3":
        return TEMPLATES[case].format(name=name)
    if case == "부재":
        return TEMPLATES[case].format(name=name, res_date=format_kdate(serial_to_date(r["예약일"])))
    start, end = serial_to_date(r["제한 시작"]), serial_to_date(r["제한 만료"])
    if start is None or end is None:
        raise ValueError(f"{name}: 제한 시작/만료 값이 비어 있음 (시트 수식 확인 필요)")
    return TEMPLATES[case].format(name=name, start_date=format_kdate(start), end_date=format_kdate(end))


# ── 발송 (AppleScript / Mac Messages) ───────────────────
def ensure_messages_running() -> None:
    subprocess.run(["open", "-a", "Messages"], capture_output=True)
    time.sleep(5)


def _applescript_str(s: str) -> str:
    return s.replace("\\", "\\\\").replace('"', '\\"')


def send_text(phone: str, message: str, service: str = "SMS", retry: bool = True) -> bool:
    script = f'''
    with timeout of 30 seconds
        set targetPhone to "{_applescript_str(phone)}"
        set targetMessage to "{_applescript_str(message)}"
        tell application "Messages"
            set targetService to 1st service whose service type = {service}
            set targetBuddy to buddy targetPhone of targetService
            send targetMessage to targetBuddy
        end tell
    end timeout
    '''
    result = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
    if result.returncode != 0:
        log(f"    ✗ 발송 명령 실패 ({phone}, {service}): {result.stderr.strip()}")
        if retry:
            time.sleep(5)
            return send_text(phone, message, service=service, retry=False)
        return False
    return True


# ── 전달 상태 확인 (chat.db) ─────────────────────────────
class ChatDBUnavailable(Exception):
    pass


def _query_chat_db(sql: str, params: tuple = ()) -> list[tuple]:
    if not CHAT_DB_PATH.exists():
        raise ChatDBUnavailable("chat.db 파일이 없음")
    try:
        conn = sqlite3.connect(f"file:{CHAT_DB_PATH}?mode=ro", uri=True, timeout=5)
        try:
            return conn.execute(sql, params).fetchall()
        finally:
            conn.close()
    except sqlite3.Error as e:
        raise ChatDBUnavailable(str(e)) from e


def normalize_phone_digits(phone: str) -> str:
    digits = "".join(ch for ch in str(phone) if ch.isdigit())
    return digits[-9:]


def get_max_rowid() -> int | None:
    try:
        rows = _query_chat_db("SELECT MAX(ROWID) FROM message")
        return rows[0][0] or 0
    except ChatDBUnavailable as e:
        log(f"    ⚠ chat.db 접근 실패 (전체 디스크 접근 권한 확인 필요): {e}")
        return None


_FIND_SENT_SQL = """
    SELECT m.ROWID, m.error, m.is_sent, c.chat_identifier, h.id
    FROM message m
    LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    LEFT JOIN chat c ON c.ROWID = cmj.chat_id
    LEFT JOIN handle h ON h.ROWID = m.handle_id
    WHERE m.is_from_me = 1
      AND m.ROWID > ?
    ORDER BY m.ROWID {order}
    LIMIT 300
"""


def find_sent_message(phone: str, baseline_rowid: int, first: bool = False) -> dict | None:
    target = normalize_phone_digits(phone)
    rows = _query_chat_db(_FIND_SENT_SQL.format(order="ASC" if first else "DESC"), (baseline_rowid,))
    for rowid, error, is_sent, chat_ident, handle_ident in rows:
        for ident in (chat_ident, handle_ident):
            if ident and normalize_phone_digits(ident) == target:
                return {"rowid": rowid, "error": error or 0, "is_sent": is_sent or 0}
    return None


def get_message_by_rowid(rowid: int) -> dict | None:
    rows = _query_chat_db("SELECT ROWID, error, is_sent FROM message WHERE ROWID = ?", (rowid,))
    if not rows:
        return None
    rowid, error, is_sent = rows[0]
    return {"rowid": rowid, "error": error or 0, "is_sent": is_sent or 0}


def classify(msg: dict) -> str:
    if msg["error"] != 0:
        return "failed"
    if msg["is_sent"] == 1:
        return "sent"
    return "stuck"


def wait_for_delivery(phone: str, baseline_rowid: int | None) -> tuple[str, int | None, str]:
    if baseline_rowid is None:
        return "unverified", None, "발송 전 chat.db 조회 실패"
    elapsed, last_msg, last_error = 0, None, ""
    while elapsed < DELIVERY_TIMEOUT:
        time.sleep(DELIVERY_INTERVAL)
        elapsed += DELIVERY_INTERVAL
        try:
            msg = find_sent_message(phone, baseline_rowid)
        except ChatDBUnavailable as e:
            last_error = str(e)
            continue
        if msg is None:
            continue
        last_msg = msg
        state = classify(msg)
        if state in ("sent", "failed"):
            return state, msg["rowid"], f"error={msg['error']}, is_sent={msg['is_sent']}"
    if last_msg is not None:
        return "stuck", last_msg["rowid"], f"{DELIVERY_TIMEOUT}초가 지나도 전송 중 상태 (is_sent=0)"
    if last_error:
        return "unverified", None, f"chat.db 접근 실패: {last_error}"
    return "unverified", None, "보낸 메시지가 chat.db에 나타나지 않음"


def send_and_verify(phone: str, message: str, retry_failed: bool = True) -> tuple[str, int | None, str, int | None]:
    """발송 + 전달 확인. 실패(확정)면 1회 재전송. 반환: (status, rowid, detail, baseline)"""
    baseline = get_max_rowid()
    if not send_text(phone, message):
        return "failed", None, "AppleScript 발송 명령 실패", baseline
    state, rowid, detail = wait_for_delivery(phone, baseline)
    if state == "failed" and retry_failed:
        log(f"    ⚠ 전송 실패 확인됨 ({detail}) → 재전송")
        baseline = get_max_rowid()
        if send_text(phone, message):
            state, rowid, detail = wait_for_delivery(phone, baseline)
        else:
            detail = "재전송 명령 실패"
    return ("success" if state == "sent" else state), rowid, detail, baseline


def send_with_fallback(phone: str, message: str) -> tuple[bool, str]:
    """관리자용: SMS → 안 되면 iMessage."""
    for service in ("SMS", "iMessage"):
        baseline = get_max_rowid()
        if not send_text(phone, message, service=service, retry=False):
            continue
        state, _, detail = wait_for_delivery(phone, baseline)
        if state == "sent":
            return True, service
        log(f"    ⚠ {service} 전달 안 됨: {STATUS_LABEL.get(state, state)} ({detail})")
    return False, ""


# ── 발송 기록 ────────────────────────────────────────
def record_history(history: list[dict], **entry) -> str:
    ts = datetime.now().isoformat(timespec="seconds")
    entry_id = f"{ts}_{entry.get('key')}"
    history.append({"id": entry_id, "timestamp": ts, **{k: v for k, v in entry.items() if v not in (None, "")}})
    return entry_id


def update_history_status(history: list[dict], entry_id: str, new_status: str, note: str) -> None:
    for e in history:
        if e.get("id") == entry_id:
            if e.get("status") != new_status:
                e["previous_status"] = e.get("status")
                e["status"] = new_status
            e["rechecked_at"] = datetime.now().isoformat(timespec="seconds")
            e["recheck_note"] = note
            return


# ── 재확인 ───────────────────────────────────────────
def recheck_pending(history: list[dict], sheet_updates: dict, manual_keys: set | None = None) -> list[str]:
    pending = _load_json(PENDING_FILE, [])
    if not pending:
        return []
    log(f"이전 발송분 재확인: {len(pending)}건")
    now = datetime.now()
    keep, alerts = [], []
    for p in pending:
        sent_at = datetime.fromisoformat(p["sent_at"])
        age_h = (now - sent_at).total_seconds() / 3600
        label = f"{p['name']} ({p['case']}, {sent_at.month}/{sent_at.day} 발송)"
        # 이전 버전 main.py가 남긴 항목(옛 시트 발송분)은 키가 없어서 시트 기록은 건너뜀
        targets = [(p.get("tab", VIO_SHEET), k) for k in p.get("keys", [p.get("key")]) if k]
        if age_h < RECHECK_AFTER_HOURS:
            keep.append(p)
            continue
        if manual_keys and targets and all(t in manual_keys for t in targets):
            log(f"  - {label}: 관리자가 직접 처리함 → 재확인 생략")
            continue
        try:
            if p.get("message_rowid") is not None:
                msg = get_message_by_rowid(p["message_rowid"])
            elif p.get("baseline_rowid") is not None:
                msg = find_sent_message(p["phone"], p["baseline_rowid"], first=True)
            else:
                msg = None
        except ChatDBUnavailable as e:
            log(f"  ⚠ chat.db 접근 실패로 재확인 보류: {e}")
            keep.append(p)
            continue

        if msg is None:
            if age_h > RECHECK_GIVE_UP_DAYS * 24:
                update_history_status(history, p["history_id"], "unverified", "재확인 기간 내 메시지 못 찾음")
                for t in targets:
                    sheet_updates[t] = (status_text("unverified"), None)
                alerts.append(f"확인 불가: {label} — 메시지 앱에서 직접 확인 필요")
            else:
                keep.append(p)
            continue

        state = classify(msg)
        detail = f"error={msg['error']}, is_sent={msg['is_sent']}"
        if state == "sent":
            if p["status_at_send"] != "success":
                update_history_status(history, p["history_id"], "success", f"재확인 결과 전송 완료 ({detail})")
                for t in targets:
                    sheet_updates[t] = (status_text("success"), None)
                alerts.append(f"참고: {label} — 발송 당시 '{STATUS_LABEL[p['status_at_send']]}'였으나 이후 전송됨 (재발송 불필요)")
            log(f"  ✓ {label}: 전송 완료 확인")
        else:
            update_history_status(history, p["history_id"], state, f"재확인 결과 {STATUS_LABEL[state]} ({detail})")
            for t in targets:
                sheet_updates[t] = (status_text(state), None)
            alerts.append(f"{STATUS_LABEL[state]}(재확인): {label} — 수동 재발송 필요")
    _save_json(PENDING_FILE, keep)
    return alerts


# ── 위반자 1명 처리 ──────────────────────────────────
def process_target(r: dict, sent_keys: set, history: list, pending: list, sheet_updates: dict) -> list[str]:
    key = row_key(r)
    name, phone, case = str(r["이름"]).strip(), str(r["전화"]).strip(), r["구분"]
    label = f"{name} ({r.get('n번째')}회 {case})"

    if key in sent_keys:
        # 지난 실행에서 보냈지만 시트 기록이 실패했던 경우 → 상태만 다시 기록
        log(f"  - 이미 발송됨(시트 기록만 보정): {label}")
        sheet_updates[(VIO_SHEET, key)] = ("발송됨", None)
        return []
    if not phone:
        sheet_updates[(VIO_SHEET, key)] = ("번호 없음", datetime.now())
        return [f"번호 없음: {label} — 수동 확인 필요"]

    try:
        message = build_message(r)
    except Exception as e:
        log(f"  ✗ 문구 생성 실패: {e}")
        return [f"문구 생성 실패: {label} — {e}"]

    target = TEST_PHONE_NUMBER if TEST_MODE else phone
    log(f"  → {label} 발송 중..." + (f" [TEST → {target}]" if TEST_MODE else ""))
    status, rowid, detail, baseline = send_and_verify(target, message)
    log(f"    {STATUS_LABEL[status]} ({detail})")

    sheet_updates[(VIO_SHEET, key)] = (status_text(status), datetime.now())
    if status != "failed" and not TEST_MODE:
        sent_keys.add(key)  # 멈춤·확인불가도 늦게 전송될 수 있어 중복 방지
    hid = record_history(history, key=key, name=name, phone=phone, count=r.get("n번째"), case=case,
                         status=status, detail="" if status == "success" else detail,
                         message_rowid=rowid, test=TEST_MODE or None)
    if status != "failed" and not TEST_MODE:
        pending.append({
            "history_id": hid, "tab": VIO_SHEET, "keys": [key], "name": name, "phone": target, "case": case,
            "sent_at": datetime.now().isoformat(timespec="seconds"),
            "status_at_send": status, "message_rowid": rowid, "baseline_rowid": baseline,
        })

    if status == "failed":
        return [f"실패: {label} — 수동 재발송 필요"]
    if status == "stuck":
        return [f"멈춤: {label} — 메시지 앱 확인 후 필요하면 수동 재발송"]
    if status == "unverified":
        return [f"확인 불가: {label} — chat.db 권한 또는 메시지 앱 확인"]
    return []


# ── 예약 삭제 안내 ───────────────────────────────────
# '삭제 처리' 탭에서 상태가 '완료'가 된(= 사이트에서 실제로 삭제된) 건만 보냄 → 항상 삭제 '이후'에 발송
DELETE_REASON_TEXT = {
    "RESTRICT1": "세미나실 이용 제한 기간 중 예약",
    "RESTRICT2": "세미나실 이용 제한 기간 중 예약",
    "PERM": "세미나실 이용 계정 삭제 대상자의 예약",
    "HOLIDAY": "공휴일 예약",
    "PEOPLE": "이용 인원 미달 (대표자 포함 {min_people}인 이상)",
    "STUDENT_ID": "학번 미기재 또는 오기재",
    "DUP_ID": "이용자 학번 중복 기재",
    "NAME": "이름 미기재 또는 오기재",
    "PHONE": "연락처 오기재",
}
INFO_CODES = {"PEOPLE", "STUDENT_ID", "DUP_ID", "NAME", "PHONE"}
WEEKDAY_KO = "월화수목금토일"

DELETE_TEMPLATE = (
    "[세미나실 예약 삭제 안내]\n"
    "안녕하세요 {name}님, 글로벌경영학과 17대 학생회 행정복지부입니다.\n\n"
    "아래 세미나실 예약이 삭제되었음을 안내드립니다.\n\n"
    "- 예약: {when} {room}호\n"
    "- 사유: {reasons}\n\n"
    "{tail}"
    "글로벌경영학과 모두의 쾌적한 세미나실 이용을 위한 절차이오니 양해 부탁드립니다. 감사합니다."
)
def codes_of(r: dict) -> set[str]:
    """사유코드 열 → 코드 집합. 비어 있으면(수동 추가 건) 사유 문구로 추정."""
    codes = {c.strip() for c in str(r.get("사유코드", "")).split(",") if c.strip()}
    if codes:
        return codes
    text = str(r.get("사유", ""))
    guess = {"영구": "PERM", "제한": "RESTRICT1", "공휴일": "HOLIDAY", "인원": "PEOPLE",
             "학번": "STUDENT_ID", "이름": "NAME", "전화": "PHONE", "중복 예약": "DUP_RESV"}
    return {c for k, c in guess.items() if k in text}


def build_delete_message(group: list[dict], min_people: int) -> str:
    r = group[0]
    d = serial_to_date(r["예약일"])
    when = f"{d.month}월 {d.day}일({WEEKDAY_KO[d.weekday()]}) {r['시간']}" if d else str(r["시간"])
    name, room = str(r["이름"]).strip(), str(r["호실"]).strip()
    codes = set().union(*(codes_of(x) for x in group))

    reasons, seen = [], set()
    for c in ["PERM", "RESTRICT1", "RESTRICT2", "HOLIDAY", "PEOPLE", "STUDENT_ID", "DUP_ID", "NAME", "PHONE"]:
        if c in codes:
            t = DELETE_REASON_TEXT[c].format(min_people=min_people)
            if t not in seen:
                seen.add(t)
                reasons.append(t)
    if not reasons:  # 코드도 키워드도 없는 수동 사유
        reasons = [str(r.get("사유", "")).strip() or "세미나실 이용수칙 위반"]

    if "PERM" in codes:
        tail = ""
    elif codes & {"RESTRICT1", "RESTRICT2"}:
        tail = "제한 기간이 끝난 뒤 다시 예약해주시기 바랍니다.\n\n"
    elif codes & INFO_CODES:
        tail = "<글로벌경영학과 세미나실 이용수칙>에 맞게 이용자 정보를 정확히 입력하여 다시 예약해주시기 바랍니다.\n\n"
    elif "HOLIDAY" in codes:
        tail = "공휴일을 제외한 날짜로 다시 예약해주시기 바랍니다.\n\n"
    else:
        tail = ""
    return DELETE_TEMPLATE.format(name=name, when=when, room=room, reasons=", ".join(reasons), tail=tail)


def select_deletion_groups(rows: list[dict], now: datetime) -> tuple[list[list[dict]], list[dict], list[dict]]:
    """
    삭제 완료됐고 아직 안내 안 한 건을 같은 예약(전화·날짜·시간·호실)끼리 묶음
    → (보낼 묶음, 기한 지난 행, 중복 예약으로만 지운 행)
    중복 예약으로만 지운 건은 남은 1건으로 그대로 이용하므로 문자를 보내지 않음.
    """
    groups: dict[tuple, list[dict]] = {}
    expired, dup_only = [], []
    for r in rows:
        if str(r.get("상태", "")).strip() != "완료" or already_handled(r.get("문자 상태")):
            continue
        if str(r.get("처리자", "")).strip() == "(이전 기록)":
            continue
        if codes_of(r) == {"DUP_RESV"}:
            dup_only.append(r)
            continue
        done = r.get("처리 일시")
        done_at = (SHEET_EPOCH + timedelta(days=float(done))) if done not in ("", None) else None
        if done_at and now - done_at > timedelta(days=DELETE_LOOKBACK_DAYS):
            expired.append(r)
            continue
        k = ("".join(ch for ch in str(r["전화"]) if ch.isdigit()), r["예약일"], str(r["시간"]), str(r["호실"]))
        groups.setdefault(k, []).append(r)
    return list(groups.values()), expired, dup_only


def run_deletion_notices(sheet: Sheet, sent_keys: set, history: list, pending: list,
                         sheet_updates: dict) -> list[str]:
    try:
        _, rows = sheet.read_deletions()
    except Exception as e:  # noqa: BLE001
        return [f"삭제 처리 탭 읽기 실패 (upgradeToV2 실행 필요?): {e}"]
    try:
        v = sheet.named("CFG_MIN_PEOPLE")
        min_people = int(v[0][0]) if v and v[0] else 3
    except Exception:  # noqa: BLE001
        min_people = 3

    groups, expired, dup_only = select_deletion_groups(rows, datetime.now())
    alerts = []
    for r in dup_only:
        sheet_updates[(DEL_SHEET, str(r["예약ID"]))] = ("발송 안 함", datetime.now())
    if dup_only:
        log(f"중복 예약으로만 삭제된 {len(dup_only)}건은 문자 없이 '발송 안 함'으로 기록")
    for r in expired:
        sheet_updates[(DEL_SHEET, str(r["예약ID"]))] = ("기한 지남", datetime.now())
        alerts.append(f"삭제 안내 기한 지남: {r['이름']} ({r['사유']}) — 수동 발송 필요")
    if not groups:
        return alerts

    log(f"삭제 안내 대상 {len(groups)}건")
    ensure_messages_running()
    for g in groups:
        ids = [str(x["예약ID"]) for x in g]
        name, phone = str(g[0]["이름"]).strip(), str(g[0]["전화"]).strip()
        label = f"{name} 삭제 안내 ({g[0]['사유']})"
        if all(f"del:{i}" in sent_keys for i in ids):
            for i in ids:
                sheet_updates[(DEL_SHEET, i)] = ("발송됨", None)
            continue
        digits = "".join(ch for ch in phone if ch.isdigit())
        if not (len(digits) == 11 and digits.startswith("010")):
            for i in ids:
                sheet_updates[(DEL_SHEET, i)] = ("번호 없음", datetime.now())
            alerts.append(f"번호 없음: {label} — 번호가 잘못돼 삭제 안내를 못 보냄")
            continue

        message = build_delete_message(g, min_people)
        target = TEST_PHONE_NUMBER if TEST_MODE else phone
        log(f"  → {label}" + (f" [TEST → {target}]" if TEST_MODE else ""))
        status, rowid, detail, baseline = send_and_verify(target, message)
        log(f"    {STATUS_LABEL[status]} ({detail})")
        for i in ids:
            sheet_updates[(DEL_SHEET, i)] = (status_text(status), datetime.now())
            if status != "failed" and not TEST_MODE:
                sent_keys.add(f"del:{i}")
        hid = record_history(history, key="del:" + ",".join(ids), name=name, phone=phone, case="삭제 안내",
                             status=status, detail="" if status == "success" else detail,
                             message_rowid=rowid, test=TEST_MODE or None)
        if status != "failed" and not TEST_MODE:
            pending.append({"history_id": hid, "tab": DEL_SHEET, "keys": ids, "name": name, "phone": target,
                            "case": "삭제 안내", "sent_at": datetime.now().isoformat(timespec="seconds"),
                            "status_at_send": status, "message_rowid": rowid, "baseline_rowid": baseline})
        else:
            alerts.append(f"실패: {label} — 수동 재발송 필요")
        if status == "stuck":
            alerts.append(f"멈춤: {label} — 메시지 앱 확인")
        elif status == "unverified":
            alerts.append(f"확인 불가: {label}")
    return alerts


# ── 관리자 로테이션 ──────────────────────────────────
def load_rotation(sheet: Sheet) -> list[tuple[date, str]]:
    starts = sheet.named("ROT_START")
    mgrs = sheet.named("ROT_MGR")
    out = []
    for i, s in enumerate(starts):
        d = serial_to_date(s[0] if s else "")
        name = str(mgrs[i][0]).strip() if i < len(mgrs) and mgrs[i] else ""
        if d and name:
            out.append((d, name))
    return sorted(out)


def manager_on(rotation: list[tuple[date, str]], d: date) -> tuple[str, date] | None:
    """d가 속한 주의 (담당자, 시작일)."""
    found = None
    for start, name in rotation:
        if start <= d <= start + timedelta(days=6):
            found = (name, start)
    return found


def load_contacts(sheet: Sheet) -> dict[str, str]:
    out = {}
    for row in sheet.named("MGR_CONTACTS"):
        if len(row) >= 2 and str(row[0]).strip() and str(row[1]).strip():
            out[str(row[0]).strip()] = str(row[1]).strip()
    return out


def dashboard_numbers(sheet: Sheet, rows: list[dict]) -> dict:
    """교대 문자에 넣을 숫자. 대시보드와 같은 기준으로 계산."""
    today = date.today()
    restricted = sum(
        1 for r in rows
        if (s := serial_to_date(r.get("제한 시작"))) and (e := serial_to_date(r.get("제한 만료"))) and s <= today <= e
    )
    bad = ("실패", "멈춤", "확인 불가", "기한 지남", "번호 없음")
    issues = sum(1 for r in rows if str(r.get("문자 상태", "")).strip() in bad)
    try:
        _, drows = sheet.read_deletions()
        issues += sum(1 for r in drows if str(r.get("문자 상태", "")).strip() in bad)
    except Exception:  # noqa: BLE001
        pass
    pending = 0
    try:
        res = sheet._retry(lambda: sheet.ss.values_get("'삭제 처리'!H2:H"))
        pending = sum(1 for v in res.get("values", []) if v and v[0] == "대기")
    except Exception as e:  # noqa: BLE001
        log(f"  ⚠ 삭제 처리 탭 읽기 실패: {e}")
    link = ""
    try:
        v = sheet.named("CFG_DASH_URL")
        link = str(v[0][0]) if v and v[0] else ""
    except Exception:  # noqa: BLE001
        pass
    return {"pending": pending, "restricted": restricted, "sms_issues": issues, "link": link}


def rotation_plan(now: datetime, rotation: list[tuple[date, str]]) -> list[tuple[str, str, str, date, date]]:
    """
    지금 보내야 할 교대 안내 목록: [(kind, role, 이름, 담당 시작일, 담당 종료일)]
    kind: 'sun' | 'mon',  role: 'in' | 'out' | 'both'
    """
    today = now.date()
    if today.weekday() == 6 and now.hour >= SUNDAY_EVENING_FROM:
        kind, out_day, in_day = "sun", today, today + timedelta(days=1)
    elif today.weekday() == 0 and MONDAY_MORNING[0] <= now.hour < MONDAY_MORNING[1]:
        kind, out_day, in_day = "mon", today - timedelta(days=1), today
    else:
        return []

    out_m, in_m = manager_on(rotation, out_day), manager_on(rotation, in_day)
    plan = []
    if out_m and in_m and out_m[0] == in_m[0]:
        if kind == "sun":  # 같은 사람이 연속 담당 → 일요일에 한 번만
            plan.append((kind, "both", in_m[0], in_m[1], in_m[1] + timedelta(days=6)))
        else:
            plan.append((kind, "in", in_m[0], in_m[1], in_m[1] + timedelta(days=6)))
        return plan
    if out_m:
        plan.append((kind, "out", out_m[0], out_m[1], out_m[1] + timedelta(days=6)))
    if in_m:
        plan.append((kind, "in", in_m[0], in_m[1], in_m[1] + timedelta(days=6)))
    return plan


def build_rotation_message(kind: str, role: str, name: str, start: date, end: date,
                           nums: dict, incoming: str | None) -> str:
    p = nums["pending"]
    pending_line = (f"아직 삭제할 예약이 {p}건 남아 있습니다. 가능하면 오늘 처리 부탁드립니다."
                    if p else "남은 삭제 대상 없이 깔끔하게 마무리되었습니다.")
    handover_line = (f"미처리 삭제 대상 {p}건은 {incoming}님께 인계됩니다." if p and incoming
                     else ("미처리 삭제 대상 " + str(p) + "건이 남아 있습니다." if p else "남은 삭제 대상은 없습니다."))
    return ROTATION_TEMPLATES[(kind, role)].format(
        name=name, start=format_md(start), end=format_md(end),
        pending=p, restricted=nums["restricted"], sms_issues=nums["sms_issues"],
        link=nums["link"], pending_line=pending_line, handover_line=handover_line,
    ).rstrip()


def run_rotation(sheet: Sheet, rows: list[dict]) -> list[str]:
    now = datetime.now()
    try:
        rotation = load_rotation(sheet)
    except Exception as e:  # noqa: BLE001
        return [f"로테이션 표 읽기 실패: {e}"]
    plan = rotation_plan(now, rotation)
    if not plan:
        return []

    sent = _load_json(ROTATION_LOG_FILE, {})
    contacts = load_contacts(sheet)
    nums = dashboard_numbers(sheet, rows)
    incoming = next((n for k, role, n, *_ in plan if role in ("in", "both")), None)
    alerts = []
    ensure_messages_running()
    for kind, role, name, start, end in plan:
        key = f"{now.date().isoformat()}_{kind}_{role}_{name}"
        if key in sent:
            continue
        phone = contacts.get(name)
        if not phone:
            alerts.append(f"교대 안내 못 보냄: {name} 전화번호가 설정 탭에 없음")
            continue
        msg = build_rotation_message(kind, role, name, start, end, nums, incoming)
        target = TEST_PHONE_NUMBER if TEST_MODE else phone
        log(f"  → 교대 안내 ({kind}/{role}) {name}" + (f" [TEST → {target}]" if TEST_MODE else ""))
        ok, service = send_with_fallback(target, msg)
        if ok:
            sent[key] = {"at": now.isoformat(timespec="seconds"), "service": service}
        else:
            alerts.append(f"교대 안내 전송 실패: {name} ({kind}/{role})")
    if not TEST_MODE:
        _save_json(ROTATION_LOG_FILE, sent)
    return alerts


# ── 관리자 알림 ──────────────────────────────────────
def dedupe_alerts(lines: list[str]) -> list[str]:
    """같은 문구를 ALERT_REPEAT_HOURS 안에 이미 보냈으면 빼기 (실행이 잦아져도 같은 알림이 반복되지 않게)."""
    now = datetime.now()
    sent = _load_json(ALERT_SENT_FILE, {})
    sent = {k: v for k, v in sent.items()
            if now - datetime.fromisoformat(v) < timedelta(hours=ALERT_REPEAT_HOURS)}
    fresh = [l for l in lines if l not in sent]
    for l in fresh:
        sent[l] = now.isoformat(timespec="seconds")
    if not TEST_MODE:
        _save_json(ALERT_SENT_FILE, sent)
    return fresh


def notify_admin(lines: list[str], extra_phones: list[str]) -> None:
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
    body = f"[SRMA 알림 {stamp}]\n" + "\n".join(f"- {line}" for line in lines)
    with ALERT_FILE.open("a") as f:
        f.write(body + "\n\n")
    subprocess.run(
        ["osascript", "-e",
         f'display notification "{_applescript_str(lines[0])} 외 {len(lines) - 1}건" '
         f'with title "SRMA 문자 발송 이상" sound name "Basso"'],
        capture_output=True,
    )
    ensure_messages_running()
    recipients = [ADMIN_PHONE_NUMBER] + [p for p in extra_phones
                                         if normalize_phone_digits(p) != normalize_phone_digits(ADMIN_PHONE_NUMBER)]
    for phone in recipients:
        ok, service = send_with_fallback(phone, body)
        log(f"  (알림 → {phone}: {'완료 ' + service if ok else '실패'})")


# ── 메인 ─────────────────────────────────────────────
def main() -> tuple[list[str], list[str], str]:
    """반환: (알림 문구, 추가 알림 수신 번호, 하트비트 요약)"""
    print(f"\n{'=' * 60}\n실행 시작: {datetime.now():%Y-%m-%d %H:%M:%S}\n{'=' * 60}")
    sent_keys = set(_load_json(SENT_LOG_FILE, []))
    history = _load_json(HISTORY_FILE, [])
    alerts: list[str] = []
    sheet_updates: dict = {}
    extra_phones: list[str] = []
    summary = ""
    sheet = None

    try:
        sheet = Sheet()
        _, rows = sheet.read_violations()

        # 이상 알림은 최고 관리자(ADMIN_PHONE_NUMBER)에게만 보냄 (v4.8부터 그 주 담당자 제외)

        # 1) 지난 발송분 재확인 (관리자가 '수동 발송'·'발송 안 함'으로 바꾼 건은 건너뜀)
        manual_keys = {(VIO_SHEET, row_key(r)) for r in rows if str(r.get("문자 상태", "")).strip() in MANUAL_STATUSES}
        try:
            _, drows = sheet.read_deletions()
            manual_keys |= {(DEL_SHEET, str(r.get("예약ID", "")).strip()) for r in drows
                            if str(r.get("문자 상태", "")).strip() in MANUAL_STATUSES}
        except Exception as e:  # noqa: BLE001
            log(f"  ⚠ 삭제 처리 탭 읽기 실패(재확인 예외 판단): {e}")
        alerts += recheck_pending(history, sheet_updates, manual_keys)

        # 2) 위반자 발송 (새벽 실행에서는 건너뜀)
        today = date.today()
        if datetime.now().hour >= VIOLATION_SEND_FROM:
            targets, expired = select_targets(rows, today)
        else:
            targets, expired = [], []
            log(f"위반 안내는 {VIOLATION_SEND_FROM}시 이후 실행에서 발송")
        for r in expired:
            if row_key(r) in sent_keys:  # 보냈는데 시트 기록만 빠진 경우
                sheet_updates[(VIO_SHEET, row_key(r))] = ("발송됨", None)
                continue
            sheet_updates[(VIO_SHEET, row_key(r))] = ("기한 지남", datetime.now())
            alerts.append(f"기한 지남(미발송): {r['이름']} ({r.get('구분')}, 누적일 {format_md(serial_to_date(r['누적일']))}) — 수동 발송 필요")
        if targets:
            log(f"발송 대상 {len(targets)}건")
            ensure_messages_running()
            pending = _load_json(PENDING_FILE, [])
            try:
                for r in targets:
                    alerts += process_target(r, sent_keys, history, pending, sheet_updates)
            finally:
                _save_json(PENDING_FILE, pending)
        elif datetime.now().hour >= VIOLATION_SEND_FROM:
            log("위반자 발송 대상 없음.")

        # 3) 예약 삭제 안내 (삭제 완료된 건)
        pending = _load_json(PENDING_FILE, [])
        try:
            alerts += run_deletion_notices(sheet, sent_keys, history, pending, sheet_updates)
        finally:
            _save_json(PENDING_FILE, pending)

        # 4) 교대 안내
        alerts += run_rotation(sheet, rows)

        summary = f"위반 안내 {len(targets)}건, 기한 지남 {len(expired)}건, 알림 {len(alerts)}건"
    finally:
        _save_json(SENT_LOG_FILE, sorted(sent_keys))
        _save_json(HISTORY_FILE, history)
        if sheet is not None and sheet_updates:
            try:
                sheet.write_statuses(sheet_updates)
            except Exception as e:  # noqa: BLE001
                alerts.append(f"시트에 문자 상태 기록 실패: {e}")

    return alerts, extra_phones, summary


class RunTimeout(Exception):
    pass


def _on_timeout(signum, frame):
    raise RunTimeout(f"실행이 {MAX_RUN_SECONDS // 60}분을 넘어 중단")


if __name__ == "__main__":
    ok, extra, summary = True, [], ""
    signal.signal(signal.SIGALRM, _on_timeout)
    signal.alarm(MAX_RUN_SECONDS)
    try:
        alerts, extra, summary = main()
    except Exception as e:  # noqa: BLE001  (RunTimeout 포함)
        traceback.print_exc()
        ok = False
        summary = f"{type(e).__name__}: {e}"
        alerts = [f"스크립트 오류로 중단됨: {summary}"]
    signal.alarm(0)

    # 하트비트 (실패해도 계속). 마무리 단계도 시간 제한: 하트비트 2분, 알림 5분
    signal.alarm(120)
    try:
        Sheet().heartbeat(ok, summary or "완료")
    except Exception as e:  # noqa: BLE001
        log(f"  ⚠ 하트비트 기록 실패: {e}")
    signal.alarm(0)
    signal.alarm(300)

    if alerts:
        print("\n⚠️  확인 필요:")
        for line in alerts:
            print(f"   - {line}")
        fresh = dedupe_alerts(alerts)
        if fresh and not TEST_MODE:
            notify_admin(fresh, extra)
        elif not fresh:
            print("   (모두 최근에 알린 내용이라 문자는 생략)")
    signal.alarm(0)
    print(f"실행 종료: {datetime.now():%Y-%m-%d %H:%M:%S}\n")
