# 문서 도구 2종 (doc-lint · figure-stale)

매뉴얼·문서 갱신 때 전수 조사와 수동 대조를 줄이는 범용 도구다. Node 내장 모듈과 git 만 쓴다(의존성 0, 비밀·환경변수·크론·DB 없음). **읽기 전용**이고 `--fix` 는 없다(치환은 사람이 정한다). 규칙·예외·허용 목록은 전부 설정 파일에 두고, 도구 코드에는 특정 서비스·고객·문구가 없다.

## 1. doc-lint — 문서 검사기

```
node node_modules/@platform/shared/src/doc-tools/doc-lint.mjs --config doc-lint.json [--root .]
```
설정 예: `doc-lint.example.json`(복사해서 쓴다). 설정에 객체가 있는 규칙만 켜지고 `"enabled": false` 로 끌 수 있다. `rules.<규칙>.files`·`exclude` 로 규칙마다 대상 파일을 바꿀 수 있다.

| 규칙 | 하는 일 | 설정 |
|---|---|---|
| `nounJul` | «줄» 명사(행)를 잡는다. `파일:줄` 인용 형식은 제외 | `allow`: 제외할 어간(동사 활용 등), 포함 검사 |
| `english` | 코드·링크 밖 영어 단어 | `allowWords`(약어), `allowPatterns`(커밋 해시·버전·파일 이름·경로 — 단어와 그 주변 덩어리에 적용), `screenLabels`(`{file, text}` 화면 표기 예외), `skipQuoted`(`true` 면 « » 안 제외, 배열이면 따옴표 쌍 지정), `minLength` |
| `forbidden` | 금지어 정규식 | `patterns: [{id, regex, flags, raw}]` (`raw`: 코드 안까지 원문 기준) |
| `sameBlock` | 여러 문서의 같은 구간이 같은지 | `groups: [{id, files, start, end, includeStart, includeEnd, canonical, mode, normalize}]` |
| `emphasis` | 이모지·굵게 남발 의심(선택) | `emoji`, `maxBoldPerLine` |

- 모든 줄 단위 규칙은 코드 블록, 인라인 코드, 링크 주소·URL, HTML 주석·태그를 건너뛴다.
- `sameBlock`: `start`·`end` 는 문자열 또는 `{regex, flags}`(행 단위로 찾는다). `includeStart`·`includeEnd` 로 표지 행을 구간에 넣을지 정한다. 비교 전에 번호 서식(`(1)`·`1.`·`1)`)·공백·줄바꿈 차이를 지운다(`normalize` 로 끌 수 있음). `canonical`(저장소 밖 절대 경로)이 있으면 정본과 비교하고, 없으면 «정본 파일이 없어 건너뜀» 안내 후 문서끼리 비교한다. `mode`: `auto`(기본)·`canonical`·`mutual`. **정본 문구는 공개 저장소에 두지 않는다.**
- 출력: `파일:행:규칙:발췌` 와 합계. 종료 코드 0 = 위반 없음, 1 = 위반 있음, 2 = 사용법·설정 오류.

## 2. figure-stale — 그림 변경 감지

```
node node_modules/@platform/shared/src/doc-tools/figure-stale.mjs --manifest figures.json --repo . [--images-stale images-stale.txt [--stale-paths]] [--docs "docs/**/*.md" --unregistered] [--global-watch lib/labels.ts] [--exit-zero]
```
매니페스트 예: `figure-stale.example.json`. 항목 키는 `id`·`file`(그림 경로, 기준 키)·`route`·`role`·`seed`·`sources`·`capturedCommit`·`note`. 배열 또는 `{ "figures": [...], "globalWatch": [...] }` 형식.

| 판정 | 조건 |
|---|---|
| 어긋남 후보 | `sources` 가 `capturedCommit` 이후(작업 폴더 포함) 바뀜 — 바뀐 파일을 보여 줌 |
| 미확인 | `capturedCommit` 이 없거나 저장소에 없음, `sources` 가 비었거나 없는 파일이 있음 |
| 누락 | 그림 파일이 없음 |
| 미등록 그림 | (`--unregistered`) 문서의 `![](경로)`·`<img src>` 참조가 매니페스트에 없음 |
| 전체 재확인 권고 | `globalWatch` 파일이 촬영 이후 바뀜. 한 줄만 내고 그림을 개별 어긋남으로 만들지 않음 |

정상은 건수만 출력한다. `--images-stale` 은 어긋남 후보 + 누락 그림의 파일 이름을 한 행에 하나씩 쓴다(기본은 이름만, `--stale-paths` 는 저장소 기준 경로). 종료 코드 0 = 목록 없음(또는 `--exit-zero`), 1 = 목록 있음, 2 = 사용법·매니페스트·git 오류.

## 한계
- `sources` 에 적지 않은 파일(공용 컴포넌트·스타일 등)의 변경은 못 잡는다 → 전역 감시 파일 설정을 쓴다.
- 문서 규칙은 정규식 휴리스틱이다(형태소 분석 없음). 오탐은 설정의 허용 목록으로 처리한다.
- 설정·매니페스트에 실제 고객 정보·비밀값을 넣지 않는다(공개 저장소에 올릴 때는 설정 예 파일만).
