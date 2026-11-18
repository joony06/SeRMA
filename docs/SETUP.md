# SeRMA 설치

> 기준: Apps Script v8.x, SeSMA main.py v4.9p

## 코드 받기

```bash
git clone https://github.com/joony06/SeRMA.git
```

## 준비물

- Google 계정 (관리 시트 소유자)
- 예약 사이트 Firebase 정보: 웹 API 키, 프로젝트 ID, 사이트 관리자 계정 이메일·비밀번호, 사이트가 쓰는 AES 키·IV (hex)
- SeSMA용: macOS가 설치된 맥 1대 (항상 켜 둠), 문자 메시지 전달이 되는 아이폰, Python 3.10+
- Google Cloud 서비스 계정 키 (SeSMA가 시트를 읽고 씀)

---

## 1. 관리 시트 만들기 (Apps Script)

1. 빈 Google 스프레드시트를 만들고 **확장 프로그램 > Apps Script**를 엽니다.
2. `apps_script/`의 `.gs` 13개를 같은 이름으로 추가하고 내용을 붙여넣은 뒤 저장합니다.
3. **프로젝트 설정(⚙️)**
   - 시간대: `(GMT+09:00) 서울` (아니면 스크립트가 실행을 막습니다)
   - 스크립트 속성 5개: `FB_API_KEY`, `FB_EMAIL`, `FB_PW`, `AES_KEY`, `AES_IV`
     (AES 키·IV는 예약 사이트와 **같은 값**이어야 합니다)
4. 코드에서 예시 값 바꾸기
   - `Config.gs` `FB_PROJECT`: Firebase 프로젝트 ID
   - `Dashboard.gs` `DASH.SITE_URL`: 예약 사이트 주소
   - `Setup.gs` `SEED`: 현재 학기 이름, 관리자 이름·로테이션 순서, 영구 제한자, 공휴일
   - `Settings.gs` `SEMESTER_DEFAULT`: 학기 기간, `SUPER_ADMIN_DEFAULT_PHONE`: 최고 관리자 번호(선택)
5. 편집기에서 `setupNewStructure` 실행 → 권한 허용 (스프레드시트, 외부 요청, Gmail 발송, 캘린더)
   - 탭 생성: 대시보드 / 위반 기록 / 삭제 처리 / 통계 / 설정 / (숨김) 로그·아카이브·예약 기록
6. 설정 탭에서 관리자 이름·전화, 최고 관리자 체크, 학기 기간을 확인합니다.
7. `installTriggers` 실행 → 트리거 4개 확인
   - `run` 매일 00:05 / `step4_findRestrictedReservations` 매시간 / `onDeleteEdit_` 편집 시 / `tick10min` 10분
8. 시트를 새로고침하면 상단에 **SeRMA 관리** 메뉴가 생깁니다.
   - 공휴일 불러오기 → 예약 기록 가져오기 → 로테이션 채우기

사이트 데이터 구조가 예상과 다르면 `inspectReservationFields`를 실행해 로그를 확인합니다 (값은 가려서 보여 줌).

---

## 2. SeSMA 설정 (맥)

```bash
mkdir -p ~/sesma && cd ~/sesma
# 이 저장소의 sesma/ 파일을 복사
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
cp config.example.json config.json   # 값 채우기
```

1. `config.json`
   - `spreadsheet_id`: 관리 시트 ID
   - `admin_phone_number`: 이상 알림을 받을 번호
   - `test_phone_number`: 테스트 모드에서 모든 문자를 받을 번호
   - `test_mode`: 처음엔 `true`
2. 서비스 계정 키를 `service-account.json`으로 저장하고, 서비스 계정 이메일을 관리 시트에 **편집자**로 공유합니다.
   - 설정 탭은 보호되지만 `ST_MAC` 칸(하트비트)은 예외로 열려 있습니다.
3. 아이폰: 설정 > 메시지 > 문자 메시지 전달에서 이 맥을 켭니다. 맥 메시지 앱에 로그인합니다.
4. 시스템 설정 > 개인정보 보호 및 보안 > **전체 디스크 접근 권한**에 `venv/bin/python3`(또는 터미널)을 추가합니다. `chat.db`로 전달 여부를 확인하는 데 필요합니다.
5. 한 번 수동 실행: `./venv/bin/python3 main.py` → 메시지 앱 제어 권한을 허용합니다.
6. 자동 실행 등록
   ```bash
   sed "s#/path/to/sesma#$HOME/sesma#g" com.seminar.sms.plist.example > ~/Library/LaunchAgents/com.seminar.sms.plist
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.seminar.sms.plist
   launchctl kickstart gui/$(id -u)/com.seminar.sms
   ```
7. 맥이 잠들지 않게 합니다 (예: Amphetamine).
8. 하루 정도 테스트 번호로 돌려 보고, 문제가 없으면 `test_mode`를 `false`로 바꿉니다.

### 실행 일정과 동작

- launchd: 5~23시 매 정각
- 위반 안내는 7시 이후 실행에서만 발송, 삭제 안내는 상태가 '완료'가 된 다음 실행에서 발송
- 발송 직후와 6시간 뒤에 `chat.db`로 성공·실패·멈춤을 확인하고, 실패하면 1회 재전송
- 결과는 시트 '문자 상태' 열에, 문제가 있으면 관리자 번호로 알림

### 자주 쓰는 명령

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.seminar.sms.plist   # 멈추기
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.seminar.sms.plist # 다시 등록
pgrep -fl main.py   # 멈춘 실행 확인
pkill -f main.py    # 멈춘 실행 종료
tail -f ~/sesma/log.txt
```

---

## 3. 일상 운영

1. 대시보드에서 **삭제할 예약** 확인
2. 예약 사이트 관리자 페이지에서 그 예약 삭제
3. **삭제 처리** 탭에서 상태를 **'완료'**로 (오탐이면 '예외') → 처리자·시각 자동 기록, SeSMA가 삭제 안내 발송
4. 문자 발송 문제가 생기면 직접 보낸 뒤 문자 상태를 '수동 발송'으로

새 학기 시작일에는 **SeRMA 관리 > 학기 전환**을 실행합니다 (1주 전·당일 메일로 알려 줌).
