# 공용 AI 키(방식 B) 공통 모듈 설계서 — `@platform/shared/ai-shared-key`

- 상태: **설계 초안 (구현·push·태그 금지, 개발자 승인 전)**. 작성 2026-11-14, 담당 쉐어드.
- 근거: 레저코어 `lib/ai/credentials.ts`·`lib/platform/ai-admin.ts`·`ai-admin-shared.ts`, 마이그 8440·8450 (읽기만 함).
- 공개 저장소 문서다. 키 값·회사 정보·내부 환경 식별자는 적지 않는다(§7).

## 1. 목표와 범위

개발자 지시: 이음·미트에도 레저코어와 «동일한» 방식 B(공용 키 봉인 저장 + 회사별 한도 + 정지 스위치)를 넣되, 3개 앱이 같은 코드를 복제하지 않게 한다.

| 포함(쉐어드) | 제외(앱) |
|---|---|
| 키 모양 검사·힌트·봉인·호출 직전 복호화·예약·무효 표시 | 마스터 키 «값», 환경변수 이름 결정 |
| 스태프 관리 액션 로직(등록·폐기·켜기끄기·한도·회사 설정·목록) | 스태프 인증 가드, 서버 액션 래퍼, 라우트 |
| 공급사 키 확인 함수(Anthropic 모델 조회 1회) | 실제 AI 호출 본체, 프롬프트, 모델 ID |
| 화면용 타입·필터 순수 함수 | 화면 컴포넌트(앱 UI 규약에 묶임, §5) |
| SQL 템플릿(표 5·함수 17) + 어댑터 계약 | 어댑터 SQL(스태프·감사·회사·소유자 검사) |

비포함(별건): ai-guard 와의 결합 코드(§8), 비용 환산, 사용량 대시보드.

## 2. 현재 레저코어 구조 요약

- TS: `credentials.ts`(키 모양·힌트·봉인·`withPlatformAiKey`·`reservePlatformAiUsage`·`markPlatformKeyInvalid`), `ai-admin.ts`(스태프 액션 10개 + `anthropicVerifier`), `ai-admin-shared.ts`(타입·`filterAiRows`).
- 암복호화는 이미 `@platform/shared/secrets`. 새로 만들 암호 코드는 없다.
- DB(8440): 표 `platform_ai_keys`·`platform_ai_key_events`·`platform_ai_settings`·`ai_usage_platform_month`·`tenant_ai_settings`, 함수 17개(스태프 8·회사 owner 4·내부 도우미 1·service_role 4). 전부 SECURITY DEFINER, 표는 RLS 켜고 정책 0, 접근은 함수로만.
- 예약 순서(고정): 키 ACTIVE → 회사 기능 스위치 → 회사 설정·한도 → 공용 한도 → 회사 행 증가 → 공용 합계 증가(실패 시 회사 행 되돌림). 호출 흐름은 예약 → 복호화 → 호출 → 기록.
- 레저코어 고유 의존(이식 시 걸림돌): `platform_assert_staff`, `platform_audit`, `tenants`, `tenant_members`, `ai_require_owner`, `forbid_mutation`, `ai_usage`·`ai_credential_events`(8370 유산, 8450 이후에도 유지), `LedgerError`, `isUuid`.

## 3. 모듈 구성

서브패스 3개(기존 API 변경 없음, 의존성 0, 추가만):

| 서브패스 | 내용 | 서버/클라이언트 |
|---|---|---|
| `@platform/shared/ai-shared-key` | 서버 전용: 키·예약·관리 액션·검증기 | 서버 전용(`node:crypto` 사용) |
| `@platform/shared/ai-shared-key/types` | 타입·`NEAR_LIMIT_PCT`·`filterAiRows`·RPC 이름 상수·오류 코드 | 클라이언트 가능(`node:crypto` 없음) |
| `@platform/shared/ai-shared-key/sql` | SQL 템플릿 파일 경로 안내(파일은 패키지에 포함) | 빌드·복사 도구용 |

레저코어가 `ai-admin.ts` 와 `ai-admin-shared.ts` 를 나눈 이유(클라이언트가 서버 전용 코드를 끌어오지 않게)를 그대로 서브패스 분리로 옮긴다.

### 3.1 설정 객체 — 앱이 정하는 것 (미트·이음 요구 반영)

```ts
const ai = createAiSharedKey({
  rpc,                                  // { rpc(fn, args) } 주입(서비스 롤 클라이언트)
  masterKeyEnv: 'APP_AI_MASTER_KEY',   // 앱별 이름. 쉐어드 기본값 없음(필수)
  provider: 'ai-claude',               // 기본값. 이음·미트·레저코어 모두 이 값
  scope: 'platform-ai',                // 봉인 AAD 의 tenantId 자리. 인자(기본값 = 레저코어 호환)
  rpcNames: { /* 아래 §4A 표의 키만 부분 덮어쓰기 */ },  // 기본값 = 레저코어 8440 이름
})
```

- **이름 정책**: 함수 이름은 레저코어 현행(`sealPlatformAiKey`·`withPlatformAiKey`·`reservePlatformAiUsage`·`markPlatformKeyInvalid`·`anthropicVerifier`·`validateAiKeyShape`·`keyHint`)을 유지한다. 이음 설계서가 적은 `sealAiKey`·`withAiKey` 등은 «이름만 다른 같은 기능»이라 이 이름으로 통일한다(레저코어 리팩터 비용 0). 팩토리 메서드(`ai.seal`, `ai.withKey`, `ai.reserve`, `ai.record`, `ai.markInvalid`, `ai.verify`)와 개별 함수 둘 다 export.
- `scope`: **인자**(쟁점 ②). 기본값 `platform-ai` 는 레저코어 기존 암호문과 호환돼야 해서 유지(AAD 가 바뀌면 복호화 실패). 새 앱은 기본값을 그대로 써도 된다(앱별 DB·마스터 키가 달라 충돌 없음).
- `rpcNames`: **인자**(쟁점 ①). 이음·레저코어는 기본값 그대로, 미트는 `ai_reserve` 등으로 덮어쓴다. 기본 이름을 고정하는 것을 권장(이음 의견과 같음).
- `masterKeyEnv` 는 기본값 없이 필수. 쉐어드 기본 `TENANT_SECRET_KEY` 재사용을 막는다. 이전 키 롤오버는 기존 규칙: `<이름>_PREVIOUS`.

### 3.2 오류

`LedgerError` 대신 모듈 자체 `AiSharedKeyError(code, message)` 를 둔다. 코드는 레저코어가 쓰는 값을 그대로 유지한다(`PLATFORM_INVALID`, `REASON_REQUIRED`, `AI_LIMIT_INVALID`, `AI_CREDENTIAL_INVALID`, `NOT_FOUND`). 앱은 얇은 어댑터로 자기 오류 타입에 옮긴다. 레저코어의 기존 오류 처리 화면이 깨지지 않게 코드 문자열은 바꾸지 않는다.

### 3.3 입력 검증 `isUuid`

모듈 안에 작은 uuid 검사를 둔다(외부 의존 없음).

## 4A. RPC 계약 (규범) — 앱 DB 는 이 계약과 1:1 이어야 한다

**기준은 SQL 파일이 아니라 이 RPC 계약이다.** 앱은 §4 템플릿을 쓰든 직접 짜든 아래 이름(`rpcNames` 로 바꿀 수 있음)·인자·반환 JSON 키·권한을 지키면 모듈이 동작한다. 계약 버전 `contract=1`(= 레저코어 8440 현행). 모든 함수는 service_role 전용(회사 owner 용 3개 제외, 아래 표 참조).

| `rpcNames` 키(기본 이름) | 인자(순서·이름 고정) | 반환 |
|---|---|---|
| `keySave`(`platform_ai_key_save`) | `p_actor uuid, p_ciphertext text, p_hint text, p_verified boolean, p_reason text, p_confirm text=NULL` | jsonb `{version, status, rotated}` |
| `keyRevoke`(`platform_ai_key_revoke`) | `p_actor, p_reason, p_confirm=NULL` | boolean |
| `keySetEnabled`(`platform_ai_key_set_enabled`) | `p_actor, p_enabled boolean, p_reason` | text(새 상태) |
| `setCap`(`platform_ai_set_cap`) | `p_actor, p_calls integer, p_tokens bigint, p_reason` | void |
| `keyStatus`(`platform_ai_key_status`) | `p_actor` | jsonb `{registered, version, status, key_hint, verified_at, last_error_code, updated_at, month, monthly_call_cap, monthly_token_cap, calls, tokens}` |
| `companySet`(`platform_ai_company_set`) | `p_actor, p_tenant uuid, p_enabled, p_calls, p_tokens, p_reason, p_confirm=NULL` | void |
| `companyOverview`(`platform_ai_company_overview`) | `p_actor, p_tenant` | jsonb (§ types 의 `AiCompanyOverview` 키) |
| `companySwitch`(`platform_ai_company_switch`) | `p_actor, p_tenant, p_enabled, p_reason, p_confirm=NULL` | boolean |
| `companyList`(`platform_ai_company_list`) | `p_actor` | jsonb `{month, key_active, truncated, rows[]}` (행 키는 `AiCompanyRow`) |
| `cipher`(`platform_ai_cipher`) | `p_provider text` | text 또는 NULL(키가 ACTIVE 가 아니면 NULL) |
| `keyMark`(`platform_ai_key_mark`) | `p_provider, p_status, p_code=NULL` | text |
| `reserve`(`platform_ai_reserve`) | `p_tenant uuid, p_provider text, p_calls integer, p_tokens bigint` | jsonb `{ok:true, calls, tokens}` 또는 `{ok:false, code}` |
| `record`(`platform_ai_record`) | `p_tenant, p_provider, p_reserved bigint, p_input bigint, p_output bigint, p_cache bigint, p_failed boolean=false` | void |
| (owner 용, authenticated) `companyStatus`·`companySetOwnerOff`·`companySetLimits` | `ai_company_status(p_tenant)` → jsonb · `ai_company_set_owner_off(p_tenant, p_off)` → boolean · `ai_company_set_limits(p_tenant, p_calls, p_tokens)` → void | 앱 화면(임대인 화면)이 직접 호출. 모듈은 타입만 제공 |

규범 규칙:
- **예약 코드 6종 고정**: `NO_ACTIVE_KEY`·`COMPANY_DISABLED`·`LIMIT_NOT_SET`·`PLATFORM_CAP_NOT_SET`·`LIMIT_EXCEEDED`·`PLATFORM_CAP_EXCEEDED`. 알 수 없는 응답·오류는 모듈이 `READ_FAILED`(호출 금지)로 처리(쟁점 ③). 새 코드가 생기면 계약 버전을 올리고, 앱 화면은 «알 수 없는 코드 → 일반 안내» 폴백을 둔다.
- `p_reserved`(기록): 예약 때 올린 토큰 수. 기록 함수가 실제 `input+output(+cache)` 와의 차액을 정산한다. 실패 호출은 `p_failed=true`(실패 카운트만 올리고 사용량은 예약분 환불 또는 정산, 구현은 8440 `platform_ai_record` 동작을 그대로 따른다 — 구현 단계에서 SQL 대조 필수).
- 키 상태 표시: **401·403 → `INVALID`**, 429 는 표시하지 않는다(회로 차단이 일시 대응). `keyMark` 의 `p_status` 허용값은 `ACTIVE|LIMITED|INVALID|SUSPENDED`.
- 응답 JSON 은 «키 추가만» 허용(모듈은 모르는 키를 무시). 화이트리스트 검사 헬퍼를 `types` 에 둔다: `assertNoForbiddenKeys(obj)` — 키 이름에 `cipher`·`ciphertext`·`secret`·`key_plain` 이 있으면 예외(미트 ④ 요구, 응답 화이트리스트 시험용).
- **사용량 상세 확장(기능 코드·모델·단가)**: 계약 v1 의 `record` 는 기능·모델을 받지 않는다. 미트 요구(기능별·모델별 분해, 단가 계산)는 v1 을 바꾸지 않고 **앱이 `record` 호출 뒤에 자기 상세 기록 RPC 를 추가로 부르는 방식**을 권장한다(모듈은 `onRecorded` 훅 제공, 아래 규칙). `record` 에 `p_feature`·`p_model` 기본값 인자를 더하는 계약 v2 는 레저코어 DB 변경(Level 3)이라 결정 대기 6 으로 올린다.
- **`onRecorded` 훅 규칙(미트 요청 반영)**: `ai.record(args, meta?)` 의 `meta`(`{feature?: string, model?: string, ...}`, 모듈은 내용을 해석하지 않고 그대로 전달)를 `onRecorded(args, meta)` 로 넘긴다. ① 훅은 **`record` RPC 가 성공한 뒤에만** 불린다(`record` 가 오류면 불리지 않음). ② 가림 차단·예약 취소처럼 **호출 자체가 없던 경우**에 앱이 «0 사용 기록»을 남기려고 `record` 를 호출했다면 그것도 `record` 성공이므로 훅이 불린다(`args` 의 토큰이 0 이고 `failed` 로 구분). 호출이 없는 경로에서 `record` 를 부르지 않는 것은 앱 선택이다. ③ **훅의 예외·실패·지연은 `record` 결과와 AI 호출 결과에 영향을 주지 않는다**(모듈이 try/catch 로 삼키고 결과에 `hookError: true` 만 표시. 훅은 await 하되 타임아웃 2초 후 포기). 상세 기록은 best-effort 이고, 정합은 앱이 합계 대조(Σ 상세 ≟ `ai_usage`)로 보완한다.
- **`record` 와 calls 환불**: 계약 v1 의 `record` 는 토큰만 정산하고 calls 는 되돌리지 않는다. «취소(calls 환불)» 는 v1 에 없다. 그러므로 **가림 → 예약 순서를 허용하고 기본 권장**으로 한다(§8, 가림은 순수 로컬이고 키는 예약·복호화 뒤에야 메모리에 오르므로 원칙 유지). 예약 뒤에 가림하는 순서를 쓰는 앱은 가림 차단 시 호출 한 건이 소모됨을 받아들여야 한다. 환불 함수(`cancel`)는 v2 후보(결정 9).
- DB 왕복(쟁점 ④): 호출 1회 = 예약 1 + 암호문 1 + 기록 1 = 3회. 접수형 «8초 호출»에서 DB 왕복은 수십 ms 수준이라 문제 없다는 가정이며, 이음이 측정하고 문제가 되면 «예약이 암호문을 함께 반환하는 `reserve_with_cipher`»를 계약 v2 후보로 둔다(키가 서버 메모리에 오르는 시점이 예약 통과 뒤라는 원칙은 유지됨).

### 4B. 모듈이 제공하는 순수 함수

| 함수 | 설명 |
|---|---|
| `estimateCostUsd(usage, priceTable)` | 토큰(입력·출력·캐시)×단가표(USD/백만토큰) → 추정 금액. 단가표 모양 `{model: {input, output, cache?}}`, **값은 앱 설정**(모듈은 값 없음). 반환에 `estimated: true`·`priceDate` 를 포함해 «추정» 표시를 강제(미트 ⑤) |
| `assertNoForbiddenKeys` | 위 응답 화이트리스트 검사 |
| `filterAiRows`·`NEAR_LIMIT_PCT` | 목록 필터 |
| `aiReserveMessage(code)` | 예약 코드 → 공통 사유 키(문구는 앱 몫, 폴백 포함) |

제외: ⑥ `ai.usage` 서명 요청·응답 헬퍼(레저코어 설계서 §5.2 계약)는 이 모듈 범위가 아니라 별건이다. 레저코어 서버 경로가 배포되고 계약이 확정되면 `@platform/shared/ai-shared-key/usage` 로 추가(추가 전용)하는 후속 단계로 둔다.

## 4. SQL 템플릿과 어댑터 계약

SQL 은 앱마다 스태프·감사·회사 모델이 달라 «완전히 같은 파일»을 못 쓴다. 그래서 **템플릿이 부르는 외부 객체를 어댑터 함수로 고정**하고, 템플릿은 어댑터만 부르게 한다. 그러면 템플릿 파일은 앱 사이에 바이트 단위로 같고, 앱은 어댑터 마이그 1개만 쓴다. **템플릿은 편의이고 규범은 §4A 이다** — 미트처럼 자기 모델(`wholesaler_id`, 기능 메뉴판 연동 등)에 맞춰 직접 쓰는 것도 허용하며, 그 경우 §4A 계약 시험(§9)을 통과해야 한다.

**전제(템플릿 필수 조건):** `public.tenants(id uuid PRIMARY KEY)` 가 있고 «회사 키 uuid = tenants.id 한 개»다(`tenant_ai_settings.tenant_id REFERENCES public.tenants(id)`). 레저코어·이음은 충족, 미트는 자기 회사 단위 표를 `tenants` 로 맞출 수 없으면 템플릿 대신 §4A 계약으로 직접 작성한다. 상태 값 표기(소문자·대문자 등)는 템플릿이 직접 비교하지 않고 아래 어댑터가 판정한다.

| 어댑터 함수(앱이 만듦, 시그니처 고정) | 하는 일 | 레저코어 | 이음 |
|---|---|---|---|
| `ai_adapter_assert_staff(p_actor uuid)` | **임대인(플랫폼 스태프) 판정**: 아니면 예외 | `platform_assert_staff` | `platform_assert_admin` |
| `ai_adapter_audit(p_actor uuid, p_action text, p_tenant uuid, p_detail jsonb)` | 감사 기록 1행 | `platform_audit` insert | 신설 `platform_audit` |
| `ai_adapter_tenant_exists(p_tenant uuid) returns boolean` | 회사 존재 여부(`NOT_FOUND` 판정) | `tenants` | `tenants` |
| `ai_adapter_tenant_active(p_tenant uuid) returns boolean` | **«활성 회사» 판정**. 회사 설정·정지/재개 함수가 `PLATFORM_TENANT_INACTIVE` 로 거부할 때 쓴다. **구현은 `tenants` 행을 `FOR NO KEY UPDATE` 로 잠그고 읽어야 한다**(교착 방지 규칙, 8440 과 같음) | `status = 'active'` | `status = 'ACTIVE'` |
| `ai_adapter_active_tenants() returns table(id uuid, name text)` | 목록 화면용 활성 회사 + 이름, **최대 2,000행**(초과 시 `truncated`) | `tenants` | `tenants` |
| `ai_adapter_require_pause_role(p_tenant uuid) returns text` | 호출자가 이 회사의 정지·재개 권한자인지 확인하고 역할 문자열 반환 | `ai_require_pause_role` | `tenant_staff` owner·manager |
| `ai_adapter_require_owner(p_tenant uuid) returns void` | **«대표만» 판정**: 한도 낮추기(`ai_company_set_limits`) 전용. 아니면 예외 | `ai_require_owner` | `tenant_staff.role='owner'` |
| `ai_adapter_is_member(p_tenant uuid, p_user uuid) returns boolean` | 이력의 «회사 구성원 / 플랫폼» 분류용 | `tenant_members` | `tenant_staff` |
| `ai_adapter_tenant_usable(p_tenant uuid) returns boolean` | **운영사 상태 판정**: 정지·계약 종료·연체·읽기 전용이면 false → 예약이 `COMPANY_DISABLED`. «활성»(`tenant_active`)과 의미가 다르다: 활성 = 설정을 바꿀 수 있는 회사, 사용 가능 = 지금 AI 를 호출해도 되는 회사 | 읽기 전용 모드 검사 | `tenant_usable` |

«대표만» 규칙은 `ai_adapter_require_owner` 로 템플릿이 보장한다(한도 낮추기에서 `require_pause_role` 의 반환값에 기대지 않는다). `tenant_name` 어댑터는 `active_tenants` 로 흡수해 삭제했다.

역할 문자열은 `'owner'`·`'accountant'` 에 한정하지 않고 `[a-z_]{1,20}` 로 열어 둔다(이음 `manager` 허용; 이벤트·표시용 값이며 권한 판정은 어댑터가 한다). 레저코어 `owner_off_role` CHECK 는 템플릿에서 이 패턴으로 완화한다(레저코어 기존 DB 는 동등성 검사에서 «더 엄격한 CHECK» 차이를 허용 목록에 둔다).

템플릿 본체:
- 표 5개 + `ai_usage` 대응 월 사용량 표(회사×월). 레저코어는 8370 유산 `ai_usage`·`ai_credential_events` 를 재사용하므로, 템플릿은 이 둘을 «없으면 만들고, 있으면 건너뛰는 선언» 대신 **이름을 `ai_usage`·`ai_credential_events` 로 고정해 템플릿이 직접 만든다**(레저코어는 이미 있으므로 적용하지 않고 «동등성 검사»만 한다, §6).
- `forbid_mutation` 의존은 제거하고 템플릿 안에 `ai_forbid_mutation()` 을 둔다.
- 함수 17개: 레저코어 8440 과 시그니처·응답 JSON 키 동일(§3 TS 가 이 계약에 맞춰져 있다).
- 권한: 표 RLS on·정책 0, 함수 SECURITY DEFINER + `search_path`, PUBLIC·anon 회수, 스태프·내부 함수는 service_role 에만 명시 GRANT, owner 함수는 authenticated.

배포 형태: 템플릿은 `templates/ai-shared-key/NNNN_template.sql`(패키지에 포함)로 두고, 앱이 자기 마이그 번호 규칙에 맞춰 복사한다. 첫 줄 주석에 `template-version`·SHA-256 을 넣고, 앱 CI 에서 복사본 해시가 쉐어드 해시와 같은지 검사한다(이미 설계된 마이그 CI 문서 `design-migration-ci-2026-11.md` 의 방식과 같은 줄기).

## 5. 임대인(회사) 화면

레저코어 `AiCompanyTable.tsx`(63줄)·`AiCompanyCard.tsx`(35줄)는 작고 앱의 UI 컴포넌트·스타일·서버 액션 호출에 묶여 있다. **컴포넌트는 공유하지 않는다.**

공통으로 주는 것:
- `types` 서브패스의 `AiCompanyRow`·`AiCompanyList`·`AiCompanyOverview`·`filterAiRows`·`NEAR_LIMIT_PCT`(필터 로직·80% 기준을 통일).
- 문서화된 화면 계약: 목록 필터 5종(전체/사용 가능/플랫폼 닫힘/회사 정지/한도 근접), 정지·재개 문구, 사용량 표시 항목, 재개 시 확인 문구 요구, «회사가 스스로 정지한 상태는 플랫폼이 풀 수 없음» 규칙. 앱 화면 담당이 이 계약대로 만든다.
- 화면 시험 목록(체크리스트)만 `docs/` 에 둔다. 컴포넌트 복제를 피하는 이점보다 UI 라이브러리 결합 비용이 크다.

## 6. 소비 방식

### 6.1 핀·버전
- 새 서브패스 추가만이므로 하위 호환 → **다음 rc**(현재 main 기준 rc.5 다음, 예: v0.4.0-rc.6)로 낸다. 태그·push 는 개발자 승인 후.
- 현재 핀: 레저코어 rc.3, 이음·미트 rc.1. 이음·미트는 3단계를 건너뛰어 올려야 하므로 앱 담당이 «핀 상승만» 먼저 별 PR 로 하고 build·test 를 확인한 뒤 AI 기능을 붙인다(이전 결정 «앱별 핀 상승»과 같은 순서).
- 앱은 태그로 고정한 핀을 쓴다(브랜치·최신 추적 금지).

### 6.2 레저코어(이미 구현됨)
1. 핀 상승 후 `credentials.ts`·`ai-admin.ts`·`ai-admin-shared.ts` 를 쉐어드 호출로 바꾸는 «얇은 래퍼»로 축소.
2. DB 는 바꾸지 않는다. 템플릿과 8440 의 **동등성 검사**(시그니처·응답 키·GRANT)만 시험으로 확인.
3. 기존 암호문 복호화가 그대로 되는지 시험(기본 provider·scope 유지).
4. 이 전환은 새 기능이 아니라 리팩터라 «운영 영향 0»을 증명해야 한다(스테이징 먼저).

### 6.3 이음·미트
1. 핀 상승(별 PR).
2. 어댑터 9개 마이그 작성(앱 담당; 미트는 템플릿 대신 §4A 계약에 맞춘 직접 작성도 가능) → 템플릿 복사 → 스테이징 적용은 건별 개발자 승인.
3. 마스터 키 환경변수 이름 결정·등록(§7), 스태프 가드·서버 액션·화면 작성.
4. 확인 항목: 앱에 «회사» 개념이 이미 하나의 uuid 로 있는가. 미트는 도매업자 단위, 이음은 `tenants`(tenant_foundation). **회사 키 uuid 의 의미가 앱마다 같은지 앱 담당이 확인해야 한다**(결정 대기 1).

### 6.4 버전 업 규칙
- 템플릿은 `template-version` 으로 관리하고, 변경 시 «추가 전용 마이그(새 번호)»로만 배포한다. 기존 번호 파일을 고치지 않는다.
- 응답 JSON 키는 추가만 허용(앱 TS 가 누락 키를 기본값 처리). 삭제·이름 변경은 major.

## 7. 마스터 키·공개 저장소 규칙

마스터 키 규칙(개발자 승인 필요한 «규칙»으로 제안):
1. 앱마다 환경변수 이름을 따로 쓴다(`<APP>_AI_MASTER_KEY` 형태). 쉐어드에 기본 이름을 두지 않는다.
2. 스테이징·운영은 **값을 서로 다르게** 등록한다(키 하나 유출이 다른 환경 암호문을 못 열게).
3. 앱 간에 같은 값을 쓰지 않는다. 앱 하나가 뚫려도 다른 앱 암호문을 못 열게 한다.
4. 교체는 `<이름>_PREVIOUS` 로 롤오버 후 재봉인(키 저장 함수가 ROTATE 로 새 버전을 만든다).
5. 값은 환경변수 저장소에만 두고 코드·문서·로그·오류 문구·테스트에 쓰지 않는다. 읽어도 출력하지 않는다.
6. 공급사(Anthropic) 키·암호문·마스터 키는 앱 사이에 공유하지 않는다(앱별 DB·앱별 공급사 키·앱별 마스터 키; 이음 설계서 §9 와 같은 입장). 공급사 키를 앱별로 발급할지는 콘솔 정산 분리 결정(결정 대기 2).

공개 저장소에 넣지 않는 것: 키 값·암호문 실물·마스터 키 값, 회사·임대인 이름·uuid·한도 수치·스태프 id, Supabase ref·URL·환경 식별자, 내부 설계서 경로(레저코어 주석의 `docs/design-platform-ai-...` 는 이식 시 삭제). 테스트 벡터는 가짜 값만, 이미 있는 `secrets/__vectors__` 방식을 따른다.

## 8. ai-guard 와의 관계

서로 독립이고 코드 의존이 없다.
- ai-guard: 전송 «내용»에서 개인정보를 가린다(순수 함수).
- 방식 B: 전송 «자격·한도»를 정한다.
- 호출 순서는 **앱 선택**이고 모듈은 강제하지 않는다. 두 안이 가능하다: (가) 예약 → 가림 → 복호화 → 호출 → 기록, (나) **가림 → 예약 → 복호화 → 호출 → 기록**. `platform_ai_record` 는 토큰만 정산하고 calls 는 되돌리지 않으므로, 가림이 거부될 수 있는 앱(이음 접수)은 (나)로 호출 수 소모를 막는 편이 낫다. 기본 권장은 (나). **ai-guard 는 텍스트 전용이고 이미지·바이너리 입력은 `refuse`(차단)만 제공한다**(`design-ai-egress-guard-2026-11.md` §19-3). 미트 A2 같은 사진 입력은 앱이 클라이언트 가림 후 서버에서 다시 검사하는 앱 어댑터 몫이고 이 모듈 범위가 아니다. 이음 `privacy-guard` 는 같은 계약의 어댑터이며 교체는 별도 승인. 가림이 실패하거나 차단되면 호출 전이므로 예약분을 되돌리는 경로가 필요하다(기록 함수에 «0 사용» 반환 처리; 구현 시 `platform_ai_record` 계약 확인). 두 모듈을 한 번에 묶는 래퍼는 이번 범위에서 만들지 않는다(앱의 AI 호출 래퍼가 순서대로 부른다).

## 9. 시험 계획(구현 단계)

- 단위(vitest): 키 모양 경계(19/20/400/401자, 공백·한글), 힌트, 봉인→복호화 왕복, 잘못된 AAD·키링 부재 시 오류 코드, `withPlatformAiKey` 의 off/unavailable/ok 3분기·콜백 예외 시 키 비노출, 예약 응답 해석(알 수 없는 응답 → READ_FAILED), 관리 액션 입력 검증(사유 500자·한도 정수·uuid), 오류·반환값에 키 문자열 부재 검사.
- **시험 벡터(미트 ⑧)**: 쉐어드가 «기대값 파일»을 제공한다 — 봉인 왕복(`secrets/__vectors__` 방식, 가짜 키), 응답 화이트리스트 예시(허용/금지 키), 예약 코드 6종 해석표, 동시 예약 기대값 서술(한도 K 에 동시 M>K → 성공 ≤K). 실제 동시성 실행은 앱 DB 시험 몫이다.
- **계약 시험 도구**: `checkRpcContract(sqlText, rpcNames)` 를 제공한다. 앱이 자기 마이그 텍스트를 넣으면 §4A 표와 함수명·인자명·반환 키를 정적으로 대조한다(미트 직접 작성·이음 템플릿 치환 모두 사용, DB 접속 없음).
- 계약: 가짜 RPC 로 RPC 이름·인자 이름이 템플릿 SQL 과 일치하는지 대조하는 시험(SQL 시그니처 파싱).
- SQL: 앱 쪽 시험(스테이징 DB)에서 권한(anon·authenticated 거부), 예약 원자성, 정지·재개 멱등을 확인한다. 쉐어드는 DB 를 갖지 않으므로 SQL 은 구문·시그니처 정적 검사까지만 한다.
- 기존 `security-hardening.test.ts` 에 새 서브패스의 비밀 노출 검사를 추가.

## 10. 단계 제안 (각 단계 개발자 승인)

| 단계 | 내용 | 담당 |
|---|---|---|
| 0 | 이 설계서 승인·결정 대기 해소 | 개발자 |
| 1 | 이음·미트의 어댑터 대상 확인(읽기 전용): 스태프 검사·감사 표·회사 키·소유자 권한 | 이음·미트 담당 |
| 2 | 쉐어드 구현(rc.6): TS 모듈·템플릿·시험·CHANGELOG | 쉐어드 |
| 3 | 레저코어 갈아타기(동치성 증명, DB 변경 없음) | 레저코어 |
| 4 | 이음·미트(**태그 이후에만 소비, 복사 구현 금지** — 캡틴 확정 순서): 핀 상승 → 어댑터·템플릿 마이그(스테이징) → 키·화면 | 이음·미트 |
| 5 | 운영 반영(스테이징 통과 후, 건별 승인) | 개발자 승인 |

## 11. 결정 대기

1. **회사 단위**: 이음·미트에서 «회사 한도·정지»의 단위가 tenant uuid 한 개로 일치하는가(미트는 도매업자 단위). 아니면 어댑터가 매핑한다.
2. **공급사 키 분리**: 3개 앱이 Anthropic 키를 공유할지, 앱별로 따로 발급할지(정산·유출 영향).
3. **템플릿이 `ai_usage` 를 직접 만드는 방식**: 레저코어는 8370 유산을 재사용하므로 «동등성 검사»로 처리한다. 대안은 레저코어만 별도 마이그로 이름을 맞추는 것(DB 변경이라 비권장).
4. **SQL 템플릿 위치**: 패키지 포함 파일(제안) vs 문서만. 파일이면 쉐어드 릴리스 체계에 SQL 이 들어온다.
5. **ai-guard 결합 래퍼**: 이번 범위에서 제외(제안)하고 앱이 순서대로 호출.
6. **`record` 확장(기능 코드·모델)**: 계약 v1 유지 + 앱 상세 RPC 후속 호출(제안) vs v2 로 `p_feature`·`p_model` 추가(레저코어 DB 변경, Level 3).
7. **왕복 최소화**: 3회(예약·암호문·기록)로 시작하고 이음 측정 후 필요하면 `reserve_with_cipher` 를 v2 로(제안).
9. **`cancel`(calls 환불)**: 계약 v1 에는 없음. 가림을 예약 앞에 두면 필요 없으므로 요구가 생길 때까지 보류(제안).
8. **모듈 이름**: `ai-shared-key`(제안). 이음 초안의 `ai-credentials` 와 다르므로 확정 필요.

## 12. 하지 않는 것

앱 폴더 수정, DB 적용, 마이그 작성, push·태그, 화면 컴포넌트 공유, provider 확장(`ai-claude` 외), 사용량 대시보드·청구 방식(`estimateCostUsd` 는 «추정 금액 계산 순수 함수»까지만), `ai.usage` 서명 헬퍼(후속).

## 13. 앱 요구와의 대조표

### 13.1 미트 §8.1 ①~⑧
| # | 미트 기대 | 이 설계서 |
|---|---|---|
| ① 키 도우미 | AAD 범위·모양·힌트·봉인·복호화, RPC·키링 주입 | §3.1 `scope`·`rpc`·`masterKeyEnv` 주입, 함수명은 레저코어 유지 |
| ② 예약 계약 | 코드 6종·READ_FAILED·RPC 이름 주입 | §4A 규범 규칙, `rpcNames` |
| ③ 기록 계약 | 토큰·모델·기능·실패, 401/403→INVALID | §4A: v1 은 기능·모델 없음 → 앱 후속 RPC(결정 6), 401/403 규칙 확정 |
| ④ 응답 타입 | 행·상태 타입·금지 키 헬퍼 | `types` 서브패스 + `assertNoForbiddenKeys` |
| ⑤ 단가 | 순수 함수·«추정» 표시, 값은 앱 | §4B `estimateCostUsd` |
| ⑥ `ai.usage` | 서명 요청·응답 헬퍼 | 범위 밖(후속 `…/usage`) |
| ⑦ 가드 순서 | 예약→가드→복호화, 이미지 | §8: 순서 확정, 이미지는 모듈 밖 |
| ⑧ 시험 벡터 | 기대값 파일 | §9 벡터·`checkRpcContract` |
| SQL 소유 | 미트는 SQL 본문 소유 | §4 템플릿은 편의, 규범은 §4A — 직접 작성 허용 |

### 13.2 이음 §9 쟁점 ①~⑥ 및 주입 3곳
| 쟁점 | 답 |
|---|---|
| ① RPC 접두·시그니처 | 이름은 `rpcNames` 로 덮어쓰기 가능, 인자·반환은 §4A 로 고정. 이음은 기본값 사용 |
| ② 범위값 | 인자(`scope`), 기본 `platform-ai` |
| ③ 예약 코드·`record` 인자 | 레저코어와 동일(계약 v1) |
| ④ 왕복 수 | 3회로 시작, 측정 후 v2 후보(결정 7) |
| ⑤ 핀 | 모듈 태그 이후 핀 상승(앱별 승인), §6.1 |
| ⑥ SQL 기준본·번호 규칙 | 템플릿은 «새 객체만 추가»라 기존 객체 불변. 마이그 번호는 앱이 복사할 때 자기 규칙(`YYYYMMDDHHMMSS_*.sql`)으로 부여, 템플릿 파일명은 번호 없음 |
| 임대인 판정 | `ai_adapter_assert_staff`(`platform_assert_admin`) |
| 회사 역할 판정 | `ai_adapter_require_pause_role`(owner·manager), 대표만은 `ai_adapter_require_owner` |
| 회사 활성·목록 | `ai_adapter_tenant_active`(상태 대문자 ACTIVE), `ai_adapter_active_tenants`(2,000행) |
| 구성원 분류 | `ai_adapter_is_member`(`tenant_staff`) |
| 운영사 상태 | `ai_adapter_tenant_usable`(`tenant_usable`) |

