import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import * as lint from "./doc-lint.mjs";
import * as fig from "./figure-stale.mjs";

// 모든 입력은 합성 파일이다. 현재 시각·시간대·실제 문서에 의존하지 않는다.

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), "doctools-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const put = (root: string, rel: string, text: string) => {
  const p = path.join(root, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, text, "utf8");
};

const JUL_ALLOW = ["줄이", "줄어", "줄입", "돌려줄"];
const cfgOf = (rules: Record<string, unknown>, extra: Record<string, unknown> = {}) => lint.parseConfig({ include: ["**/*.md"], rules, ...extra });
const lintText = (text: string, rules: Record<string, unknown>, file = "docs/a.md") => {
  const cfg = cfgOf(rules);
  return lint.lintLines(file, text, cfg, new Set(Object.keys(cfg.rules))).map((v) => `${v.line}:${v.rule}`);
};

describe("doc-lint — 가림(마크다운 예외)", () => {
  it("코드 블록·인라인 코드·링크 주소·URL·HTML 주석·태그는 검사에서 빠지고 위치는 유지된다", () => {
    const text = ["본문 줄", "```", "코드 줄", "```", "`인라인 줄` 끝", "[링크](https://example.com/줄/x) 끝", "<!-- 주석 줄 -->", "https://example.com/줄 끝", '<a href="줄">본문</a>'].join("\n");
    const masked = lint.maskMarkdown(text);
    expect(masked.length).toBe(text.length);
    expect(masked.split("\n").length).toBe(text.split("\n").length);
    expect(lintText(text, { nounJul: { allow: [] } })).toEqual(["1:noun-jul"]);
  });
  it("닫히지 않은 코드 블록은 끝까지, 닫히지 않은 주석도 끝까지 가린다", () => {
    expect(lintText(["앞", "```", "코드 줄", "줄 또"].join("\n"), { nounJul: { allow: [] } })).toEqual([]);
    expect(lintText(["앞", "<!-- 열린 주석 줄", "줄 또"].join("\n"), { nounJul: { allow: [] } })).toEqual([]);
  });
});

describe("doc-lint — «줄» 명사", () => {
  const rules = { nounJul: { allow: JUL_ALLOW } };
  it("명사 «줄»은 잡고 동사 활용·허용 어간은 제외한다", () => {
    expect(lintText("세 줄을 읽는다", rules)).toEqual(["1:noun-jul"]);
    expect(lintText("3줄 남았다", rules)).toEqual(["1:noun-jul"]);
    expect(lintText("범위를 줄이다, 줄입니다, 줄어든다, 값을 돌려줄 수 있다", rules)).toEqual([]);
  });
  it("파일:줄 인용 형식은 제외한다", () => {
    expect(lintText("파일:줄 형식으로 적는다", rules)).toEqual([]);
    expect(lintText("a.ts:12줄 근처", rules)).toEqual([]);
  });
  it("허용 목록이 비면 동사도 잡는다(설정이 기준)", () => {
    expect(lintText("범위를 줄입니다", { nounJul: { allow: [] } })).toEqual(["1:noun-jul"]);
  });
});

describe("doc-lint — 영어 단어", () => {
  it("백틱·코드 블록·링크 밖 영어를 잡고 허용 단어는 제외한다", () => {
    const rules = { english: { allowWords: ["API"] } };
    expect(lintText("Hello 세계", rules)).toEqual(["1:english"]);
    expect(lintText("API 호출과 `code` 와 [링크](http://x.test/abc)", rules)).toEqual([]);
    expect(lintText("```\nplain english\n```", rules)).toEqual([]);
  });
  it("한 글자는 기본 제외(minLength 2), 설정으로 바꿀 수 있다", () => {
    expect(lintText("A 안", { english: {} })).toEqual([]);
    expect(lintText("A 안", { english: { minLength: 1 } })).toEqual(["1:english"]);
  });
  it("패턴 허용: 커밋 해시·버전·파일 이름·경로", () => {
    const rules = { english: { allowPatterns: ["^[0-9a-f]{7,40}$", "^v?\\d+(\\.\\d+)+$", "^[\\w.-]+\\.(md|ts)$", "/"] } };
    expect(lintText("커밋 abcdef1 과 v1.2 와 README.md 와 src/app/x 참고", rules)).toEqual([]);
    expect(lintText("커밋 zzzzzzz 참고", rules)).toEqual(["1:english"]);
  });
  it("« » 안 화면 인용은 skipQuoted 로 제외한다(끄면 잡는다)", () => {
    expect(lintText("버튼 «Sign in» 을 누른다", { english: { skipQuoted: true } })).toEqual([]);
    expect(lintText("버튼 «Sign in» 을 누른다", { english: {} })).toEqual(["1:english", "1:english"]);
    expect(lintText("버튼 “Save” 을", { english: { skipQuoted: ["“”"] } })).toEqual([]);
  });
  it("화면 표기 예외표: 파일·원문 쌍은 그 파일에서만 허용한다", () => {
    const rules = { english: { screenLabels: [{ file: "docs/screens/**", text: "Sign in" }] } };
    expect(lintText("Sign in 화면", rules, "docs/screens/a.md")).toEqual([]);
    expect(lintText("Sign in 화면", rules, "docs/other/a.md").length).toBe(2);
  });
});

describe("doc-lint — 허용 구절·화면 표기 예외·중복 보고", () => {
  it("nounJul 허용: 띄어 쓴 구절(공백은 여러 칸도 허용)과 정규식 항목이 그 구간 안의 «줄»을 제외한다", () => {
    const rules = { nounJul: { allow: ["보여 줄", "줄 운송비", { regex: "줄\\s+금액" }] } };
    expect(lintText("화면에 보여 줄 수 있다", rules)).toEqual([]);
    expect(lintText("화면에 보여   줄 수 있다", rules)).toEqual([]);
    expect(lintText("지급할 줄 운송비 합계", rules)).toEqual([]);
    expect(lintText("받을 줄 금액", rules)).toEqual([]);
    expect(lintText("세 줄 남음", rules)).toEqual(["1:noun-jul"]);
    expect(lintText("보여 줄 것과 세 줄", rules)).toEqual(["1:noun-jul"]);
  });
  it("nounJul 화면 표기 예외 {file, text} / {files[], text}", () => {
    const rules = { nounJul: { allow: [], screenLabels: [{ file: "docs/screens/**", text: "3줄 요약" }, { files: ["docs/a.md", "docs/b.md"], text: "3줄 주문" }] } };
    expect(lintText("화면 «3줄 요약» 표시", rules, "docs/screens/x.md")).toEqual([]);
    expect(lintText("화면 «3줄 요약» 표시", rules, "docs/other.md")).toEqual(["1:noun-jul"]);
    expect(lintText("화면 «3줄 주문» 표시", rules, "docs/b.md")).toEqual([]);
    expect(lintText("화면 «3줄 주문» 표시", rules, "docs/c.md")).toEqual(["1:noun-jul"]);
  });
  it("english 화면 표기 예외: files 배열·구절 단위 매칭(단어 경계 지킴, 대소문자 구분)", () => {
    const rules = { english: { screenLabels: [{ files: ["docs/a.md", "docs/b.md"], text: "Sign in" }, { text: "OK" }] } };
    expect(lintText("Sign in 화면", rules, "docs/b.md")).toEqual([]);
    expect(lintText("Sign in 화면", rules, "docs/c.md").length).toBe(2);
    expect(lintText("Sign inside 화면", rules, "docs/a.md").length).toBe(2);
    expect(lintText("sign in 화면", rules, "docs/a.md").length).toBe(2);
    expect(lintText("OK 버튼", rules)).toEqual([]);
    expect(lintText("OKAY 버튼", rules)).toEqual(["1:english"]);
  });
  it("english.skipForbiddenMatches: 금지어에 걸린 토큰은 영어 규칙에서 다시 세지 않는다", () => {
    const forbidden = { patterns: [{ id: "x", regex: "badword" }] };
    expect(lintText("badword 사용", { forbidden, english: {} }).sort()).toEqual(["1:english", "1:forbidden.x"]);
    expect(lintText("badword 사용", { forbidden, english: { skipForbiddenMatches: true } })).toEqual(["1:forbidden.x"]);
  });
  it("그림 대체 글(alt)·이미지 행도 행 규칙의 검사 대상이다", () => {
    expect(lintText("![세 줄 화면](img/a.png)", { nounJul: { allow: [] } })).toEqual(["1:noun-jul"]);
  });
});

describe("doc-lint — 보강(헤더·요약·표지·접두 일치·금지 표현 예시)", () => {
  const exec = (argv: string[]) => {
    const out: string[] = [];
    const code = lint.run(argv, { out: (s) => out.push(s), err: () => undefined });
    return { code, out };
  };
  it("출력 맨 위에 도구 버전과 설정 해시를 보여 주고, 설정이 바뀌면 해시가 바뀐다", () => {
    const root = tmp();
    put(root, "docs/a.md", "정상\n");
    put(root, "c1.json", JSON.stringify({ include: ["docs/**/*.md"], rules: { forbidden: { patterns: [{ regex: "x" }] } } }));
    put(root, "c2.json", JSON.stringify({ include: ["docs/**/*.md"], rules: { forbidden: { patterns: [{ regex: "y" }] } } }));
    const a = exec(["--config", path.join(root, "c1.json"), "--root", root]).out[0];
    const a2 = exec(["--config", path.join(root, "c1.json"), "--root", root]).out[0];
    const b = exec(["--config", path.join(root, "c2.json"), "--root", root]).out[0];
    expect(a).toMatch(/^doc-lint v\S+ · 설정 sha256:[0-9a-f]{8}$/);
    expect(a2).toBe(a);
    expect(b).not.toBe(a);
  });
  it("영어 단어 요약: 빈도순·상위 20개, --summary 는 영어 행 목록을 접고 합계는 유지한다", () => {
    const root = tmp();
    const words = Array.from({ length: 25 }, (_, i) => `word${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`);
    put(root, "docs/a.md", `${words.join(" ")}\nwordaa wordaa Wordaa\n`);
    put(root, "cfg.json", JSON.stringify({ include: ["docs/**/*.md"], rules: { english: {} } }));
    const base = ["--config", path.join(root, "cfg.json"), "--root", root];
    const normal = exec(base);
    expect(normal.code).toBe(1);
    const head = normal.out.find((l) => l.startsWith("영어 단어 요약")) ?? "";
    expect(head).toContain("상위 20");
    expect(head).toContain("서로 다른 단어 25개");
    expect(normal.out.some((l) => l.includes("wordaa×4"))).toBe(true);
    expect(normal.out.filter((l) => l.startsWith("docs/a.md:")).length).toBe(28);
    const summary = exec([...base, "--summary"]);
    expect(summary.out.filter((l) => l.startsWith("docs/a.md:"))).toEqual([]);
    expect(summary.out.find((l) => l.startsWith("영어 단어 요약"))).toContain("빈도순 전체");
    expect(summary.out[summary.out.length - 1]).toContain("위반 합계 28건");
    expect(lint.summarizeWords([{ file: "a", line: 1, rule: "english", excerpt: "", word: "Api" }, { file: "a", line: 2, rule: "english", excerpt: "", word: "api" }])).toEqual([["api", 2]]);
  });
  it("sameBlock: 끝 표지를 생략하거나 EOF 로 적으면 문서 끝까지, stripQuote 는 인용 기호만 무시한다", () => {
    const root = tmp();
    put(root, "docs/a.md", "앞글\n## 유의\n(1) 가나다\n(2) 라마바\n");
    put(root, "docs/b.md", "머리말 다름\n## 유의\n> 1. 가나다\n> 2. 라마바\n");
    const g = { id: "g", files: ["docs/*.md"], start: { regex: "^## 유의" } };
    const runG = (extra: Record<string, unknown>) => lint.runDocLint(cfgOf({ sameBlock: { groups: [{ ...g, ...extra }] } }), root).violations;
    expect(runG({ normalize: { stripQuote: true } })).toEqual([]);
    expect(runG({ end: "EOF", normalize: { stripQuote: true } })).toEqual([]);
    expect(runG({ end: null, normalize: { stripQuote: true } })).toEqual([]);
    expect(runG({ end: { eof: true }, normalize: { stripQuote: true } })).toEqual([]);
    expect(runG({}).length).toBe(1); // 인용 기호가 달라 다름
    put(root, "docs/b.md", "머리말 다름\n## 유의\n> 1. **가나다**\n> 2. 라마바\n");
    expect(runG({ normalize: { stripQuote: true } }).length).toBe(1); // 굵게는 stripEmphasis 가 있어야 무시
    expect(runG({ normalize: { stripEmphasis: true } })).toEqual([]);
  });
  it("screenLabels match: exact(기본) · prefix(라벨로 시작하는 단어 전체) · contains(경계 없이)", () => {
    const labels = (match?: string) => ({ english: { screenLabels: [{ text: "Order", ...(match ? { match } : {}) }] } });
    expect(lintText("Orders 화면", labels()).length).toBe(1); // exact: Orders 는 다른 단어
    expect(lintText("Orders 화면", labels("prefix"))).toEqual([]);
    expect(lintText("Order 화면", labels("prefix"))).toEqual([]);
    expect(lintText("MyOrder 화면", labels("prefix")).length).toBe(1); // prefix 도 앞 단어 경계는 지킨다
    expect(lintText("XOrder 화면", labels("contains"))).toEqual([]);
    expect(() => cfgOf({ english: { screenLabels: [{ text: "x", match: "bad" }] } })).toThrow(/match/);
    const jul = { nounJul: { allow: [], screenLabels: [{ text: "3줄 요약", match: "prefix" }] } };
    expect(lintText("«3줄 요약본» 표시", jul)).toEqual([]);
  });
  it("설정 예 파일의 금지 표현 묶음(과정 서술)이 해당 문구를 잡는다", () => {
    const example = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "doc-lint.example.json"), "utf8"));
    const cfg = lint.parseConfig({ include: ["**/*.md"], rules: { forbidden: example.rules.forbidden } });
    const phrases = ["확인하지 못했다", "확인 못 함", "코드 판독 결과", "코드만 읽고", "로컬에서 확인함", "버튼을 눌러 보니", "작성 시점 기준", "검수 때 발견", "TODO 남김"];
    for (const p of phrases) expect(lint.lintLines("docs/a.md", p, cfg, new Set(["forbidden"])).length, p).toBeGreaterThan(0);
    expect(lint.lintLines("docs/a.md", "정상적인 안내 문장입니다", cfg, new Set(["forbidden"]))).toEqual([]);
    expect(() => lint.parseConfig(example)).not.toThrow();
  });
});

describe("doc-lint — 금지어·강조", () => {
  it("금지어 정규식: 본문은 가림 뒤, raw 는 원문 기준", () => {
    const rules = { forbidden: { patterns: [{ id: "x", regex: "비밀단어" }, { id: "r", regex: "원문단어", raw: true }] } };
    expect(lintText("`비밀단어` 는 코드", rules)).toEqual([]);
    expect(lintText("비밀단어 입니다", rules)).toEqual(["1:forbidden.x"]);
    expect(lintText("`원문단어` 는 코드", rules)).toEqual(["1:forbidden.r"]);
  });
  it("이모지·굵게 남발은 선택 규칙으로만 잡는다", () => {
    const text = "좋아요 \u{1F600}\n**가** **나** **다** **라** 많음\n**가** 하나";
    expect(lintText(text, {})).toEqual([]);
    expect(lintText(text, { emphasis: {} })).toEqual(["1:emphasis.emoji", "2:emphasis.bold"]);
    expect(lintText(text, { emphasis: { enabled: false } })).toEqual([]);
  });
});

describe("doc-lint — 같은 블록 일치", () => {
  const block = (lines: string[]) => ["앞글", "<!-- BEGIN -->", ...lines, "<!-- END -->", "뒷글"].join("\n");
  const group = (extra: Record<string, unknown> = {}) => ({ id: "g", files: ["docs/*.md"], start: "BEGIN", end: "END", ...extra });
  const run = (root: string, g: Record<string, unknown>) => lint.runDocLint(cfgOf({ sameBlock: { groups: [g] } }), root);

  it("번호 서식·공백·줄바꿈 차이는 무시하고 내용이 다른 문서만 집는다", () => {
    const root = tmp();
    put(root, "docs/a.md", block(["(1) 개인정보는   업무에서만 씁니다.", "(2) 누설하지 않습니다."]));
    put(root, "docs/b.md", block(["1. 개인정보는 업무에서만", "   씁니다.", "2) 누설하지 않습니다."]));
    put(root, "docs/c.md", block(["(1) 개인정보는 업무에서만 씁니다.", "(2) 누설해도 됩니다."]));
    const r = run(root, group());
    expect(r.violations.map((v) => v.file)).toEqual(["docs/c.md"]);
    expect(r.violations[0].line).toBe(2);
    expect(r.violations[0].excerpt).toContain("기준 docs/a.md");
  });
  it("정규화를 끄면 번호·공백 차이도 다름으로 본다", () => {
    const root = tmp();
    put(root, "docs/a.md", block(["(1) 가나다", "(2) 라마바"]));
    put(root, "docs/b.md", block(["1. 가나다", "2. 라마바"]));
    put(root, "docs/c.md", block(["(1) 가나다", "(2) 라마바"]));
    const r = run(root, group({ normalize: { ignoreNumbering: false, collapseWhitespace: false } }));
    expect(r.violations.map((v) => v.file)).toEqual(["docs/b.md"]);
  });
  it("표지는 정규식으로도 줄 수 있고, 표지 행 포함 여부를 정한다", () => {
    const root = tmp();
    put(root, "docs/a.md", ["시작 7", "본문", "끝 7", "x"].join("\n"));
    put(root, "docs/b.md", ["시작 8", "본문", "끝 8", "x"].join("\n"));
    const g = { start: { regex: "^시작 \\d" }, end: { regex: "^끝 \\d" } };
    expect(run(root, group(g)).violations).toEqual([]);
    expect(run(root, group({ ...g, includeStart: true })).violations.length).toBe(1);
  });
  it("표지가 없는 문서는 위반이고, 비교 대상이 1개뿐이면 위반이 아니라 «건너뜀» 안내다(합계·종료 코드에 넣지 않음)", () => {
    const root = tmp();
    put(root, "docs/a.md", block(["가"]));
    put(root, "docs/b.md", "표지 없음");
    const r = run(root, group());
    expect(r.violations.map((v) => `${v.file}:${v.excerpt}`)).toContain("docs/b.md:시작·끝 표지를 찾지 못했다");
    const solo = tmp();
    put(solo, "docs/a.md", block(["가"]));
    const s = run(solo, group());
    expect(s.violations).toEqual([]);
    expect(s.notices[0]).toContain("건너뜀(정본·상대 문서 없음");
    put(solo, "cfg.json", JSON.stringify({ include: ["docs/**/*.md"], rules: { sameBlock: { groups: [group()] } } }));
    const out: string[] = [];
    expect(lint.run(["--config", path.join(solo, "cfg.json"), "--root", solo], { out: (x) => out.push(x) })).toBe(0);
    expect(out[out.length - 1]).toContain("위반 합계 0건");
    expect(out[1]).toContain("안내:");
  });
  it("정규화 옵션 stripEmphasis: 굵게·인용 기호 차이를 무시한다(기본은 끔)", () => {
    const root = tmp();
    put(root, "docs/a.md", block(["(1) 개인정보는 **업무에서만** 씁니다.", "(2) 누설하지 않습니다."]));
    put(root, "docs/b.md", block(["> (1) 개인정보는 업무에서만 씁니다.", "> (2) 누설하지 않습니다."]));
    put(root, "docs/c.md", block(["(1) 개인정보는 __업무에서만__ 씁니다.", "(2) 누설하지 않습니다."]));
    expect(run(root, group()).violations.length).toBeGreaterThan(0);
    expect(run(root, group({ normalize: { stripEmphasis: true } })).violations).toEqual([]);
  });
  it("행 단위 검사 요약 문구에 «줄» 명사가 없다", () => {
    const root = tmp();
    put(root, "docs/a.md", "정상\n");
    put(root, "cfg.json", JSON.stringify({ include: ["docs/**/*.md"], rules: { nounJul: { allow: [] } } }));
    const out: string[] = [];
    lint.run(["--config", path.join(root, "cfg.json"), "--root", root], { out: (x) => out.push(x) });
    expect(out.join("\n")).toContain("행 단위 검사 파일 1개");
    expect(out.join("\n")).not.toContain("줄");
  });
  it("정본(저장소 밖 절대 경로): 있으면 정본과 비교, 없으면 건너뛰고 문서끼리 비교", () => {
    const root = tmp();
    const outside = tmp();
    put(outside, "canon.txt", "개인정보는 업무에서만 씁니다.\n누설하지 않습니다.");
    put(root, "docs/a.md", block(["(1) 개인정보는 업무에서만 씁니다.", "(2) 누설하지 않습니다."]));
    put(root, "docs/b.md", block(["1. 개인정보는 업무에서만 씁니다.", "2. 누설하지 않습니다."]));
    put(root, "docs/c.md", block(["1. 개인정보는 업무에서만 씁니다.", "2. 누설해도 됩니다."]));
    const canonical = path.join(outside, "canon.txt");
    const withCanon = run(root, group({ canonical }));
    expect(withCanon.violations.map((v) => v.file)).toEqual(["docs/c.md"]);
    expect(withCanon.violations[0].excerpt).toContain("정본과 다름");
    // 모든 문서가 같아도 정본과 다르면 전부 위반(상호 비교로는 못 잡는 경우)
    put(root, "docs/a.md", block(["(1) 다른 내용"]));
    put(root, "docs/b.md", block(["(1) 다른 내용"]));
    put(root, "docs/c.md", block(["(1) 다른 내용"]));
    expect(run(root, group({ canonical })).violations.length).toBe(3);
    expect(run(root, group({ canonical, mode: "mutual" })).violations).toEqual([]);
    const missing = run(root, group({ canonical: path.join(outside, "없음.txt") }));
    expect(missing.notices[0]).toContain("건너뛴다");
    expect(missing.violations).toEqual([]);
    expect(run(root, group({ canonical: path.join(outside, "없음.txt"), mode: "canonical" })).violations).toEqual([]);
  });
});

describe("doc-lint — CLI·설정", () => {
  const exec = (argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = lint.run(argv, { out: (s) => out.push(s), err: (s) => err.push(s) });
    return { code, out, err };
  };
  it("위반이 있으면 종료 코드 1, 없으면 0, 출력은 파일:행:규칙:발췌 + 합계", () => {
    const root = tmp();
    put(root, "docs/a.md", "정상 문장\n세 줄 남음\n");
    put(root, "cfg.json", JSON.stringify({ include: ["docs/**/*.md"], rules: { nounJul: { allow: JUL_ALLOW } } }));
    const bad = exec(["--config", path.join(root, "cfg.json"), "--root", root]);
    expect(bad.code).toBe(1);
    expect(bad.out[0]).toMatch(/^doc-lint v\S+ · 설정 sha256:[0-9a-f]{8}$/);
    expect(bad.out[1]).toBe("docs/a.md:2:noun-jul:세 줄 남음");
    expect(bad.out[bad.out.length - 1]).toContain("위반 합계 1건");
    put(root, "docs/a.md", "정상 문장\n");
    expect(exec(["--config", path.join(root, "cfg.json"), "--root", root]).code).toBe(0);
  });
  it("exclude·규칙별 exclude·files 가 대상 파일을 가른다", () => {
    const root = tmp();
    put(root, "docs/a.md", "세 줄\n");
    put(root, "docs/skip/b.md", "세 줄\n");
    put(root, "docs/c.md", "Hello\n");
    const cfg = lint.parseConfig({ include: ["docs/**/*.md"], exclude: ["docs/skip/**"], rules: { nounJul: { allow: [], exclude: ["docs/c.md"] }, english: { files: ["docs/c.md"] } } });
    const r = lint.runDocLint(cfg, root);
    expect(r.violations.map((v) => `${v.file}:${v.rule}`)).toEqual(["docs/a.md:noun-jul", "docs/c.md:english"]);
  });
  it("설정 오류·사용법 오류는 종료 코드 2", () => {
    const root = tmp();
    put(root, "bad.json", JSON.stringify({ include: ["**/*.md"], rules: { forbidden: { patterns: [{ regex: "(" }] } } }));
    expect(exec(["--config", path.join(root, "bad.json"), "--root", root]).code).toBe(2);
    expect(exec([]).code).toBe(2);
    expect(exec(["--x"]).code).toBe(2);
    expect(() => lint.parseConfig({ rules: {} })).toThrow(/include/);
    expect(() => lint.parseConfig({ include: ["a"], rules: { sameBlock: { groups: [{ files: ["a"] }] } } })).toThrow(/start/);
    expect(() => lint.parseConfig({ include: ["a"], rules: { sameBlock: { groups: [{ files: ["a"], start: "s" }] } } })).not.toThrow(); // 끝 표지 생략 = 문서 끝까지
  });
});

// ── figure-stale ────────────────────────────────────────────────
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
const commitAll = (cwd: string, msg: string) => {
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", msg);
  return git(cwd, "rev-parse", "HEAD");
};

describe("figure-stale", () => {
  const setup = () => {
    const repo = tmp();
    git(repo, "init", "-q");
    put(repo, "app/orders.tsx", "v1");
    put(repo, "app/detail.tsx", "v1");
    put(repo, "lib/labels.ts", "v1");
    put(repo, "docs/img/orders.png", "png");
    put(repo, "docs/img/detail.png", "png");
    const c1 = commitAll(repo, "first");
    return { repo, c1 };
  };
  const manifestOf = (figures: unknown[], extra: Record<string, unknown> = {}) => fig.parseManifest({ figures, ...extra });
  const entry = (id: string, file: string, sources: string[], capturedCommit: string) => ({ id, file, route: "/x", role: "r", seed: "s", sources, capturedCommit, note: "" });

  it("정상은 건수만, sources 가 촬영 이후 바뀌면 어긋남 후보(바뀐 파일 표시)", () => {
    const { repo, c1 } = setup();
    const m = manifestOf([entry("o", "docs/img/orders.png", ["app/orders.tsx"], c1), entry("d", "docs/img/detail.png", ["app/detail.tsx"], c1)]);
    expect(fig.checkFigures({ manifest: m, repo })).toMatchObject({ ok: 2, stale: [], unknown: [], missing: [], total: 2 });
    put(repo, "app/orders.tsx", "v2");
    commitAll(repo, "change");
    const r = fig.checkFigures({ manifest: m, repo });
    expect(r.ok).toBe(1);
    expect(r.stale).toEqual([{ id: "o", file: "docs/img/orders.png", changed: ["app/orders.tsx"], commit: c1 }]);
    expect(fig.formatReport(r).join("\n")).toContain("[어긋남 후보] 1건");
  });
  it("커밋하지 않은 작업 폴더 변경도 어긋남 후보로 본다", () => {
    const { repo, c1 } = setup();
    put(repo, "app/orders.tsx", "dirty");
    const r = fig.checkFigures({ manifest: manifestOf([entry("o", "docs/img/orders.png", ["app/orders.tsx"], c1)]), repo });
    expect(r.stale.length).toBe(1);
  });
  it("미확인: capturedCommit 없음·찾을 수 없음·sources 없음·없는 소스 파일", () => {
    const { repo, c1 } = setup();
    const m = manifestOf([
      { id: "a", file: "docs/img/orders.png", sources: ["app/orders.tsx"] },
      entry("b", "docs/img/detail.png", ["app/detail.tsx"], "0000000000000000000000000000000000000000"),
    ]);
    const r = fig.checkFigures({ manifest: m, repo });
    expect(r.unknown.map((u) => u.id)).toEqual(["a", "b"]);
    expect(r.unknown[0].why).toContain("capturedCommit 없음");
    expect(r.unknown[1].why).toContain("찾을 수 없음");
    const m2 = manifestOf([entry("c", "docs/img/orders.png", [], c1), entry("d", "docs/img/detail.png", ["app/없는파일.tsx"], c1)]);
    const r2 = fig.checkFigures({ manifest: m2, repo });
    expect(r2.unknown.map((u) => u.why)).toEqual(["sources 없음", "sources 에 없는 파일: app/없는파일.tsx"]);
  });
  it("누락: 이미지 파일이 없으면(소스가 바뀌었어도) 누락으로만 낸다", () => {
    const { repo, c1 } = setup();
    put(repo, "app/orders.tsx", "v2");
    commitAll(repo, "change");
    const r = fig.checkFigures({ manifest: manifestOf([entry("x", "docs/img/없음.png", ["app/orders.tsx"], c1)]), repo });
    expect(r.missing).toEqual([{ id: "x", file: "docs/img/없음.png" }]);
    expect(r.stale).toEqual([]);
  });
  it("전역 감시 파일이 바뀌면 «전체 재확인 권고» 한 줄만 내고 그림을 개별 어긋남으로 만들지 않는다", () => {
    const { repo, c1 } = setup();
    put(repo, "lib/labels.ts", "v2");
    commitAll(repo, "labels");
    const m = manifestOf([entry("o", "docs/img/orders.png", ["app/orders.tsx"], c1), entry("d", "docs/img/detail.png", ["app/detail.tsx"], c1)], { globalWatch: ["lib/labels.ts"] });
    const r = fig.checkFigures({ manifest: m, repo });
    expect(r.stale).toEqual([]);
    expect(r.globalChanged).toEqual({ files: ["lib/labels.ts"], figures: 2 });
    expect(fig.formatReport(r).filter((l) => l.includes("전체 재확인 권고")).length).toBe(1);
    const viaOption = fig.checkFigures({ manifest: manifestOf([entry("o", "docs/img/orders.png", ["app/orders.tsx"], c1)]), repo, globalWatch: ["lib/labels.ts"] });
    expect(viaOption.globalChanged?.files).toEqual(["lib/labels.ts"]);
  });
  it("미등록 그림: 문서의 이미지 참조 중 매니페스트에 없는 것만(코드 블록·외부 주소 제외)", () => {
    const { repo, c1 } = setup();
    put(repo, "docs/guide.md", ["![주문](img/orders.png)", "![없음](img/new.png)", "<img src=\"img/html.png\">", "![외부](https://example.test/a.png)", "```", "![코드](img/code.png)", "```"].join("\n"));
    const m = manifestOf([entry("o", "docs/img/orders.png", ["app/orders.tsx"], c1)]);
    const r = fig.checkFigures({ manifest: m, repo, docs: ["docs/**/*.md"], unregistered: true });
    expect(r.unregistered.map((u) => `${u.doc}:${u.line}:${u.path}`)).toEqual(["docs/guide.md:2:docs/img/new.png", "docs/guide.md:3:docs/img/html.png"]);
  });
  it("imageBase: 참조 경로를 문서 위치가 아니라 지정 디렉터리 기준으로 해석한다(매니페스트·옵션·CLI)", () => {
    const { repo, c1 } = setup();
    put(repo, "docs/sub/deep/guide.md", "![주문](images/orders.png)\n![새것](images/new.png)\n![절대](/docs/images/detail.png)\n");
    put(repo, "docs/images/orders.png", "png");
    const figures = [entry("o", "docs/images/orders.png", ["app/orders.tsx"], c1), entry("d", "docs/images/detail.png", ["app/detail.tsx"], c1)];
    const base = { manifest: fig.parseManifest({ figures }), repo, docs: ["docs/sub/**/*.md"], unregistered: true };
    // 기본(문서 위치 기준): 세 참조 모두 docs/sub/deep/ 아래로 읽혀 «미등록»이 부풀려진다
    expect(fig.checkFigures(base).unregistered.map((u) => u.path)).toEqual(["docs/sub/deep/images/orders.png", "docs/sub/deep/images/new.png"]);
    // 옵션: 지정 디렉터리 기준, 앞이 / 인 경로는 저장소 루트 기준
    expect(fig.checkFigures({ ...base, imageBase: "docs" }).unregistered.map((u) => u.path)).toEqual(["docs/images/new.png"]);
    expect(fig.checkFigures({ ...base, imageBase: "docs/" }).unregistered.length).toBe(1);
    // 매니페스트 최상위 imageBase
    const viaManifest = fig.checkFigures({ ...base, manifest: fig.parseManifest({ imageBase: "docs", figures }) });
    expect(viaManifest.unregistered.map((u) => u.path)).toEqual(["docs/images/new.png"]);
    // CLI 옵션
    const mf = path.join(repo, "m.json");
    writeFileSync(mf, JSON.stringify(figures), "utf8");
    const out: string[] = [];
    fig.run(["--manifest", mf, "--repo", repo, "--docs", "docs/sub/**/*.md", "--unregistered", "--image-base", "docs"], { out: (s) => out.push(s) });
    expect(out.join("\n")).toContain("docs/images/new.png");
    expect(out.join("\n")).not.toContain("deep/images");
  });
  it("route·sources 가 비어 있어도 매니페스트는 받아 주고 «미확인»으로 분류한다", () => {
    const { repo, c1 } = setup();
    const m = fig.parseManifest([{ id: "a", file: "docs/img/orders.png", route: "", sources: [], capturedCommit: c1 }, { id: "b", file: "docs/img/detail.png", capturedCommit: c1 }]);
    const r = fig.checkFigures({ manifest: m, repo });
    expect(r.unknown.map((u) => u.why)).toEqual(["sources 없음", "sources 없음"]);
    expect(r.stale).toEqual([]);
  });
  it("screens: 화면 단위 소스 그룹을 여러 그림이 함께 참조한다(그룹 소스가 바뀌면 모두 어긋남, 없는 screen 은 미확인)", () => {
    const { repo, c1 } = setup();
    const m = fig.parseManifest({
      screens: { orders: ["app/orders.tsx", "lib/labels.ts"] },
      figures: [
        { id: "a", file: "docs/img/orders.png", screen: "orders", capturedCommit: c1 },
        { id: "b", file: "docs/img/detail.png", screen: "orders", sources: ["app/detail.tsx"], capturedCommit: c1 },
        { id: "c", file: "docs/img/orders.png2", screen: "nope", sources: ["app/detail.tsx"], capturedCommit: c1 },
      ],
    });
    expect(m.figures[1].sources).toEqual(["app/detail.tsx", "app/orders.tsx", "lib/labels.ts"]);
    expect(m.figures[2].badScreen).toBe(true);
    put(repo, "docs/img/orders.png2", "png");
    commitAll(repo, "add img");
    expect(fig.checkFigures({ manifest: m, repo }).ok).toBe(2);
    put(repo, "app/orders.tsx", "v2");
    commitAll(repo, "orders changed");
    const r = fig.checkFigures({ manifest: m, repo });
    expect(r.stale.map((s) => s.id)).toEqual(["a", "b"]);
    expect(r.unknown.map((u) => `${u.id}:${u.why}`)).toEqual(["c:screen 정의 없음: nope"]);
    expect(() => fig.parseManifest({ screens: { x: "app" }, figures: [] })).toThrow(/screens\.x/);
  });
  it("--init: 문서의 그림 참조에서 뼈대를 만들고(id·커밋·장), 기존 항목은 보존하며 다시 돌려도 중복이 없다", () => {
    const { repo, c1 } = setup();
    put(repo, "docs/guide.md", ["# 1장 주문", "![목록](img/orders.png)", "## 2장 상세", "![상세](img/detail.png)", "![같은 이름](other/detail.png)", "![없는 그림](img/none.png)", "![외부](https://example.test/x.png)"].join("\n"));
    put(repo, "docs/other/detail.png", "png");
    const c2 = commitAll(repo, "guide");
    const mf = path.join(repo, "figures.json");
    // 기존 매니페스트: 한 항목은 사람이 채운 값, screens·globalWatch 도 있다
    writeFileSync(mf, JSON.stringify({ globalWatch: ["lib/labels.ts"], screens: { s: ["app/orders.tsx"] }, figures: [{ id: "orders", file: "docs/img/orders.png", screen: "s", capturedCommit: c1, note: "손으로 쓴 메모" }] }), "utf8");
    const out: string[] = [];
    const args = ["--init", "--manifest", mf, "--repo", repo, "--docs", "docs/guide.md"];
    expect(fig.run(args, { out: (s) => out.push(s) })).toBe(0);
    expect(out[1]).toContain("새로 추가 3건, 기존 보존 1건");
    const saved = JSON.parse(readFileSync(mf, "utf8"));
    expect(saved.globalWatch).toEqual(["lib/labels.ts"]);
    expect(saved.screens).toEqual({ s: ["app/orders.tsx"] });
    expect(saved.figures[0]).toEqual({ id: "orders", file: "docs/img/orders.png", screen: "s", capturedCommit: c1, note: "손으로 쓴 메모" });
    const added = saved.figures.slice(1);
    expect(added.map((f: { id: string }) => f.id)).toEqual(["detail", "detail-2", "none"]);
    expect(added[0]).toMatchObject({ file: "docs/img/detail.png", capturedCommit: c1, note: "2장 상세", sources: [], route: "", screen: "" });
    expect(added[1]).toMatchObject({ file: "docs/other/detail.png", capturedCommit: c2 });
    expect(added[2]).toMatchObject({ file: "docs/img/none.png", capturedCommit: "" });
    // 다시 돌려도 같은 결과(중복 없음)
    const again: string[] = [];
    fig.run(args, { out: (s) => again.push(s) });
    expect(again[1]).toContain("새로 추가 0건, 기존 보존 4건");
    // 매니페스트가 없으면 새로 만든다(객체 형식), --docs 없이는 사용법 오류
    const fresh = path.join(repo, "fresh.json");
    expect(fig.run(["--init", "--manifest", fresh, "--repo", repo, "--docs", "docs/guide.md"], { out: () => undefined })).toBe(0);
    expect(JSON.parse(readFileSync(fresh, "utf8")).figures.length).toBe(4);
    expect(fig.run(["--init", "--manifest", fresh, "--repo", repo], { err: () => undefined })).toBe(2);
  });
  it("매니페스트 검증: id·file 필수, 중복 거부, 배열 또는 figures 객체", () => {
    expect(() => fig.parseManifest({})).toThrow(/배열/);
    expect(() => fig.parseManifest([{ id: "a" }])).toThrow(/id·file/);
    expect(() => fig.parseManifest([{ id: "a", file: "x.png" }, { id: "a", file: "y.png" }])).toThrow(/id 중복/);
    expect(() => fig.parseManifest([{ id: "a", file: "x.png" }, { id: "b", file: "./x.png" }])).toThrow(/경로 중복/);
    expect(fig.parseManifest([{ id: "a", file: "x.png" }]).figures.length).toBe(1);
  });
  it("CLI: 목록이 있으면 1, --exit-zero 면 0, images-stale 는 이름 한 행씩(기본 이름만·--stale-paths 는 경로), git 이 아니면 2", () => {
    const { repo, c1 } = setup();
    put(repo, "app/orders.tsx", "v2");
    commitAll(repo, "change");
    const mf = path.join(repo, "manifest.json");
    writeFileSync(mf, JSON.stringify([entry("o", "docs/img/orders.png", ["app/orders.tsx"], c1), entry("x", "docs/img/없음.png", ["app/detail.tsx"], c1)]), "utf8");
    const exec = (argv: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      return { code: fig.run(argv, { out: (s) => out.push(s), err: (s) => err.push(s) }), out, err };
    };
    const outFile = path.join(repo, "images-stale.txt");
    expect(exec(["--manifest", mf, "--repo", repo, "--images-stale", outFile]).code).toBe(1);
    expect(readFileSync(outFile, "utf8")).toBe("orders.png\n없음.png\n");
    exec(["--manifest", mf, "--repo", repo, "--images-stale", outFile, "--stale-paths"]);
    expect(readFileSync(outFile, "utf8")).toBe("docs/img/orders.png\ndocs/img/없음.png\n");
    expect(exec(["--manifest", mf, "--repo", repo, "--exit-zero"]).code).toBe(0);
    expect(exec(["--manifest", mf, "--repo", tmp()]).code).toBe(2);
    expect(exec(["--manifest", mf]).code).toBe(2);
    expect(exec(["--manifest", mf, "--repo", repo, "--unregistered"]).code).toBe(2);
  });
  it("모두 정상이면 건수만 한 줄 출력하고 0", () => {
    const { repo, c1 } = setup();
    const mf = path.join(repo, "manifest.json");
    writeFileSync(mf, JSON.stringify([entry("o", "docs/img/orders.png", ["app/orders.tsx"], c1)]), "utf8");
    const out: string[] = [];
    expect(fig.run(["--manifest", mf, "--repo", repo], { out: (s) => out.push(s) })).toBe(0);
    expect(out.length).toBe(2);
    expect(out[0]).toMatch(/^figure-stale v\S+ · 설정 sha256:[0-9a-f]{8}$/);
    expect(out[1]).toBe("figure-stale: 전체 1건 중 정상 1건, 어긋남 후보 0건, 미확인 0건, 누락 0건");
  });
});
