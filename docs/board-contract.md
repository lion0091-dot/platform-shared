# 게시판 공용 계약 `board_contract_version` v1

상태: **구현(로컬, 미커밋)과 함께 쓴 계약 문서.** 태그 후보 `v0.4.0-rc.1`(생성은 개발자 승인 뒤). 근거: `docs/design-two-tier-board-shared-2026-11.md`(확정 결정 #1~#58), `docs/ops-staff-screen-common-rules-2026-11.md`. 코드: `src/board/` (`@platform/shared/board`).
공용은 **코드값·순수 함수·상수**만 둔다. 화면·표·RPC·알림·저장·크론·EXIF 제거는 **앱 몫**이다.

## 1. 계약 버전 규칙
- 열·값 **추가**는 하위 호환(소비 쪽은 모르는 값을 무시). 이름·값 **변경·삭제**는 `board_contract_version` 을 올린다.
- v1 은 공용 첫 태그와 동시에 확정한다(결정 #31). 확정 전에는 앱 마이그를 쓰지 않는다.

## 2. 코드값 (src/board/codes.ts)
| 이름 | 값 |
|---|---|
| 앱 키 `app_key` | `shipping` · `wholesale` · `ledgercore` |
| 분석 뷰 | `board_escalations_v` (열: `app_key, post_id, tenant_id, category, escalation_status, created_at, escalated_at, first_response_at, closed_at, updated_at, title, body, reply_count`) |
| 1층 분류 | `NOTICE`(직원만) · `QUESTION` · `HANDOVER`(직원 내부) · `SUGGESTION`. 앱이 더 추가 가능(분석 대상 아님). 일반 사용자 작성 가능 = `QUESTION`·`SUGGESTION` |
| 2층 분류 | `BUG` · `FEATURE` · `ACCOUNT` · `ETC` (청구·계약 문의 없음) |
| 2층 상태 | `RECEIVED` · `IN_PROGRESS` · `NEED_INFO` · `DONE` · `DECLINED` (1층 글은 `NONE`) |
| 작성자 유형 `author_kind` | `STAFF` · `USER` — **글과 답글 모두** 가짐. `USER` 없는 앱은 `STAFF` 만 |
| 답글 가시성 | `AUTHOR`(작성자에게 보임) · `TENANT_ONLY`(직원 메모) · `PLATFORM`(2층 답) |
| 오류 코드 | `BOARD_ERRORS` 참조(문자열만, 값·개인정보를 담지 않음) |

## 3. 가시 범위 (canView / canViewReply)
| 보는 사람 | 1층 글 | 1층 답글 | 2층 글 |
|---|---|---|---|
| `USER` | 자기 글만 | 자기 글의 `AUTHOR` 답글만 | 안 보임 |
| `STAFF` | 자기 테넌트 전부 | 전부(`TENANT_ONLY` 포함) | 자기 테넌트가 올린 것 + 플랫폼 답변 |
| `PLATFORM` | 안 보임(건수에도 없음) | 안 보임 | 승격된 것만, `PLATFORM` 답글만 |
- `sameTenant`(글의 테넌트 = 보는 사람의 테넌트)는 **앱이 계산해 넘긴다.** 넘기지 않으면 거짓으로 보고 거부한다.
- 이 함수는 **계약이자 시험 기준**이다. 최종 강제는 앱의 서버 액션과 DB(RPC 안에서 소속·권한 재검사, RLS)이다(결정 #28).

## 4. 쓰기·답글·승격
- `canReply`: 1층은 직원, 그리고 일반 사용자 본인(자기 글). 2층은 직원·플랫폼, **`DECLINED` 글은 답글 불가**(재문의는 새 글). `allowedReplyVisibilities` 는 작성 가능한 가시성을 돌려준다(직원 1층: `AUTHOR`·`TENANT_ONLY`, 사용자: `AUTHOR`, 2층: `PLATFORM`).
- `canEscalate`: 직원(STAFF) **전원** + 자기 테넌트 + 아직 승격 안 된 1층 글(역할 구분 없음). 일반 사용자는 직접 못 올린다. `hasEscalateRole` 은 승격 판정에서 무시한다(호환용).
- `validateEscalation`: 2층 분류, 「개인정보 없음 확인」 체크, 제목·본문 비어 있지 않음, 승격 사유 1~500자, **제목·본문 `detectPii` 재검사**. 오류는 코드 목록으로, 걸린 개인정보는 **종류만** 알려 준다. 승격 때 작성자 유형·이름·연락처·1층 대화는 2층에 넘기지 않는다(앱).
- 일반 사용자에게 승격 사실을 알리지 않는다(결정 #14).

## 5. 전이표 (canTransition, 벡터 `src/board/__vectors__/transitions.json`)
| 현재 | 다음 | 누가 |
|---|---|---|
| NONE | RECEIVED(승격) | TENANT, **직원 전원**. 한 방향 |
| RECEIVED | IN_PROGRESS · NEED_INFO · DONE · DECLINED | PLATFORM |
| IN_PROGRESS | NEED_INFO · DONE · DECLINED | PLATFORM |
| NEED_INFO | RECEIVED | TENANT |
| DONE | RECEIVED(재오픈) | TENANT, 관리 권한자(`hasEscalateRole`: 대표·매니저급, 앱이 판정) |
| DECLINED | — | 끝(재문의는 새 글) |
- `requiresReason(to)`: `DECLINED`·`NEED_INFO` 는 사유(답글) 필수.
- DB 는 `for update` + `ALREADY_PROCESSED` 로 강제(앱). **앱은 이 벡터와 자기 DB 구현을 대조하는 시험을 둔다.** 동시·중복 호출 요구는 아래 5-1.
- `needsStaffReply`: 1층 글에 답이 없거나 마지막 답글 작성자가 `STAFF` 가 아니면 참(합산 수신함 「처리 필요」, 결정 #33). 종료·숨김 글 제외는 호출하는 쪽 조건.

### 5-1. 동시성·중복 호출 요구 (앱 필수 — 공용 함수는 보장하지 못한다)
`canEscalate`·`canTransition`·`validateEscalation`·`canAttachToReply` 는 **입력으로 받은 값만 보는 순수 함수**다. 상태를 저장하거나 잠그지 않으므로, 호출 시점에 읽은 상태(`escalated`, `from`)는 판정 직후 다른 요청이 바꿔 놓았을 수 있다(읽고 쓰는 사이의 경합). 승격이 직원 전원으로 열려 있어 **두 직원이 같은 글을 동시에 올리는 일**이 실제로 생길 수 있다. 아래는 세 앱이 같게 지켜야 하는 최소 요구다.
1. **전이는 DB 한 문장·한 트랜잭션에서 조건부로**: 판정에 쓴 `from` 상태를 조건에 넣는다(`UPDATE ... SET status = :to WHERE id = :id AND status = :from`, 또는 RPC 안에서 `SELECT ... FOR UPDATE` 후 `from` 재확인). **영향 행 수 0 이면 이미 다른 요청이 처리한 것**이므로 후속 반영(알림·감사·답글·분석 뷰 행)을 하지 않고 `ALREADY_PROCESSED` 로 응답한다. 서버 액션이 읽은 값만 믿고 UPDATE 하지 않는다.
2. **승격은 글당 한 번만 — 저장소가 보장**: 2층 글 생성(분석 뷰 행·`escalated` 표시)은 1층 글 id 에 대한 **유니크 제약 또는 `FOR UPDATE` 로 보호된 단일 RPC**로 한다. 같은 글 동시 승격 2건 중 하나만 성공하고 나머지는 `ALREADY_PROCESSED` 이며, 실패한 쪽은 2층 글·알림·감사를 만들지 않는다.
3. **재오픈(`DONE → RECEIVED`)·`NEED_INFO → RECEIVED`·플랫폼 전이도 같은 규칙**: 서로 반대편의 동시 전이(예: 플랫폼 `IN_PROGRESS → DONE` 과 직원 쪽 전이)는 `from` 조건 때문에 한쪽만 이긴다. 진 쪽은 오류가 아니라 「이미 처리됨, 새로고침」 안내로 응답한다.
4. **같은 요청의 재전송(더블 클릭·재시도·네트워크 재전송)은 부작용 없이 같은 결과**: 1~3 으로 두 번째는 영향 행 0 이 되므로 알림·감사·사유 답글이 **두 번 생기지 않아야** 한다. 사유가 필요한 전이(`requiresReason`)의 사유 답글은 전이와 **같은 트랜잭션**에서 쓴다(전이만 되고 사유가 없거나, 사유만 두 번 쌓이는 상태 금지).
5. **한도·합계는 DB 에서 재검사(동시 업로드 포함)**: 첨부 5개·건당 15MB·사용자 일 50MB 와 작성 한도(`exceedsLimit`)는 서버 액션의 사전 검사만으로 막히지 않는다. 동시에 들어온 요청이 각자 통과한 뒤 합이 넘을 수 있으므로, 개수·합계를 저장하는 쓰기 RPC 안에서 부모 행 잠금(또는 조건부 증가)으로 다시 센다.
6. **`canEscalate` 의 `escalated`·`canTransition` 의 `from` 은 호출 시점 입력(읽고 쓰는 사이의 경합 가능)**: 공용 판정은 화면·서버 액션의 **사전 검사**일 뿐이고 **최종 판정은 DB 조건**(1·2 의 조건부 UPDATE·유니크 제약)이다. 공용 판정이 참이어도 DB 조건이 거짓이면 거부한다.
7. **재오픈 권한·사유 필수 전이는 앱마다 달라지지 않게 계약 벡터가 기준**: 재오픈(`DONE → RECEIVED`)의 `hasEscalateRole` 판정 결과와 `requiresReason`(`DECLINED`·`NEED_INFO`) 목록은 `transitions.json`·`canTransition`·`requiresReason` 과 같아야 하며, 앱이 DB 에서 따로 정의한 권한·사유 규칙이 벡터와 다르면 앱 쪽을 고친다.
8. **감사·알림은 전이가 실제로 일어난 요청에서만** 남긴다(영향 행 1 일 때). 실패·거부 요청의 기록은 별도 action 이 아니라 앱 로그로 둔다.
9. **시험(앱)**: 5절 벡터 대조 시험에 더해, ①같은 글 동시 승격 2건 → 성공 1·`ALREADY_PROCESSED` 1, 2층 글 1개 ②같은 전이 동시 2건 → 1건만 반영 ③서로 다른 전이 동시 → `from` 조건으로 한쪽만 반영 ④같은 요청 재전송 → 알림·감사 1건 — 를 **로컬 DB 에서 실제 동시 실행**으로 확인한다(공용은 DB 가 없어 동시 시험을 둘 수 없다).
- 공용이 하는 것: 허용/거부 판정의 일관성(벡터), 같은 전이를 반복하면 거부되는 표 구조(`RECEIVED → RECEIVED` 등). 공용이 못 하는 것: 위 1~8 의 저장소 수준 보장 — 앱·DB 몫이며 이 절은 계약 v1 의 해석 보강이라 버전을 올리지 않는다.

## 6. 개인정보 (detectPii)
- 저장 전 검사: 전화(휴대·유선·+82), 주민번호 형태(`######-#######`), 계좌 형태(하이픈 구분 숫자 10~14자리), 이메일. 비어 있지 않으면 **저장하지 않고 거부**. 값은 되돌려 주지 않고 종류만.
- **한계(계약의 일부)**: 완벽하지 않다. 이름·주소·차량번호·자유 서술은 못 잡고, 하이픈이 든 긴 숫자(주문 번호 등)는 오탐할 수 있다. 「차단」이 아니라 「실수 방지 장치」다. **첨부 내용·이미지 속 글자에는 작동하지 않는다.**
- 글·답글(일반 사용자 답글 포함), 승격 재검사에 적용한다.

## 7. 작성 제한과 설정 (src/board/limits.ts, 결정 #19·#51)
| 키 | 기본 | 최소 | 최대 |
|---|---|---|---|
| `limit.user.per_day` | 5 | 1 | 30 |
| `limit.user.per_minute` | 1 | 1 | 5 |
| `limit.staff.per_day` | 20 | 5 | 100 |
| `limit.staff.per_minute` | 3 | 1 | 10 |
| `attach.daily_mb` | 50 | 10 | 100 |
- 값의 저장(앱 설정 표)과 **DB 재검사**는 앱 몫. 저장 전 `validateSetting`, 읽을 때 범위 밖이면 `effectiveSetting` 이 기본값. 범위 밖 저장은 `SETTING_OUT_OF_RANGE`. `exceedsLimit` 은 이번 글 이전까지의 건수(지난 24시간·지난 1분)가 한도와 같거나 넘으면 `RATE_LIMITED`.
- 익명 작성 금지. 소속 승인 전(PENDING) 사용자는 작성 불가(앱).

## 8. 안내 문구 (src/board/notices.ts, 결정 #5·#52)
- 문구 id 와 기본 문구, `locked` 여부는 공용이 정한다. `locked` 문구(개인정보 안내, 플랫폼 전달 고지, 승격·첨부 개인정보 확인, 첨부 가림 안내)는 앱이 덮어쓸 수 없다 — **잠정 목록, 오픈 전 재검토.**
- 덮어쓰기는 1~500자. 우선순위: 테넌트 → 앱 전역 → 공용 기본(`resolveNotice`). 화면 노출은 앱 몫.

## 9. 첨부 (src/board/attachments.ts, 결정 #34~#49)
| 상수 | 값 |
|---|---|
| 적용 | **2층만**(1층 첨부 없음), 업로더는 운영사 직원·플랫폼 운영자(아래). 글(또는 답글) 1건당 **5개**, 파일당 **4MB**(1MB=1024*1024), 건당 합계 **15MB**, 사용자별 일 **50MB**(설정) |
| 허용 확장자 | `jpg`(image/jpeg) · `png` · `webp` · `pdf` · `txt` · `log`(text/plain) — 허용 목록 방식 |
| 금지(이중 안전망) | `exe bat cmd ps1 sh js vbs msi dll jar apk scr com html htm svg zip 7z rar` — 이중 확장자의 **어느 구간**이든 걸리면 거부 |
| 표시 이름 | 100자, 경로·제어문자·방향 제어문자 제거. 개인정보가 걸리면 `첨부N.확장자` 로 대체 |
- `validateAttachmentMeta({ name, size, head })`: **브라우저 Content-Type 은 받지 않고** 앞부분 바이트(매직 바이트, 앞 1KB 권장)로 판정한다. `txt`·`log` 는 NUL·제어문자가 없고 실행·압축·GIF 서명이 아니어야 한다. 오류: `ATTACH_TYPE_NOT_ALLOWED`·`ATTACH_CONTENT_MISMATCH`·`ATTACH_TOO_LARGE`·`ATTACH_NAME_INVALID`.
- **공용에 없는 것(앱)**: 저장·경로(`<tenant>/<post>/<uuid>.<확장자>`)·서명 URL(권장 10분, 발급 직전 권한 재확인)·EXIF 제거(라이브러리는 별도 승인)·버킷 한도·정리 크론·개인정보 가림 확인 체크의 기록(`privacy_confirmed_by/at`)·`service_role` 사용 허용 목록(쓰기 RPC, 서명 URL 발급 직전 재확인, 정리 크론).
- **업로더(`uploaded_by_kind`)**: `STAFF`(운영사 직원) · `PLATFORM_ADMIN`(플랫폼 운영자, `BOARD_ATTACH_UPLOADER_KINDS`). 일반 사용자는 불가. 플랫폼 운영자의 첨부는 **본인(PLATFORM) 답글 단위만**이다. `canAttachToReply(업로더, 답글 쪽)`: 직원 → `TENANT` 답글에만, 플랫폼 운영자 → `PLATFORM` 답글에만(서로 다른 쪽 답글에는 불가).
- **개인정보 확인 문구는 업로더별로 구분**: 직원은 공용 `ATTACH_PRIVACY_CONFIRM`·`ATTACH_NOTICE_REDACT`(locked). 플랫폼 운영자용 문구는 앱 상수로 둘 수 있다(공용 id 없음). 어느 쪽이든 「스크린샷에 다른 운영사·사용자 정보가 보이지 않게」 주의를 담는다. 확인 체크의 기록은 앱.
- **운영사 상태별(앱 판정)**: 정지·계약만료(`LIMITED`) 운영사에도 플랫폼 첨부 허용, 해지(`CLOSED`)는 거부.
- **열람·삭제(변경 없음)**: 열람 = 같은 운영사 직원 전원 + 플랫폼 운영자(플랫폼 열람은 접근 기록), 삭제 = 대표·경리급(관리 권한자) 또는 플랫폼 운영자.
- 업로드는 서버 경유, 요청 1건에 파일 1개(결정 #46). 플랫폼 운영자 화면의 서버 코드는 1층 표를 `service_role` 로 읽지 않는다(결정 #47).

## 10. 감사·승인 계약 상수 (src/board/audit.ts)
- 감사 action: `board.post_redacted` · `board.attachment_deleted` · `board.switch_on` · `board.switch_off` · `board.setting_changed` · `board.retention_run` (형식 `^[a-z][a-z_]*\.[a-z][a-z_]*$` — 앱 감사 표의 형식 CHECK 를 통과). 감사에 **이메일·비밀값·키·본문을 넣지 않는다**(사용자는 id 만).
- 위험 단계 `BOARD_ACTION_RISK`: 본문 지우기·첨부 삭제·보관 정리 수동 실행 L2, 설정 변경·끄기 L1, **켜기 L2(2인 승인 대상이나 장치는 2단계 — 오픈 전 필수)**. 감사 필드 목록과 `approval_mode`(`single` | `two_person`; 1단계는 `single`).
- 사유: 1~500자(`validateReason`). 사유 코드 `USER_REQUEST · INCIDENT · TEST_DATA · LEGAL_REQUEST · PRIVACY · OTHER`(`OTHER` 면 메모 필수는 앱).
- 2인 승인 요청 표 열 `BOARD_APPROVAL_REQUEST_COLUMNS`, 상태 `REQUESTED · APPROVED · REJECTED · EXPIRED · EXECUTED`, 만료 기본 24시간(1~72). `validateApprovalDecision`: 승인자 ≠ 요청자, 만료 전, 거절은 사유 필수. 요청 내용은 고정 저장되어 승인 후 바뀌지 않는다(앱).

## 11. 앱이 하는 일 (요약)
표·RPC·RLS, 서버 액션(세션 확인 → 공용 검사 → RPC 에 `p_actor`·`tenant_id` 전달), 소속 승인 확인, 알림(대표·경리 새 글), 화면(작성 3곳·수신함·2층 수신함·삭제·스위치·설정), 크론(보관 정리·첨부 고아 정리·삭제 재시도), 분석 뷰(`board_escalations_v` — 1층 행·열 없음), 접근 기록, 기능 스위치(기본 꺼짐), 전이·벡터 대조 시험. **앱 구현 의뢰 때 앱 담당이 확인**: 감사 표 열 구조와 `approval_mode`.

## 12. 이 구현에서 정한 해석 (설계서가 정하지 않은 세부 — 이견 있으면 알려 주면 고친다)
1. 1층 분류 목록에 `SUGGESTION` 을 포함(결정 #21 의 일반 사용자 작성 분류).
2. `canReply`: `DECLINED` 2층 글은 모두 답글 불가. `DONE` 은 막지 않음(재오픈은 전이로).
3. `canView`: 직원은 `sameTenant` 가 참이면 1층·2층 모두, 일반 사용자는 `isAuthor && sameTenant` 인 1층만.
4. 감사 action 은 공통 규칙의 `대상.동작` 소문자 형식을 따른다(게시판 §12-0 의 대문자 예시 `BOARD_POST_REDACTED` 와 의미가 같고 표기만 다르다).
5. 제목·본문 길이 한도는 설계서에 없어 공용에 두지 않았다(앱이 정한다). 승격 검증은 비어 있지 않음만 본다.
6. 1MB 는 1024*1024 바이트로 계산한다.
7. 보관 기간 값과 법무 잠금 문구는 **잠정**이며 법무 답을 기다리지 않는다(오픈 전 재검토).
