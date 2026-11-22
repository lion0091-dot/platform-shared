# 문서 도구 2종 (doc-lint · figure-stale)

매뉴얼·문서 갱신 때 전수 조사와 수동 대조를 줄이는 범용 도구다. Node 내장 모듈과 git 만 쓴다(의존성 0, 비밀·환경변수·크론·DB 없음). **읽기 전용**이고 `--fix` 는 없다(치환은 사람이 정한다). 규칙·예외·허용 목록은 전부 설정 파일에 두고, 도구 코드에는 특정 서비스·고객·문구가 없다.

## 먼저 알아 둘 것 — 설정 JSON 작성법
- **설정·매니페스트 JSON 은 셸(echo·heredoc·PowerShell 문자열)로 만들지 말고 파일 도구(편집기·Write 도구)로 쓴다.** 셸은 역슬래시를 먹거나 바꿔서 정규식이 조용히 깨진다.
- JSON 문자열 안의 정규식은 **역슬래시를 두 번** 쓴다. 정규식 `\d+` 는 JSON 에서 `"\\d+"`, `\s` 는 `"\\s"`, 점은 `"\\."` 이다. 한 번만 쓰면(`"\d"`) JSON 읽기 오류(Bad escaped character)가 난다.
- 예: `"allowPatterns": ["^[0-9a-f]{7,40}$", "^v?\\d+(\\.\\d+)+$", "^[\\w./-]+\\.(md|png)$"]` — 커밋 해시·버전·파일 이름.
- 설정 예: `doc-lint.example.json`, `figure-stale.example.json` 을 복사해서 고친다.

## 1. doc-lint — 문서 검사기

```
node <도구 경로>/src/doc-tools/doc-lint.mjs --config doc-lint.json [--root .]
```
설정에 객체가 있는 규칙만 켜지고 `"enabled": false` 로 끌 수 있다. `rules.<규칙>.files`·`exclude` 로 규칙마다 대상 파일을 바꿀 수 있다.

| 규칙 | 하는 일 | 설정 |
|---|---|---|
| `nounJul` | `줄` 명사(행)를 잡는다. `파일:줄`·`파일:12줄` 인용 형식은 제외 | `allow`, `screenLabels` (아래) |
| `english` | 코드·링크 밖 영어 단어 | `allowWords`(약어), `allowPatterns`, `screenLabels`, `skipQuoted`, `skipForbiddenMatches`, `minLength` |
| `forbidden` | 금지어 정규식 | `patterns: [{id, regex, flags, raw, allow}]` (`raw`: 코드 안까지 원문 기준, `allow`: 행 단위 예외) |
| `sameBlock` | 여러 문서의 같은 구간이 같은지 | `groups: [{id, files, start, end, includeStart, includeEnd, canonical, mode, normalize}]` |
| `emphasis` | 이모지·굵게 남발 의심(선택) | `emoji`, `maxBoldPerLine` |

- **검사 대상 행**: 모든 행 단위 규칙은 코드 블록, 인라인 코드, 링크 주소·URL, HTML 주석·태그를 건너뛴다. 그림의 대체 글(`![대체 글](…)`)과 이미지 행의 본문은 **검사 대상**이다(주소만 빠진다).
- **`nounJul.allow`**: 공백 없는 문자열은 «어간» — 그 단어에 포함되면 제외한다(`"줄이"` 는 줄이다·줄입니다). **공백이 들어간 문자열은 «구절»** — 공백은 한 칸 이상의 공백으로 보고, 그 구절이 덮는 구간 안의 `줄` 을 제외한다(`"보여 줄"`, `"줄 운송비"`). 더 복잡하면 `{ "regex": "줄\\s+금액", "flags": "u" }` 로 쓴다.
- **`screenLabels`** (`nounJul`·`english` 공통): 화면에 실제로 나오는 문구를 예외로 둔다. 항목은 `{ "file": "glob", "text": "화면 문구" }` 또는 여러 파일 공통 `{ "files": ["glob", "glob"], "text": "…" }`(둘 다 생략하면 모든 파일). 매칭은 **구절 단위**의 정확한 문자열(대소문자 구분)이고, 영문·숫자로 시작하거나 끝나는 문구는 **단어 경계를 지킨다**(`Sign in` 은 `Sign inside` 의 앞부분을 가리지 않는다). 문구가 한 단어여도 같은 규칙이다.
- **`screenLabels.match`**: `exact`(기본, 위 설명) · `prefix`(라벨로 시작하는 단어 전체까지 예외 — `"3줄 요약"` 이 `3줄 요약본` 도 덮음, 앞쪽 단어 경계는 지킴) · `contains`(경계 없이 문자열이 어디에 있든 예외).
- **`english.skipQuoted`**: `true` 면 « » 안을 검사하지 않는다. 배열(`["«»", "“”"]`)로 따옴표 쌍을 직접 정할 수 있다. **`english.skipForbiddenMatches`**: `true` 면 `forbidden` 에 걸린 구간은 영어 규칙에서 다시 세지 않는다(합계 부풀림 방지).
- **`allowPatterns`**: 단어 하나와 그 주변 «공백으로 끊긴 덩어리» 양쪽에 적용한다(그래서 파일 이름·경로·커밋 해시·버전을 패턴 하나로 허용할 수 있다).
- **`sameBlock`**: `start`·`end` 는 문자열 또는 `{regex, flags}`(행 단위로 찾는다). `includeStart`·`includeEnd` 로 표지 행을 구간에 넣을지 정한다. 비교 전에 번호 서식(`(1)`·`1.`·`1)`)·공백·개행 차이를 지운다. 끝 표지(`end`)를 생략하거나 `null`·`"EOF"`·`{"eof": true}` 로 적으면 **문서 끝까지**다(문자 그대로 EOF 행을 끝 표지로 쓰려면 `{"regex": "^EOF$"}`). `normalize`: `ignoreNumbering`·`collapseWhitespace`(기본 켬), **`stripQuote`**(기본 끔: 인용 상자 `> ` 접두어 제거), **`stripEmphasis`**(기본 끔: 굵게 `**`·`__` 를 지우고 `stripQuote` 도 함께 적용 — 서약서처럼 서식만 다른 문서의 오탐 해소). `canonical`(저장소 밖 절대 경로)이 있으면 정본과 비교하고, 없으면 «정본 파일이 없어 건너뜀» 안내 후 문서끼리 비교한다. `mode`: `auto`(기본)·`canonical`·`mutual`. 비교할 상대가 없으면(대상 문서가 1개이고 정본도 없음) 위반이 아니라 «건너뜀» 안내만 내고 합계·종료 코드에 넣지 않는다. **정본 문구는 공개 저장소에 두지 않는다.**
- **`forbidden` 행 단위 예외(`allow`)**: 항목별로 `{ "file" 또는 "files": [...], "text" 또는 "regex" }` 에 일치하는 행(원문 한 행)은 그 항목에서만 제외한다(화면 문구·오류 메시지 인용 행, 서약서 전문 행). `text` 는 행에 포함되면, `regex` 는 행에서 일치하면 예외다. 예: `{ "id": "process-press", "regex": "눌러", "allow": [{ "files": ["docs/screens/**"], "text": "«눌러 주세요»" }, { "file": "docs/pledge.md", "regex": "^\\s*\\(\\d+\\)" }] }`.
- **금지 표현 묶음 예시**(과정 서술): `doc-lint.example.json` 의 `forbidden.patterns` 에 `확인하지 못|확인 못`, `코드 판독|코드만 읽`, `로컬에서 확인`, `눌러`, `작성 시점|검수 때` 를 넣어 두었다. 본문에 «어떻게 알아냈는지·확인하지 못한 것»이 섞이지 않게 하는 용도다. `눌러` 는 범위가 넓어 «눌러 주세요» 같은 정상 안내도 걸릴 수 있으니 오탐이면 정규식을 좁힌다(예: `눌러 (?:보|봤|본)`). 서비스별 금지어는 도구가 아니라 각자의 설정에 둔다.
- 출력: **맨 위 한 행에 도구 버전과 설정 해시**(`doc-lint v<버전> · 설정 sha256:<8자리>`), 이어서 `파일:행:규칙:발췌` 와 합계(`안내:` 로 시작하는 행은 합계에 들어가지 않는다). 종료 코드 0 = 위반 없음, 1 = 위반 있음, 2 = 사용법·설정 오류.
- **영어 단어 요약·`--summary`**: 영어 위반이 있으면 합계 앞에 `영어 단어 요약(상위 20, 서로 다른 단어 N개, 위반 M건)` 이 단어별 빈도(대소문자 합침, 빈도순)로 나온다. `--summary` 를 주면 영어 위반을 행별로 늘어놓지 않고 빈도순 전체 단어 목록만 보여 준다(허용 목록을 정할 때 쓴다). 합계·종료 코드에는 그대로 들어간다.

## 2. figure-stale — 그림 변경 감지

```
node <도구 경로>/src/doc-tools/figure-stale.mjs --manifest figures.json --repo . [--images-stale images-stale.txt [--stale-paths]] [--docs "docs/**/*.md" --unregistered [--image-base docs]] [--global-watch lib/labels.ts] [--exit-zero]
```
매니페스트 예: `figure-stale.example.json`. 항목 키는 `id`·`file`(그림 경로, 기준 키)·`route`·`role`·`seed`·`sources`·`capturedCommit`·`note`. 배열 또는 `{ "figures": [...], "globalWatch": [...], "imageBase": "docs" }` 형식. **`id`·`file` 만 필수**이고 `route`·`sources`·`capturedCommit` 등이 비어 있거나 없어도 받아 준다(아직 정리 중인 항목은 «미확인» 으로 분류될 뿐 오류가 아니다).

| 판정 | 조건 |
|---|---|
| 어긋남 후보 | `sources` 가 `capturedCommit` 이후(작업 폴더 포함) 바뀜 — 바뀐 파일을 보여 줌 |
| 미확인 | `capturedCommit` 이 없거나 저장소에 없음, `sources` 가 비었거나(없거나) 없는 파일이 있음 |
| 누락 | 그림 파일이 없음 |
| 미등록 그림 | (`--unregistered`) 문서의 `![](경로)`·`<img src>` 참조가 매니페스트에 없음 |
| 전체 재확인 권고 | `globalWatch` 파일이 촬영 이후 바뀜. 한 행만 내고 그림을 개별 어긋남으로 만들지 않음 |

- **화면 단위 소스 그룹(`screens`)**: 매니페스트 최상위에 `"screens": { "orders": ["app/orders/page.tsx", "…"] }` 를 두고 그림에 `"screen": "orders"` 를 주면 여러 그림이 같은 화면 소스를 함께 참조한다(그림의 `sources` 와 합쳐서 본다). 없는 screen 이름은 «미확인»이다.
- **뼈대 생성(`--init`)**: `figure-stale --init --manifest figures.json --repo . --docs "docs/**/*.md" [--image-base docs]` 는 문서의 그림 참조에서 항목을 만든다(`id`=그림 파일 이름, `capturedCommit`=그림 파일의 마지막 커밋, `note`=참조한 장(앞쪽 가장 가까운 `#`·`##` 제목), `route`·`role`·`seed`·`screen`·`sources` 는 빈 값). **기존 항목은 그대로 두고** 없는 그림만 덧붙이며 `screens`·`globalWatch`·`imageBase` 도 보존한다. 다시 돌려도 중복이 생기지 않는다. 이 모드만 매니페스트 파일을 쓴다.
- **출력 첫 행**: `figure-stale v<버전> · 설정 sha256:<8자리>`(매니페스트 해시).
- **참조 경로 기준(`imageBase`)**: 기본은 «그 문서가 있는 디렉터리» 기준이다. 모든 문서가 `images/…` 처럼 같은 폴더 기준으로 쓰면 오탐이 많으니 `--image-base DIR`(또는 매니페스트 최상위 `imageBase`, 저장소 기준 디렉터리)를 준다. 앞이 `/` 인 경로는 항상 저장소 루트 기준이다. 옵션이 매니페스트보다 우선한다.
- 정상은 건수만 출력한다. `--images-stale` 은 어긋남 후보 + 누락 그림의 파일 이름을 한 행에 하나씩 쓴다(기본은 이름만, `--stale-paths` 는 저장소 기준 경로). 종료 코드 0 = 목록 없음(또는 `--exit-zero`), 1 = 목록 있음, 2 = 사용법·매니페스트·git 오류.

## 한계
- `sources` 에 적지 않은 파일(공용 컴포넌트·스타일 등)의 변경은 못 잡는다 → 전역 감시 파일 설정을 쓴다.
- 문서 규칙은 정규식 휴리스틱이다(형태소 분석 없음). 오탐은 설정의 허용 목록으로 처리한다.
- 설정·매니페스트에 실제 고객 정보·비밀값을 넣지 않는다(공개 저장소에 올릴 때는 설정 예 파일만).
