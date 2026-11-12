# 열람 기록 표 SQL 예시 (`pii-display` 계약용)

상태: **예시 문서. 마이그레이션이 아니다.** 앱이 자기 DB에 맞게 고쳐 쓰고, 적용은 각 앱의 승인 절차(스테이징 선행)를 따른다.
이 저장소는 표를 만들지 않는다. 타입은 `@platform/shared/pii-display` 의 `AccessLogEntry`·`ExceptionPlainEntry` 가 기준이다.
규칙: 값(원문)·암호문·키 조각·이메일·이름 원문을 열에 두지 않는다. 추가 전용(UPDATE·DELETE 불가). 보관 기간은 법무 확인 전까지 정하지 않는다(코드·SQL에 숫자를 박지 않는다).

## 1. 해제 기록 `pii_access_log` (인증 후 원문 해제)
```sql
create table pii_access_log (
  id            uuid primary key default gen_random_uuid(),
  kind          text        not null default 'UNMASK' check (kind = 'UNMASK'),
  at            timestamptz not null,                  -- 서버 시각(UTC). 서울 날짜는 표시 계층에서 변환
  company_id    text        not null,
  actor_id      text        not null,                  -- id 만. 이메일·이름 원문 금지
  actor_role    text        not null,
  table_name    text        not null,
  record_id     text        not null,                  -- 대상 1건
  field_group   text        not null,                  -- 필드군 1개
  reason_code   text        not null,                  -- 닫힌 코드 목록
  reason_note   text,                                  -- 선택. 자유 문장은 저장 전에 규칙 B(가림) 적용
  outcome       text        not null check (outcome in ('attempt','ok','denied','failed')),
  auth_basis    text        not null,                  -- 예: recent_login_5m
  token_id      text,
  error_code    text
);
create index pii_access_log_target_idx on pii_access_log (company_id, table_name, record_id, at desc);
create index pii_access_log_actor_idx  on pii_access_log (company_id, actor_id, at desc);
```

## 2. 예외 평문 기록 `pii_exception_view_log` (별도 경량 표 — 권고안)
```sql
create table pii_exception_view_log (
  id          uuid primary key default gen_random_uuid(),
  kind        text        not null default 'EXCEPTION_PLAIN' check (kind = 'EXCEPTION_PLAIN'),
  at          timestamptz not null,
  company_id  text        not null,
  actor_id    text        not null,
  actor_role  text        not null,
  table_name  text        not null,
  record_id   text        not null,                    -- 대상 id(주문 id 포함)
  surface     text        not null,
  basis_kind  text        not null check (basis_kind in ('ACTIVE_ORDER','SELF','DOCUMENT')),
  repeat_count integer    not null default 1           -- 같은 사람·대상·surface 5분 이내 중복 제거 시 사용(선택)
);
create index pii_exception_view_log_target_idx on pii_exception_view_log (company_id, table_name, record_id, at desc);
```
- 사유 열이 없다. 샘플링하지 않는다. 월 단위 파티션은 양이 늘면 검토.

## 3. 조사용 합집합 뷰 (읽기 전용)
```sql
create view pii_view_audit as
  select at, company_id, actor_id, actor_role, table_name, record_id, 'UNMASK' as kind, outcome, field_group as detail from pii_access_log
  union all
  select at, company_id, actor_id, actor_role, table_name, record_id, 'EXCEPTION_PLAIN', 'ok', surface from pii_exception_view_log;
```

## 4. 추가 전용 보장 (예시)
```sql
create function pii_log_no_change() returns trigger language plpgsql as $$
begin raise exception 'append-only'; end $$;

create trigger pii_access_log_ro before update or delete on pii_access_log
  for each row execute function pii_log_no_change();
create trigger pii_exception_view_log_ro before update or delete on pii_exception_view_log
  for each row execute function pii_log_no_change();
```
- 쓰기는 서버(서비스 역할)만, 읽기는 감사 권한자만(RLS 로 일반 사용자 접근 차단). 정책 문구는 앱의 권한 구조에 맞춰 작성.
- 기록 쓰기가 실패했을 때의 처리: 해제 경로는 원문 미반환, 예외 경로는 «평문 반환 + 경고 로그 + 연속 실패 시 마스킹 전환»(설계서 A-1b-4, 권고 상태).
