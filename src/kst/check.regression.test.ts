import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { checkSource, parseConfig, run } from "./check.mjs";

// 코드 리뷰(독립 리뷰어)에서 나온 결함의 회귀 시험. 입력은 모두 합성값이고 현재 시각·시간대에 의존하지 않는다.

const CHECK_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "check.mjs");
const PATHOLOGICAL_MS = 500; // 실측(이 PC) 최대 약 25ms 의 20배

const ids = (file: string, text: string, entries = parseConfig({}).entries) => checkSource({ file, text, entries }).findings.map((f) => f.rule);
const sev = (file: string, text: string, rule: string) => checkSource({ file, text }).findings.find((f) => f.rule === rule)?.severity;

const tmpRoots: string[] = [];
function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), "kst-regress-"));
  tmpRoots.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});
function put(root: string, rel: string, text: string): void {
  const p = path.join(root, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, text, "utf8");
}
function exec(argv: string[], today = "2026-11-12") {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { out: (s) => out.push(s), err: (s) => err.push(s), today });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
const hasGit = spawnSync("git", ["--version"]).status === 0;
function gitIn(root: string, ...args: string[]) {
  const r = spawnSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "core.autocrlf=false", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}
function repo(files: Record<string, string>): string {
  const root = tmp();
  gitIn(root, "init", "-q");
  for (const [rel, text] of Object.entries(files)) put(root, rel, text);
  gitIn(root, "add", ".");
  gitIn(root, "commit", "-q", "-m", "base");
  return root;
}
const changed = (root: string) => exec(["--changed-since", "HEAD", "--root", root]);

describe("CLI 프로세스", () => {
  const spawnCheck = (script: string, args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

  it("실제 프로세스로 실행하면 위반이 있을 때 1", () => {
    const root = tmp();
    put(root, "src/a.ts", "const y = d.getFullYear();\n");
    const r = spawnCheck(CHECK_PATH, ["--all", "--root", root, "src"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("src/a.ts:1:");
  });

  it("링크(정션·심볼릭) 경로로 실행해도 검사한다(검사 없이 0 으로 끝나지 않는다)", () => {
    const real = tmp();
    copyFileSync(CHECK_PATH, path.join(real, "check.mjs"));
    const link = path.join(tmp(), "link");
    try {
      symlinkSync(real, link, "junction");
    } catch {
      return; // 이 환경에서 링크를 만들 수 없으면 건너뜀
    }
    const root = tmp();
    put(root, "src/a.ts", "const y = d.getFullYear();\n");
    const r = spawnCheck(path.join(link, "check.mjs"), ["--all", "--root", root, "src"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("src/a.ts:1:");
  });

  it("--help 는 0", () => {
    const r = spawnCheck(CHECK_PATH, ["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("서울 날짜");
  });
});

describe("kst-ok 주석 — 사유와 범위", () => {
  it("주석 뒤에 코드가 있으면 그 코드는 사유가 아니다", () => {
    const r = ids("m.sql", "/* kst-ok: sql-current-date */ select current_date;");
    expect(r).toContain("kst-ok-no-reason");
    expect(r).toContain("sql-current-date");
  });

  it("코드가 있는 줄의 블록 주석은 다음 줄에 적용되지 않는다", () => {
    expect(ids("m.sql", "/* kst-ok: sql-current-date 사유 */ select 1;\nselect current_date;")).toContain("sql-current-date");
  });

  it("JSX 식 주석 {/* … */} 의 닫는 표시는 사유가 아니다", () => {
    const r = ids("a.tsx", "const v = <span>{d.toLocaleDateString()}</span>; {/* kst-ok: ts-locale-no-tz */}");
    expect(r).toContain("kst-ok-no-reason");
    expect(r).toContain("ts-locale-no-tz");
  });

  it("글자·숫자가 아닌 한 글자 사유는 인정하지 않는다", () => {
    expect(ids("a.ts", "const y = d.getFullYear(); // kst-ok: ts-local-getters .")).toContain("kst-ok-no-reason");
  });

  it("문자열 안의 kst-ok 는 주석이 아니다", () => {
    expect(ids("a.ts", 'const d = x.getDate(); const s = "// kst-ok: ts-local-getters 사유";')).toContain("ts-local-getters");
    expect(ids("m.sql", "select '-- kst-ok: sql-current-date 사유', current_date;")).toContain("sql-current-date");
  });

  it("# 는 주석 표시가 아니다", () => {
    expect(ids("a.ts", 'const y = d.getFullYear(); const s = "# kst-ok: ts-local-getters 사유";')).toContain("ts-local-getters");
  });

  it("쉼표 뒤 공백이 있어도 둘 다 적용된다", () => {
    expect(ids("a.ts", "const d = x.getDate() + y.toISOString().slice(0, 10); // kst-ok: ts-local-getters, ts-iso-slice 사유")).toEqual([]);
  });

  it("지시 한 줄은 바로 다음 한 줄에만 적용된다", () => {
    expect(ids("a.ts", "// kst-ok: ts-local-getters 사유\nconst a = d.getDate();\nconst b = d.getDate();")).toEqual(["ts-local-getters"]);
  });
});

describe("서울이 아닌 시간대는 변환이 아니다", () => {
  it("SQL: UTC·뉴욕·소문자 utc 는 잡고, 서울·변수 시간대는 통과", () => {
    expect(ids("m.sql", "select date_trunc('day', created_at at time zone 'UTC') from t;")).toContain("sql-date-trunc");
    expect(ids("m.sql", "select extract(hour from created_at at time zone 'America/New_York') from t;")).toContain("sql-extract");
    expect(ids("m.sql", "select (created_at at time zone 'utc')::date from t;")).toContain("sql-ts-cast-date");
    expect(ids("m.sql", "select date_trunc('day', created_at at time zone 'Asia/Seoul') from t;")).toEqual([]);
    expect(ids("m.sql", "select date_trunc('day', created_at at time zone p_tz) from t;")).toEqual([]);
  });

  it("TS: timeZone 이 UTC 이면 잡고, timeZoneName 은 시간대 지정이 아니다", () => {
    expect(ids("a.ts", 'd.toLocaleDateString("ko-KR", { timeZone: "UTC" })')).toContain("ts-locale-no-tz");
    expect(ids("a.ts", 'd.toLocaleDateString("ko-KR", { year: "numeric", timeZoneName: "short" })')).toContain("ts-locale-no-tz");
    expect(ids("a.ts", 'd.toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" })')).toEqual([]);
  });

  it("Date 의 toLocaleString 은 warn 이상으로 본다", () => {
    expect(sev("a.ts", "new Date().toLocaleString();", "ts-locale-no-tz")).toBe("warn");
    expect(sev("a.ts", 'new Date(order.created_at).toLocaleString("ko-KR");', "ts-locale-no-tz")).toBe("warn");
  });
});

describe("어휘 분석 — 정규식·템플릿·이스케이프", () => {
  it("정규식 리터럴 안의 /* 를 주석으로 보지 않는다", () => {
    expect(ids("a.ts", "const re = /[/*]/;\nconst y = d.getFullYear();\nconst z = x.toISOString().slice(0, 10);").sort()).toEqual(["ts-iso-slice", "ts-local-getters"]);
  });

  it("템플릿 리터럴의 ${} 안 호출은 error 로 잡힌다(warn 으로 내려가지 않는다)", () => {
    const r = checkSource({ file: "a.ts", text: 'const s = `${d.toLocaleDateString("ko-KR")} 기준`;' }).findings;
    expect(r.map((f) => [f.rule, f.severity])).toEqual([["ts-locale-no-tz", "error"]]);
  });

  it("이스케이프된 백틱·따옴표 뒤에서도 이후 검사가 유지된다", () => {
    const t1 = 'const m = `a\\`b`;\nconst s = d.toLocaleDateString("ko-KR");';
    expect(checkSource({ file: "a.ts", text: t1 }).findings.map((f) => f.severity)).toEqual(["error"]);
    const t2 = "const m = 'it\\'s'; const s = d.toLocaleDateString(\"ko-KR\");";
    expect(checkSource({ file: "a.ts", text: t2 }).findings.map((f) => f.severity)).toEqual(["error"]);
  });

  it("정규식 안의 백틱 뒤에서도 주석을 주석으로 본다", () => {
    const r = checkSource({ file: "a.ts", text: 'x.replace(/`/g, "");\n// d.getDate() 는 쓰지 않는다\nconst a = 1;' });
    expect(r.findings).toEqual([]);
  });

  it("SQL: E'' 이스케이프 뒤에서도 주석 처리와 괄호 짝이 유지된다", () => {
    const r = checkSource({ file: "m.sql", text: "select E'\\'', extract(hour from created_at) from t; -- current_date 주석" });
    expect(r.findings.map((f) => [f.rule, f.severity])).toEqual([["sql-extract", "error"]]);
  });
});

describe("변경분 모드 — 여러 줄·삭제·이름 변경", () => {
  it.skipIf(!hasGit)("여러 줄 호출에서 timeZone 줄만 지워도 잡는다", () => {
    const root = repo({ "fmt.ts": 'const s = d.toLocaleDateString("ko-KR", {\n  year: "numeric",\n  timeZone: "Asia/Seoul",\n});\n' });
    put(root, "fmt.ts", 'const s = d.toLocaleDateString("ko-KR", {\n  year: "numeric",\n});\n');
    const r = changed(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain("fmt.ts:1:");
  });

  it.skipIf(!hasGit)("위반이 시작하는 줄이 아닌 둘째 줄을 고쳐도 잡는다", () => {
    const root = repo({ "iso.ts": "const a = x.toISOString()\n  .toUpperCase();\n" });
    put(root, "iso.ts", "const a = x.toISOString()\n  .slice(0, 10);\n");
    expect(changed(root).out).toContain("iso.ts:1:");
  });

  it.skipIf(!hasGit)("date_trunc 안에서 서울 변환을 지워도 잡는다", () => {
    const root = repo({ "q.sql": "select date_trunc(\n  'month',\n  created_at at time zone 'Asia/Seoul'\n) from t;\n" });
    put(root, "q.sql", "select date_trunc(\n  'month',\n  created_at\n) from t;\n");
    expect(changed(root).out).toContain("q.sql:1:");
  });

  it.skipIf(!hasGit)("윗줄의 kst-ok 주석만 지워도 잡는다", () => {
    const root = repo({ "ok.sql": "-- kst-ok: sql-current-date 로그 시각만\nselect current_date;\n" });
    put(root, "ok.sql", "select current_date;\n");
    expect(changed(root).out).toContain("ok.sql:1:");
  });

  it.skipIf(!hasGit)("이름만 바꾼 파일의 기존 위반은 보고하지 않고, 같이 고친 줄만 보고한다", () => {
    const body = Array.from({ length: 12 }, (_, i) => `select ${i};`).join("\n");
    const root = repo({ "legacy.sql": `select current_date;\n${body}\n` });
    gitIn(root, "mv", "legacy.sql", "renamed.sql");
    expect(changed(root).out).not.toContain("renamed.sql");
    put(root, "renamed.sql", `select current_date;\n${body}\nselect localtimestamp;\n`);
    const r = changed(root);
    expect(r.out).toContain("renamed.sql:14:");
    expect(r.out).not.toContain("renamed.sql:1:");
  });

  it.skipIf(!hasGit)("공백·한글이 들어간 폴더", () => {
    const root = repo({ "한글 폴더/기준.sql": "select 1;\n" });
    put(root, "한글 폴더/기준.sql", "select 1;\nselect current_date;\n");
    expect(changed(root).out).toContain("한글 폴더/기준.sql:2:");
  });

  it.skipIf(!hasGit)("옵션처럼 보이는 기준 이름은 거부(2)", () => {
    const root = repo({ "a.ts": "const a = 1;\n" });
    expect(exec(["--changed-since=--octopus", "--root", root]).code).toBe(2);
  });
});

describe("CLI — 경로·설정 검증", () => {
  it("없는 경로·없는 루트는 2", () => {
    const root = tmp();
    put(root, "src/a.ts", "d.getDate();\n");
    expect(exec(["--all", "--root", root, "srcc"]).code).toBe(2);
    expect(exec(["--all", "--root", path.join(root, "nope")]).code).toBe(2);
  });

  it("절대 경로 인자는 --root 기준으로 풀고, 밖이면 2", () => {
    const root = tmp();
    put(root, "src/a.ts", "d.getDate();\n");
    expect(exec(["--all", "--root", root, path.join(root, "src")]).code).toBe(1);
    expect(exec(["--all", "--root", root, path.dirname(root)]).code).toBe(2);
  });

  it("직접 지정한 build 같은 기본 제외 폴더는 검사한다", () => {
    const root = tmp();
    put(root, "build/a.ts", "d.getDate();\n");
    expect(exec(["--all", "--root", root]).out).toContain("파일 0개 검사");
    expect(exec(["--all", "--root", root, "build"]).code).toBe(1);
  });

  it("--all 과 --changed-since 를 같이 쓰면 2", () => {
    const root = tmp();
    expect(exec(["--all", "--changed-since", "HEAD", "--root", root]).code).toBe(2);
  });

  it("UTF-16 파일은 검사한 척하지 않고 건너뜀 경고", () => {
    const root = tmp();
    writeFileSync(path.join(root, "m.sql"), Buffer.from("﻿select current_date;", "utf16le"));
    const r = exec(["--all", "--root", root]);
    expect(r.out).toContain("kst-file-skipped");
    expect(r.out).toContain("파일 0개 검사");
  });

  it("설정의 모르는 키·잘못된 모양은 2(오타로 규칙이 꺼지지 않게)", () => {
    const bad: unknown[] = [{ allows: [] }, { allow: {} }, { exclude: "gen/**" }, [], null, { exclude: [1] }];
    for (const cfg of bad) {
      const root = tmp();
      put(root, "m.sql", "select 1;\n");
      put(root, ".kst-check.json", JSON.stringify(cfg));
      expect(exec(["--all", "--root", root]).code, JSON.stringify(cfg)).toBe(2);
    }
  });
});

describe("허용 목록 범위", () => {
  const mk = (file: string) => parseConfig({ allow: [{ file, rule: "sql-current-date", match: "select current_date;", reason: "로그용" }] }).entries;

  it("폴더 이름만으로는 그 아래 파일에 적용되지 않고, * 도 하위 폴더에 적용되지 않는다", () => {
    expect(ids("x/y/a.sql", "select current_date;", mk("x"))).toEqual(["sql-current-date"]);
    expect(ids("x/y/a.sql", "select current_date;", mk("*"))).toEqual(["sql-current-date"]);
    expect(ids("a.sql", "select current_date;", mk("*"))).toEqual([]);
  });
});

describe("성능 — 이차 시간 정규식 회귀", () => {
  const SHAPES: Array<[string, string, string]> = [
    ["p_a 뒤 공백 반복", "m.sql", `select p_a${" ".repeat(40000)}x;`],
    ["p_a 뒤 빈 줄 반복", "m.sql", `p_a${"\n".repeat(40000)}`],
    ["a. 반복", "m.sql", "a.".repeat(40000)],
    ["new Date( 뒤 공백 반복", "a.ts", `new Date(${" ".repeat(40000)}`],
    ["a$ 반복", "a.ts", "a$".repeat(40000)],
    ["::timestamptz 반복", "m.sql", "p_a::date + 1 )::timestamptz ".repeat(8000)],
    ["::date 반복", "m.sql", "created_at::date ".repeat(8000)],
    ["toLocaleString 반복", "a.ts", 'created.toLocaleString({ year: "x" }) '.repeat(8000)],
    ["백틱·${ 반복", "a.ts", "`${".repeat(20000)],
    ["정규식 시작 반복", "a.ts", "= /[".repeat(20000)],
  ];
  for (const [name, file, text] of SHAPES) {
    it(`${name} (${Math.round(text.length / 1000)}K자)`, () => {
      const t0 = performance.now();
      checkSource({ file, text });
      expect(performance.now() - t0).toBeLessThan(PATHOLOGICAL_MS);
    });
  }
});
