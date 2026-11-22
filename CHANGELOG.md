# CHANGELOG

`@platform/shared/payments`·`@platform/shared/secrets` 의 변경 이력. 형식은 단순 목록이며, 소비 앱 전환 안내는 `docs/payments-api-draft.md` §9.

## v0.4.0-rc.12 — withholding 서브패스 (신규)·ai-guard 계좌 규칙 /3

두 묶음이다. ① withholding 은 신규 서브패스라 **추가형**(기존 export 불변, 핀을 올리지 않으면 영향 없음, 의존성 0). ② ai-guard 계좌 규칙 `/3` 은 가림 범위를 **늘리기만** 하며 **동작 변경**이 있다(아래 «동작 주의»). 핀 승격은 각 앱 담당이 태그 뒤에 한다.

### withholding 서브패스 (신규)

추가형이다(기존 export 불변, 의존성 0, 핀을 올리지 않으면 영향 없음). **[세무사 확인 필요]** 기준 구현의 현행 식을 그대로 옮긴 값이며 세무사 확인 전에는 «기준 구현의 현행 식과 같은 값»으로만 쓴다.
- `@platform/shared/withholding`: `computePersonalWithholding(공급가)` → `{ ok:true, value:{ total, income, local } }` 또는 `{ ok:false, code }`. 총액 = floor(공급가×33/1000), 소득세 = floor(공급가×30/1000), 지방소득세 = 총액 − 소득세(합 항상 일치). 예: 191,760 → 6,328 = 5,752 + 576. 상수 `WITHHOLDING_*`.
- «대상이면 계산»만 한다(대상 판정은 앱 몫). 음수·소수·비수·2,147,483,647 초과는 던지지 않고 거부(코드 식은 음수에서 내림, DB 식은 0 방향 절사로 서로 달라 한쪽으로 고르지 않음).
- `judgeWithholdingTarget({ businessNumber, taxInvoice })` → `{ decision: "PERSONAL"|"BUSINESS"|"NEEDS_CHECK", personal: boolean|null, reason }` (**[세무사 확인 필요]**). ① 사업자번호 있음 → 사업자 ② 없고 계산서 있음 → 사업자 ③ 둘 다 없음 → 개인(3.3%). 사업자번호는 «유무»만 받고 형식은 검증하지 않는다(앱 몫). 입력 `undefined` = 불명 → 단정하지 않고 `NEEDS_CHECK`(다른 쪽 근거로 정해지면 그대로: 번호 불명 + 계산서 있음 = 사업자). `null`/빈 문자열/`false` = 없음. reason: `BUSINESS_NUMBER`·`TAX_INVOICE`·`NO_BUSINESS_NO_INVOICE`·`BUSINESS_NUMBER_UNKNOWN`·`TAX_INVOICE_UNKNOWN`.
- `isValidBusinessNumber(값)` → boolean: 사업자번호 형식 검증(숫자 10자리 + 체크섬, 하이픈·공백은 지우고 봄). 문자열이 아닌 값·`null`·`undefined`·자리수·글자·체크섬 오류·전부 0 은 `false`. 형식만 보며 실제 등록 여부는 확인하지 못한다. 시험: 합성 번호 유효·무효 표, 경계, 체크섬 전수 확인.
- **사용 지침(필독)**: **`judgeWithholdingTarget` 의 `businessNumber` 에는 «유효한 번호가 있는지» 불리언(`isValidBusinessNumber(값)` 의 결과)을 넘길 것. 형식이 틀린 번호는 사업자로 보지 말 것.** 틀린 번호 문자열을 그대로 넘기면 «값이 있음»으로 보아 사업자로 판정되어 원천징수가 빠진다. `judgeWithholdingTarget` 자체는 바뀌지 않았다(값이 있는 문자열 = 있음).
- **음수 입력 확정**: `computePersonalWithholding` 은 음수를 계속 거부한다(`NEGATIVE`). 취소 반대 행처럼 부호가 필요하면 **호출 쪽이 절댓값으로 계산한 뒤 부호를 붙인다**.
- **호출 앱 안내**: **미조회 값은 반드시 `undefined` 로 넘길 것. `null` 은 «없음»으로 판정된다**(DB 열이 비어 있음 = 실제 «없음»). 그래서 조회에 실패했거나 아직 읽지 않은 항목을 `null` 로 채워 넘기면 둘 다 `null` 일 때 개인(3.3% 원천징수)으로 판정된다. 앱은 ① DB 에서 읽은 값만 그대로(`null` 포함) 넘기고 ② 못 읽은 값은 키를 빼거나 `undefined` 로 두며 ③ `NEEDS_CHECK` 는 원천징수를 자동 적용하지 말고 사람 확인으로 돌린다. 사업자번호 형식·체크섬 검증은 `isValidBusinessNumber` 로 하고 그 결과를 넘긴다(판정 함수는 «유무»만 본다).
- 시험: 기준 구현 표본표, 경계·0원·큰 금액, 0~200,000 합 일치 전수, DB 정수 나눗셈 대조, 이상 입력, 판정 표 13건 + 이상 입력 2건.

### ai-guard 계좌 제외 규칙 축소 (`ai-guard-rules/3`)

가림 범위를 **늘리기만** 한다(공개 API 시그니처 불변, 의존성 0). 구분자 없는 10자리 이상 연속 숫자를 계좌로 볼 때 예외로 빼던 규칙이 실제 계좌를 통과시키던 구멍을 좁혔다.
- 앞 쉼표 예외 삭제: `1,110234567890` 은 계좌로 가린다(쉼표 금액은 3자리씩 끊겨 10자리 연속이 될 수 없다). 앞 점은 «점 앞에 숫자가 있는 소수»일 때만 예외, 뒤 쉼표+숫자 예외도 삭제.
- 뒤 단위(원·만·천·억) 예외 축소: 숫자에 **붙어서** 오고 `00` 으로 끝나는 둥근 금액일 때만 예외. `110234567890 원` 처럼 띄어 쓴 단위·둥글지 않은 숫자는 계좌로 가린다.
- `20YYMMDD` 시작 예외 축소: 10·12자리 연속 숫자는 예외 없음. 14자리는 달력·시각이 정상인 접수 일시(`20261109123045`)만 예외.
- **동작 주의**: 위 모양의 숫자가 이전에는 그대로 나갔고 이제 `[ACCT_n]` 으로 치환된다(STRICT 에서는 의심이 아닌 확정 계좌라 기존과 같이 MASK). **잔여 한계**: 달력·시각이 정상인 14자리 계좌는 접수 일시와 구분할 수 없어(기존 정책 유지) 여전히 통과한다. 쉼표 금액·소수·ISO 날짜·둥근 단위 금액은 그대로 둔다.
- 시험: 누락 재현 8건 + 금액·날짜 오탐 0 시험 12건 추가, 규칙 버전 기대값 /3. 전체 29파일·1134건 통과, tsc 0.

## v0.4.0-rc.11 — 성능·안정성 보강 (추가형, 기본 동작 불변)

모두 추가형이다(기존 API 이름·시그니처·반환형 변경 없음, 새 옵션을 안 주면 기존 동작, 핀을 올리지 않으면 영향 없음, 의존성 0). 설계: `docs/쉐어드 성능 개선 설계 2026-11-21.md`.
- `push/fcm`: 토큰 요청·발송 fetch 에 제한 시간을 둔다(`FCM_TIMEOUT_MS` = 8000, `sendFcm` 의 `deps.timeoutMs` 로 재정의, 양의 유한수가 아니면 기본값). 시간 초과는 기존처럼 `{ ok:false, gone:false }`(기기 토큰을 지우지 않음). **동작 변경**: 구글이 응답하지 않을 때 이전에는 무한정 기다렸으나 이제 8초 뒤 실패로 끝난다.
- `push/fcm`: 콜드 상태에서 병렬 발송이 와도 OAuth 토큰 요청·서명은 서비스 계정별로 한 번만 한다(진행 중 요청 공유, 실패는 캐시하지 않음).
- `payments`: `TossConfig.budgetMs`(선택) 추가. `cancelPayment` 가 취소 뒤 이어서 부르는 조회(최대 2~3회 직렬)까지 포함한 전체 예산이다. 예산이 바닥나면 후속 조회를 하지 않고 `uncertain`(code `BUDGET_EXCEEDED`, 기존 kind)을 돌려준다. 안 주면 이전과 같다. 다른 함수는 호출 제한이 `min(timeoutMs, budgetMs)` 로만 줄어든다. 앱은 함수 시간 제한보다 2초쯤 짧게 준다.
- `ai-shared-key`: `scheduleHook`(선택, `AiOpts`/`AiSharedKeyConfig`) 추가. 주면 record 의 `onRecorded` 훅을 기다리지 않고 실행 Promise 를 넘긴 뒤 바로 `{ ok:true }`(앱은 `after()`·`waitUntil` 에 연결). 안 주면 이전처럼 최대 2초 기다린다.
- 시험: fcm 타임아웃·토큰 공유 6건, budgetMs 10건, scheduleHook 5건, 공개 이름 호환 3건. 전체 28파일·1114건 통과(시험 기준값 3초 완화 포함).
- 시험 환경: `vitest.config.ts` 가 `.claude/**`(작업 폴더 복사본)를 수집하지 않는다. Git Bash 에서는 `npx vitest run --root .` 로 돌린다.
- `sideEffects: false` 는 적용하지 않았다(번들 전후 측정 결과 차이 없음, 설계안 §6).

## v0.4.0-rc.10 — payments-outside-cancel 서브패스 (신규, 층 1)

추가형이다(기존 API 이름·시그니처 변경 없음, 핀을 올리지 않으면 영향 없음, 의존성 0). 토스 밖 취소(대시보드 직접 취소·부분 취소)를 두 앱이 **같은 규칙**으로 판정하는 순수 부분만 담는다. 웹훅 HTTP 계층·크론·DB 표·알림·화면은 앱 몫이고, 감지 결과로 결제·정산·장부 열을 자동으로 쓰지 않는다(표시·알림만). 오케스트레이션(층 2)은 포함하지 않는다.
- `@platform/shared/payments-outside-cancel`: `judgeOutsideCancel`·`confirmStable`·`fromTossPayment`·`isDueForCheck`·`orderAgeDays`·`paymentRefHash`·`cancelEventKey`·`webhookUrlToken`·`verifyWebhookUrlToken`·`extractWebhookRef`·`orderRefMatches`, 사례표 `OUTSIDE_CANCEL_CASES`(14건)·`runOutsideCancelConformance`·`referenceOutsideCancelAdapter`, 시나리오 표 `OUTSIDE_CANCEL_SCENARIOS`(6종), 타입.
- 전액 취소 정의는 `payments/status` 의 `isFullyCanceled`·`canceledTotal`(잔액 0 인 PARTIAL_CANCELED 실측 반영)과 같다. 미트 현행 `balance<=0 → full`·`balance>=total → ok` 와 같은 결과임을 시험으로 고정했다.
- 웹훅 보조는 본문의 상태·금액을 읽지 않고 `paymentKey`/`orderId` 만 꺼낸다(재조회한 값만 근거). 주소 토큰은 미트 현행(HMAC-SHA256 `toss-webhook:<id>`, 비밀 24자 이상)과 같은 값이다.
- 시험: 사례 14건 + 토스 원문 경유 + 멱등·재관측 + 이상 입력(무작위 3,000건 던지지 않음) + 성능(판정 10만 건 < 1초) + 정적 점검(시계·네트워크·환경변수·DB·console 없음).
- 표기 정정(2026-11-21): 태그 `v0.4.0-rc.10`(271e63c)이 달릴 때 `package.json` 의 version 이 `0.4.0-rc.9` 로 남아 있었다(표기만 어긋남, 동작 무관). 태그는 옮기지 않았고 다음 릴리스(rc.11)에서 맞췄다. 릴리스 전 점검: `docs/릴리스 점검 체크리스트.md`.

## v0.4.0-rc.9 — ai-usage-tenant-line 서브패스 (신규), AccountCallAction 에 ai_usage_tenant

추가형이다(기존 API 이름·시그니처 변경 없음, 핀을 올리지 않으면 영향 없음, 의존성 0). 이음·미트가 «테넌트(운영사·업체)별 월 AI 토큰» 한 줄을 레저코어로 **배치**로 보낼 때 두 앱이 똑같이 필요한 순수 계산 부분만 담는다. 호출(네트워크)·타임아웃·집계·크론·켜기·«어떤 테넌트를 보낼지»(변경분 + 하루 1회 전체)는 앱 몫이다. 계약: 레저코어 `docs/contract/ai-usage-tenant-line-contract-v1.md`(v1, 충돌 시 그 문서가 우선).
- `@platform/shared/ai-usage-tenant-line`: `buildAiUsageTenantLine`(입력 키 허용 목록 7개 `extId·month·inputTokens·outputTokens·cacheTokens·calls·asOf`, 그 밖의 키(회사 이름·금액·사용자·모델·기능 등)는 `LINE_EXTRA_KEY`, `ext_id` 는 영문·숫자·밑줄·하이픈 1~100자, 서울 월·`as_of` 미래 5분·400일 검사, 던지지 않음)·`checkAiUsageTenantBatch`(배치 선검증: 1~50건·항목 키 8개 전부 필수·허용 키·범위·`(ext_id, month)` 중복 — 항목 하나라도 틀리면 수신이 배치 전체를 거부하므로 발신 전에 거른다)·`splitAiUsageTenantBatches`(50건·16KB 이하로 순서 유지 분할, 중복·허용 밖 키가 있으면 분할 전에 거부, 빈 목록은 빈 배치)·`buildAiUsageTenantCall`(봉투 7키 `system·action:"ai_usage_tenant"·ext_tenant:"BATCH"·jti·iat·exp·lines`, 계약 §5 본문 순서로 직접 직렬화, 본문 16KB 검사, 실패는 코드로)·`classifyAiUsageTenantResponse`(200 `{status:"OK",received,stored}` 만 성공, 나머지는 `classifyAiUsageResponse` 와 같은 분류)·상수.
- `AccountCallAction` 타입에 `"ai_usage_tenant"` 추가(타입만, 런타임 변화 없음).
- `@platform/shared/ai-usage-tenant-line` 에 **읽기 호출** 추가(추가형, 같은 서브패스, 계약: 레저코어 `docs/contract/ai-usage-read-contract-v1.md`): `splitAiUsageReadIds`(id 를 200개·본문 8,192바이트 중 먼저 닿는 쪽 기준으로 순서 유지 분할 — 100자 id 200개는 8KB 를 넘어 바이트 기준 분할이 필요, 빈 목록은 빈 배열)·`buildAiUsageReadCall`(허용 키 8개 순서 `system·action:"ai_usage_read"·ext_tenant:"BATCH"·jti·iat·exp·ext_ids·month(선택)` 로 직접 직렬화, id 1~200개·형식·중복·month `YYYY-MM-01`·jti 8~128자 검사, 8,192바이트 초과는 `CALL_TOO_LARGE`, 실패는 코드로)·`classifyAiUsageReadResponse`(200 은 **요청한 id 의 행만·알려진 4개 키만·정수/불리언 검사 통과분만** 돌려주고 버린 행 수 `dropped` 를 알림 — 다른 테넌트·회사 이름·금액이 응답에 섞여도 앱에 나가지 않음(R1), 401 `CALL_EXPIRED`→`retry_resign`, 429·503·500·네트워크→`retry_later`, 그 밖은 `stop`)·상수(`AI_USAGE_READ_PATH` 등).
- 읽기 호출 시험 벡터(가짜 비밀 `test-secret-ai-usage-read-0123456789abcdef`·jti `jti-1794657630-ai-usage-read`·now 1794657630000)가 시험으로 고정되어 있다(레저코어 `buildReadBody` 와 본문 순서 일치, 레저코어 교차 확인 대기). 앱 몫: 로그인한 테넌트 본인의 id 만 서버에서 정해 넘기기·5분 정도 캐시·한도(IP당 분당 60) 시 «잠시 불러오지 못했습니다» 표시·받은 값을 로그에 남기지 않기.
- `AccountCallAction` 타입에 `"ai_usage_read"` 도 추가(타입만).
- 계약 §5 시험 벡터(535바이트)와 본문·서명이 바이트 단위로 같다(시험으로 고정). system 만 shipping 으로 바꾼 서명도 고정(계약에 없는 값, 레저코어와 교차 확인용).
- 동작 주의: 공용 `buildSignedCall` 은 추가 필드를 `jti` 앞에 넣어 계약 본문 순서(`jti·iat·exp` 뒤 `lines`)와 달라 `buildAiUsageTenantCall` 이 같은 검증(`assertSignSecret`·`signTtl`·`signNowSec`)으로 직접 직렬화한다. `now` 는 인자(이 모듈은 시계를 읽지 않는다).
- 내부: `ai-usage-line/line.ts` 의 검사 보조 함수 5개를 `export` 로 열었다(패키지 공개 API 아님, `index.ts` 에서 내보내지 않음, 동작 변화 없음).

## v0.4.0-rc.8 — ai-usage-line 서브패스 (신규), AccountCallAction 에 ai_usage

추가형이다(기존 API 이름·시그니처 변경 없음, 핀을 올리지 않으면 영향 없음, 의존성 0). 이음·미트가 월 AI 사용 합계 «한 줄»을 레저코어로 보낼 때 두 앱이 똑같이 필요한 **순수 계산 부분**만 담는다. 호출(네트워크)·타임아웃·집계(DB)·크론·켜기·환경변수·비밀 읽기는 앱 몫이다. 계약: 레저코어 `docs/contract/ai-usage-line-contract-v1.md`(v1).
- `@platform/shared/ai-usage-line`: `buildAiUsageLine`(입력 키 허용 목록 5개 `month·calls·tokens·estUsd·asOf`, 그 밖의 키는 `LINE_EXTRA_KEY` — 회사·사용자 정보 혼입 차단, 출력 키 `contract·month·calls·tokens·est_usd·as_of` 순서 고정, 범위·소수 4자리·서울 월·`as_of` 미래 5분 검사, 던지지 않음)·`estimateAiUsageUsd`(모델별 값을 반올림 없이 합산한 뒤 **한 번만** 소수 4자리 반올림, 캐시 단가가 없으면 입력 단가, 단가표에 없는 모델이 있으면 `MODEL_PRICE_MISSING` 으로 전체 거부)·`classifyAiUsageResponse`(계약 §4: sent·retry_resign·next_slot·stop, 알 수 없는 응답은 stop)·`aiUsageMonthsToSend`(서울 0·6·12·18시 첫 15분 창, 서울 매월 1일에는 모든 슬롯에서 직전 달을 먼저)·`buildAiUsageCall`(`buildSignedCall` 을 `action:"ai_usage"`·`ext_tenant:"APP"` 으로 부르는 얇은 래퍼, 본문 2,048바이트 검사, 실패는 코드로)·상수(`AI_USAGE_PATH` 등).
- `AccountCallAction` 타입에 `"ai_usage"` 추가(타입만, 런타임 변화 없음). 이음의 `"link" as AccountCallAction` 같은 형 변환 우회는 핀 상승 뒤 지울 수 있다.
- 계약 §3 시험 벡터와 본문·서명이 바이트 단위로 같다(시험으로 고정). system 만 shipping 으로 바꾼 서명도 고정(계약에 없는 값, 레저코어와 교차 확인용).
- 동작 주의: `buildAiUsageLine` 은 `now` 를 인자로 받는다(이 모듈은 시계를 읽지 않는다). `buildAiUsageCall` 의 `deps.now` 도 필수다.
- 버전 표기: rc.7(한글 라벨 표, 위 아래 항목)이 먼저 병합·태그되어 이 버전은 rc.8 이다.

## v0.4.0-rc.7 — 한글 라벨 표 (추가형), 영어 문구 한글화

사용자 화면에 코드값·영어가 그대로 나오지 않게 «코드→한글 문구» 상수 표와 getter 를 추가한다. 기존 API 이름·시그니처는 그대로이고, 표는 앱이 getter 의 `overrides` 인자로 일부만 덮어쓸 수 있다(표 자체는 바뀌지 않는다). 모르는 코드는 코드를 보이지 않는 한글 일반 문구로 돌려준다.
- `@platform/shared/board`: `BOARD_ERROR_LABELS`(오류 25종, 첨부 검증 결과 포함)·`BOARD_TIER1_CATEGORY_LABELS`·`BOARD_TIER2_CATEGORY_LABELS`·`BOARD_STATUS_LABELS`·`BOARD_AUTHOR_KIND_LABELS`·`BOARD_VIEWER_KIND_LABELS`·`BOARD_REPLY_VISIBILITY_LABELS`·`BOARD_PII_KIND_LABELS`, getter `boardErrorLabel`·`boardStatusLabel`·`boardCategoryLabel`·`boardPiiKindLabel`·`boardVisibilityLabel`.
- `@platform/shared/ai-guard`: `GUARD_REASON_LABELS`(11종)·`GUARD_KIND_LABELS`·`GUARD_WARNING_LABELS`, getter `guardReasonLabel`·`guardKindLabel`·`guardWarningLabel`.
- `@platform/shared/ai-shared-key`(및 `/types`): `AI_RESERVE_CODE_LABELS`(6종+`READ_FAILED`)·`AI_ERROR_CODE_LABELS`, getter `aiReserveLabel`·`aiErrorLabel`.
- `@platform/shared/pii-display`: `UNMASK_ERROR_LABELS`·`unmaskErrorLabel`. `@platform/shared/free-text`: `FREE_TEXT_WARNING_LABELS`·`FREE_TEXT_FAILURE_LABELS`·`FREE_TEXT_MASKED_KIND_LABELS`와 getter 3개.
- **동작 주의(문구만 바뀜)**: `ai-shared-key` 가 던지는 `AiSharedKeyError` 의 `message` 영어 8곳이 한글로 바뀌었다(`code` 는 그대로). 앱이 `message` 문자열 비교로 분기했다면 `code` 로 바꿔야 한다. `payments` 승인 응답 상태 불일치 문구에서 영어 코드값 `DONE` 을 뺐다(`code` 는 그대로 `STATUS_…`).
- `secrets` 는 표를 만들지 않았다: 오류 코드는 서버 내부 예외로만 쓰이고 앱 코드가 화면에 직접 내보내지 않는 구조이기 때문(앱이 화면에 내보낸다면 그때 추가).
- 시험: 모든 코드가 라벨을 갖는지(누락 0), 라벨에 영어 코드가 섞이지 않는지(허용 고유명: AI·MB·pdf·txt·log·jpg·png·webp·UUID·RPC), getter 의 덮어쓰기·폴백.

## v0.4.0-rc.6 — ai-shared-key 서브패스 (신규)

신규 서브패스 3개, 추가형(기존 API 변경 없음, 핀을 올리지 않으면 영향 없음). 설계: `docs/design-ai-shared-key-module-2026-11.md`.
- `@platform/shared/ai-shared-key`(서버 전용): 공용 AI 키(방식 B)의 키 모양 검사·힌트·봉인·호출 직전 복호화(`withPlatformAiKey`)·예약·기록(`onRecorded` 훅, 2초 타임아웃·실패 격리)·401/403 무효 표시·관리 액션·`anthropicVerifier`·`createAiSharedKey` 팩토리.
- `@platform/shared/ai-shared-key/types`(클라이언트 가능): 타입·예약 코드 6종·`filterAiRows`·`assertNoForbiddenKeys`·`estimateCostUsd`(항상 «추정»).
- `@platform/shared/ai-shared-key/contract`: `checkRpcContract(sqlText, rpcNames?)` — 앱 마이그 SQL 을 RPC 계약 v1 과 정적 대조(DB 접속 없음).
- **마스터 키 환경변수 이름은 기본값이 없다**(`masterKeyEnv` 필수, 앱별). 키·암호문·마스터 키 값은 이 저장소 어디에도 없다.
- SQL 템플릿(`templates/`)과 레저코어 전환은 이번 범위가 아니다(후속).

## v0.4.0-rc.5 — 개인정보 공용 부품(pii-display·free-text), ai-guard 보강, kst 서브패스

신규 서브패스는 모두 추가형이다(기존 API 변경 없음, 핀을 올리지 않으면 영향 없음). 이 버전에는 kst 서브패스(아래 «kst 서브패스» 항목)도 함께 실린다.
- `@platform/shared/pii-display`(규칙 A): 구조화 필드의 기본 마스킹 표시·해제 판정·열람 기록 보조.
- `@platform/shared/free-text`(규칙 B): `maskFreeText` 로 자유 문장 저장 전에 주민(외국인)등록번호·전화·카드·계좌·이메일·사업자번호·키 모양 문자열을 가림. 규칙 버전 `free-text-rules/1`. 실패(길이 초과 등)하면 원문을 돌려주지 않으므로 앱은 저장을 거부해야 한다.
- **이름·주소는 가리지 않는다**: `maskFreeText` 는 이름·주소를 가리지 않고 경고 코드(`NAME_CUE`·`ADDRESS_CUE`, 건수만)만 돌려준다. 한글로 풀어 쓴 숫자도 경고만. 이름·주소가 자유 문장에 섞여 저장되지 않게 하는 것은 앱의 입력 안내·구조화 필드 몫이다.
- ai-guard 보강 5건(`GUARD_RULES_VERSION` `ai-guard-rules/2`): 구분자 변형 탐지, 이름 단서어, 스팬 합치기, 정책 동결, 주소 단서 경고. **동작 주의**: 정책은 컴파일 시점에 복사·동결되어, 그 뒤 원본 정책 객체를 바꿔도 반영되지 않는다.
- 문서: `docs/pii-access-log-sql-example.md`(열람 기록 SQL 예시).

### kst 서브패스 (신규)


`@platform/shared/kst`(서울 날짜 헬퍼: 미트 `lib/time/kst.ts` 승격 + `kstDayRange`·`kstMonthRange`·`parseKstDate`)와 `@platform/shared/kst/check`(서울 날짜 규칙 정적 검사 CLI) 추가. 기존 API 변경 없음, 의존성 0.
- **동작 주의 1 (미트 `kst.ts` 와 다름)**: `kstDateOf` 는 오프셋 없는 시각 문자열(`2026-11-11T23:30:00`, `2026-11-11 23:30:00`)을 **UTC 로 읽는다**. 원본은 실행 환경 시간대에 따라 결과가 갈렸다(개발 PC 와 UTC 서버가 다름). 오프셋이 있으면(`Z`·`+09`·`+09:00`) 그대로 따른다. DB 의 `timestamp without time zone` 을 서울 시각으로 쓰는 앱은 이 가정이 틀리므로 도입 때 확인한다.
- **동작 주의 2 (검사기)**: `ts-iso-slice` 는 `toISOString().slice(0, 7)`(UTC 월)도 error 로 본다.

## v0.4.0-rc.4 — ai-guard 서브패스 (신규, 코어)

`@platform/shared/ai-guard` 추가(기존 API 변경 없음, 의존성 0). 외부 AI 전송 전 개인정보 검사·가림. 순수 함수 `guard(input, policy)` 하나가 가린 결과를 돌려준다.
- 필드 허용(경로·text/enum/number/boolean), 선언 밖 키 `DROP`/`BLOCK`(기본 BLOCK, 키 이름은 기록하지 않음).
- 패턴: 주민(외국인)등록번호·사업자번호(체크섬)·전화(대표번호 포함)·계좌(하이픈 유/무)·이메일·카드(Luhn)·차량번호(기본 OFF)·키 모양 문자열(항상 차단). 날짜·금액·소수는 오탐 제외.
- 이름·상호 표지(보수적·의심 스팬), 앱 사전 `knownTerms` 정확 일치, `extraOrgMarkers`/`extraPersonCues`, 동기 `extraDetectors`(스팬만, 합집합만, 실패=차단).
- 종류별 처리 `kinds`: MASK/BLOCK/PASS/OFF (주민·카드·계좌·키 모양은 PASS/OFF 불가). `level`: STRICT(의심=차단)/STANDARD(의심=가림 후 재검사).
- 토큰 치환 `[KIND_n]`, `restore()`(`restoreKinds` 필수, 모르는 토큰·비복원 토큰 분리 보고), 토큰 모양 충돌 `ESCAPE`/`BLOCK`.
- fail-closed: 절대 throw 안 함, 길이·치환 수 상한, 치환 결과 재검사(post-check, 앱 감지기 포함), 리포트·오류에 원문 없음. `reasonCodes()`, `GUARD_KINDS`/`GUARD_REASONS`.
- 확장(guardBatch·narrowPolicy·normalizeOrgName·scan·restoreDeep·AMOUNT·tags·guardAsync)은 포함하지 않음. 설계: 로컬 문서(공개 저장소 미반영).

## v0.4.0-rc.3 — 보안 수정 (account 서명·SSO 입력 검증, board 실패 시 닫힘·이메일 감지 시간 상한)

공개 API 이름·시그니처 변경 없음. 정상 입력의 동작은 그대로이고, 아래 잘못된 입력은 이제 오류로 거부되거나 닫힘으로 처리된다(동작 변경).
- `buildSignedCall`: `fields` 에 예약 키(`system`·`action`·`ext_tenant`·`jti`·`iat`·`exp`)가 있으면 `CALL_RESERVED_FIELD` 오류. 빈 비밀·문자열이 아닌 비밀은 `SIGN_SECRET_INVALID`, 유한한 양수가 아닌 `ttl` 은 `SIGN_TTL_INVALID`, 유한하지 않은 `now` 는 `SIGN_NOW_INVALID`. `ttl` 은 여전히 최대 60초로 줄인다.
- `signSsoToken`: 같은 비밀·`ttl`·`now` 검증. `ssoTarget` 은 `/ledger` 아래에서 `.`·`..` 구간(퍼센트 인코딩·이중 인코딩 포함), 인코딩된 구분자, 제어문자, 깨진 퍼센트 인코딩이 있으면 `/ledger` 로 되돌린다.
- `canTransition`: `actorSide` 가 `PLATFORM` 이 아닌 알 수 없는 값(오타·소문자·널)은 플랫폼 권한으로 취급하지 않고 거부(실패 시 닫힘).
- `detectPii` 이메일 패턴: 로컬 파트를 64자로 묶어 `@` 없는 긴 입력에서의 이차 시간을 막음. 「포함 여부」 판정 결과는 같다.
- 문서만: `docs/design-two-tier-board-shared-2026-11.md` 공개용 정리(내부 식별자·약점 메모·운영 절차 제거).
- 소비 앱: 위 거부 동작이 영향을 줄 수 있는 호출(예약 키를 fields 로 넘김, 빈 비밀·잘못된 ttl/now, 비정상 `to`, 알 수 없는 `actorSide`)이 없는지 핀을 올릴 때 각 앱이 시험으로 확인한다.

## v0.4.0-rc.2 — board: 2층 승격은 직원 전원

`board_contract_version` v1 유지(값·코드 이름 변경 없음, 권한 규칙만 완화).
- `canEscalate`·`canTransition(NONE→RECEIVED, TENANT)`·`validateEscalation`: 승격은 테넌트 직원(STAFF) 전원 가능. `hasEscalateRole` 은 승격 판정에서 무시(옵션·호환용, `validateEscalation` 입력에서는 생략 가능). 승격 때 `NOT_AUTHORIZED` 는 더 이상 나오지 않음.
- 그대로: 재오픈(DONE→RECEIVED)은 `hasEscalateRole`(대표·매니저급)만. 내용 지우기·설정·첨부 삭제는 앱이 기존대로 관리 권한자에게만.
- 첨부: 업로더 유형 `BOARD_ATTACH_UPLOADER_KINDS`(`STAFF`·`PLATFORM_ADMIN`)와 `canAttachToReply` 추가(하위호환 추가). 플랫폼 운영자는 본인 답글 단위만, 개인정보 확인 문구는 업로더별 구분, 정지·만료(LIMITED) 허용·해지(CLOSED) 거부(앱 판정)를 계약 §9 에 명시.
- 벡터 `transitions.json`: `NONE→RECEIVED TENANT 권한 false` 가 거부에서 허용으로 이동. 앱은 DB 전이 대조 시험을 이 벡터로 갱신.
- 문서만: `docs/board-contract.md` §5-1 동시성·중복 호출 요구(앱 필수), `docs/payments-app-checklist.md` 신규(결제 앱 체크리스트 초안). 코드 변경 없음.
- 버전 표기: 태그 v0.4.0-rc.1 시점의 package.json 은 0.3.0-rc.3 으로 남아 있었다(태그는 옮기지 않음). 이 버전부터 package.json 이 태그와 같다.

## v0.4.0-rc.1 — board 서브패스 (신규)

`@platform/shared/board` 추가(기존 API 변경 없음). 설계 `docs/design-two-tier-board-shared-2026-11.md`, 계약 `docs/board-contract.md`(`board_contract_version` v1). 순수 함수·상수만, 의존성 추가 없음(EXIF 제거 라이브러리는 포함하지 않음 — 앱, 별도 승인).
- 코드값: 1층 분류 4(`NOTICE`·`QUESTION`·`HANDOVER`·`SUGGESTION`), 2층 분류 4, 2층 상태 5, 작성자 유형 `STAFF`/`USER`, 답글 가시성 `AUTHOR`/`TENANT_ONLY`/`PLATFORM`, 앱 키 3, 분석 뷰 `board_escalations_v`와 열 목록, 오류 코드.
- 판정: `canView`·`canViewReply`·`canReply`·`allowedReplyVisibilities`·`canEscalate`·`canTransition`·`requiresReason`·`validateEscalation`·`needsStaffReply`, `detectPii`(전화·주민번호·계좌·이메일 형태, 종류만 반환).
- 설정: 작성 제한 기본값·허용 범위(`BOARD_SETTINGS`)와 `validateSetting`·`clampSetting`·`effectiveSetting`·`writeLimits`·`exceedsLimit`, 안내 문구 상수(`locked` 포함)와 `validateOverride`·`resolveNotice`.
- 첨부: 상수(5개·4MB·합계 15MB·허용 확장자·금지 확장자)와 `validateAttachmentMeta`(이름·크기·앞부분 바이트)·`sanitizeDisplayName`·`exceedsAttachLimit`·`exceedsDailyAttachBytes`.
- 감사·승인: 감사 action 코드(`board.*`)·위험 단계 표·사유 검증·2인 승인 요청 표 열/상태 계약 상수와 `validateApprovalDecision`·`approvalExpiresAt`. 2인 승인 장치는 2단계(오픈 전 필수).
- 시험 벡터 `src/board/__vectors__/`(전이표·개인정보). package.json 버전은 태그 승인 때 정한다.

## v0.3.0-rc.3 — inapp 서브패스 (신규)

`@platform/shared/inapp` 추가(기존 API 변경 없음). 카카오톡 인앱 브라우저 처리 중 두 소비 앱이 각자 갖고 있던 순수 로직만 공용화.
- `isKakaoInApp(userAgent)`: UA 에 `kakaotalk`(대소문자 무관)가 있으면 참, null·undefined·빈 문자열은 거짓.
- `kakaoExternalOpenUrl(pageUrl)`: `kakaotalk://web/openExternal?url=<encodeURIComponent(pageUrl)>`.
- `matchesPathPrefixes(pathname, prefixes)`: 정확 일치 또는 `접두어/` 로 시작하면 참(`/shopping` 은 `/shop` 에 안 걸림), null 거짓. 경로 목록은 앱이 넘긴다.
- 안내 화면(React)·쿠키·로그인·앱별 경로 목록은 공용에 없다. 정규식 규칙(예: `/o/<코드>` 처럼 코드 세그먼트 필수)이 필요한 앱은 접두어 판정 대신 자기 정규식을 유지한다.

## v0.3.0-rc.2 — secrets 서브패스 (신규; 태그는 사장님 승인 후 생성)

`@platform/shared/secrets` 추가(payments 와 별개, 기존 API 변경 없음). 설계 `docs/tenant-secrets-envelope-design.md`.
- 봉투 `ENC:v2:<kid>:<base64url(iv‖태그‖암호문)>`, AES-256-GCM, AAD = 테넌트 id(소문자)+provider. 쓰기는 항상 v2·현재 키.
- 키 로더 `loadKeyring(env, { current?, previous? })`: hex 64자·base64/base64url 32바이트, 현재 키+`<이름>_PREVIOUS`(쉼표 다수) 로테이션, kid = 키 SHA-256 앞 4바이트.
- 읽기 전용 레거시: 접두 `ENC:v1:`(AAD=테넌트 id 문자열), 접두 없는 `iv.태그.암호문`(AAD 없음) → `needsRewrite: true`.
- `resolveSecret`/`readFailed`/`jsonSecret`: ok/absent/unavailable 3상태.
- 오류는 코드 문자열만(`SECRET_*`), 키링은 키 바이트를 노출하지 않음. 서버 전용(`node:crypto`).

## v0.3.0-rc.2 — payments (태그는 사장님 승인 후 생성, main 병합 없음)

기준: v0.3.0-rc.1(`0db3db3`) 대비. 두 소비 앱은 아직 `#v0.2.2`(payments 없음)에 고정이라 **지금 깨지는 곳은 없고, 핀을 올릴 때부터 적용**된다.

> **버전 메모**: v0.3.0-rc.1 이 이미 공개 태그인데 이 변경에서 breaking 이 다시 들어간다(rc 는 안정 API 약속 없음, 소비 앱은 아직 `#v0.2.2`). 다음 버전은 **`0.3.0-rc.2`** 로 결정됨(사장님). 태그 생성·공개 push 는 사장님이 platform 세션에서 직접 승인한 뒤에만 한다.

### BREAKING (타입·분기 영향)
- `TossConfig.expectedMode` **필수**(`"test" | "live" | "unchecked"`). 생략하면 `KEY_MODE_REQUIRED` 를 던진다. 접두사(`test_sk_`·`live_sk_`, 위젯 `gsk`)와 다르면 `KEY_MODE_MISMATCH`. `"unchecked"` 는 토스 도메인이 아닌 `baseUrl`(모의 서버)에서만 허용(아니면 `KEY_MODE_UNCHECKED_FORBIDDEN`).
- `ConfirmOutcome` 에 `{ kind: "waiting_for_deposit"; payment }` 추가 — `switch` 를 exhaustive 하게 쓰는 소비자는 분기 추가 필요.
- `PaymentInterpretation` 에 `"waiting_for_deposit"` 추가(이전엔 `in_progress`).
- `ConfirmMismatchReason` 에 `"CURRENCY_MISMATCH"`(승인 응답 통화가 KRW 가 아님)·`"TAX_FREE_MISMATCH"`(`expectedTaxFreeAmount` 지정 시 면세 금액 불일치) 추가.
- `getPayment` 가 `async` 함수가 됨: 입력 오류가 동기 throw 가 아니라 rejected Promise 로 나온다(`await`/`.catch` 를 쓰면 동일).
- `TossPayment.secret` 은 열거되지 않는 속성: `JSON.stringify`·스프레드·`Object.keys` 에 나오지 않고 **`structuredClone`·큐·캐시 직렬화를 거치면 사라진다**(`payment.secret` 직접 읽기는 원본에서 동일). 직렬화 전에 읽을 때는 `getPaymentSecret(payment)`(신규).

### 동작 변경 (타입은 그대로, 결과가 달라질 수 있음)
- `FDS_ERROR`(confirm) `fatal` → `uncertain`(본인 인증 뒤 결제가 이어질 수 있음).
- 본문 없는 `HTTP_401`: 조회·취소 → `fatal`(전엔 `uncertain`), **승인은 `uncertain` 유지**(일시 앞단 장애로 승인된 결제가 FAILED 가 되는 것 방지; 앱은 `HTTP_401` 코드를 알림 대상으로). 본문 없는 `HTTP_403` 은 `uncertain` 유지.
- 조회 `not_found` 는 코드가 `NOT_FOUND_PAYMENT` 일 때만. 코드 없는/다른 코드의 404 는 `uncertain`.
- 취소: `NOT_CANCELABLE_AMOUNT` 인데 조회로 이미 반영된 취소로 확인되면 `not_cancelable` 대신 `canceled`(`alreadyCanceled:true`). 부분 취소는 누계 일치 + 취소 이력의 (금액, 사유) 일치까지 확인(다른 경로의 같은 금액 취소를 오판하지 않음, 한계는 docs 참조) — `cancelReason` 에 요청별 고유값 권장.
- 취소: 부분 취소 요청의 `ALREADY_CANCELED_PAYMENT` 는 현재 누계 = 요청 전 누계+금액일 때만 `canceled`(`alreadyCanceled:true`), 결제가 다른 이유로 전액 취소돼 있으면 `not_cancelable`.
- 취소: 부분 취소 응답 누계 불일치 시 모듈이 조회 1회 추가 — 적용 확인되면 `canceled`, 아니면 `uncertain`(`CANCEL_NOT_APPLIED`/`CANCEL_TOTAL_MISMATCH`)에 `currentCanceledTotal`.
- 취소 항목의 `cancelStatus` 가 `DONE`(또는 값 없음)이 아니면(진행 중·실패) 취소 누계·완전 취소 판정·응답 검증에서 제외.
- 취소 응답: `balanceAmount` 없는 `PARTIAL_CANCELED` 도 `cancels` 합 = `totalAmount` 이면 완전 취소 판정.
- 취소 사유가 비어 있으면 throw(`INVALID_CANCEL_REASON`), `paymentKey` 형식 검사(`INVALID_PAYMENT_KEY`), `timeoutMs` 상한 120000ms·비정상 값은 15000ms.
- 키 앞뒤 공백·개행은 지우고 판정·전송.
- 확정 거절(`fatal`) 코드 추가: `EXCEED_MAX_*`, `NOT_ALLOWED_POINT_USE`, `BELOW_MINIMUM_AMOUNT`, `NOT_AVAILABLE_PAYMENT`, `NOT_AVAILABLE_BANK`, `INVALID_PASSWORD` 등(공식 에러 코드 페이지 2026-10-17). 취소 `not_cancelable` 추가: `EXCEED_CANCEL_LIMIT`, `REFUND_REJECTED`, `NOT_ALLOWED_PARTIAL_REFUND*` 등, 취소 `NOT_AVAILABLE_BANK` → `retry_later`.

### 추가 (비breaking)
- `verifyPaymentWebhook`, `WebhookCheck`, `isWebhookSecretValid` — 웹훅은 재조회 기반. 결과 `authenticated`(secret 일치)와 `refetched`(대조 불가, 진위 미확인 — 인증됨으로 쓰지 말 것)를 구분하고, 결제에 secret 이 있는데 본문에 없으면 `SECRET_MISSING` 거부. 설정 오류(KEY_MODE_*)는 던진다.
- `checkPartialCancel`, `PartialCancelCheck`, `canceledTotal`, `CancelOutcome.uncertain.currentCanceledTotal`(선택).
- `getPaymentSecret`.
- `cancelApprovedMismatch`(+ `createTossClient().cancelApprovedMismatch`), `tossKeyMode`, `assertKeyMode`, `TOSS_TIMEOUT_MAX_MS`.
- `ConfirmInput.expectedTaxFreeAmount`(선택)·`interpretPayment` 의 `expected.taxFreeAmount`(선택): 면세·복합과세 상점의 면세 금액 서버 대조.
- `CancelInput.taxFreeAmount`, `CancelInput.refundReceiveAccount`(가상계좌 환불).
- `TossPayment` 선택 필드: `currency`·`taxFreeAmount`·`suppliedAmount`·`vat`·`secret`·`virtualAccount`.

### 참고
- 위 변경은 `feat/toss-confirm-classify` 브랜치에만 올라가 있고 main 병합·`v0.3.0-rc.2` 태그는 아직 없다(태그는 사장님 직접 승인 후). 소비 앱이 이 태그로 핀을 올릴 때 위 BREAKING·전환 지점(`docs/payments-api-draft.md` §9)을 적용한다.
