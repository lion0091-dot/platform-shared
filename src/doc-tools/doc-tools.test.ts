import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
  it("표지가 없는 문서·비교 대상이 1개뿐인 경우도 위반으로 알린다", () => {
    const root = tmp();
    put(root, "docs/a.md", block(["가"]));
    put(root, "docs/b.md", "표지 없음");
    const r = run(root, group());
    expect(r.violations.map((v) => `${v.file}:${v.excerpt}`)).toContain("docs/b.md:시작·끝 표지를 찾지 못했다");
    const solo = tmp();
    put(solo, "docs/a.md", block(["가"]));
    expect(run(solo, group()).violations[0].excerpt).toContain("2개 이상");
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
    expect(bad.out[0]).toBe("docs/a.md:2:noun-jul:세 줄 남음");
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
    expect(() => lint.parseConfig({ include: ["a"], rules: { sameBlock: { groups: [{ files: ["a"], start: "s" }] } } })).toThrow(/end/);
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
    expect(out).toEqual(["figure-stale: 전체 1건 중 정상 1건, 어긋남 후보 0건, 미확인 0건, 누락 0건"]);
  });
});
