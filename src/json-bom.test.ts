import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// 재발 방지(rc.15): package.json 등 JSON 파일이 UTF-8 BOM(EF BB BF)으로 시작하면 쓰는 앱의 번들러가
// JSON 으로 읽지 못해 빌드가 깨진다(rc.13·rc.14 에서 발생). 저장소의 JSON 파일은 BOM 없이 바로 파싱돼야 한다.
const ROOT = join(__dirname, "..");
const SKIP = new Set(["node_modules", ".git", ".claude"]);

function jsonFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) jsonFiles(p, out);
    else if (name.endsWith(".json")) out.push(p);
  }
  return out;
}

describe("JSON 파일 BOM 검사", () => {
  const files = jsonFiles(ROOT);

  it("package.json 이 목록에 있다", () => {
    expect(files.map((f) => relative(ROOT, f))).toContain("package.json");
  });

  it.each(files.map((f) => [relative(ROOT, f), f]))("%s 는 BOM 없이 시작하고 그대로 JSON 으로 읽힌다", (_name, file) => {
    const buf = readFileSync(file);
    expect([...buf.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(() => JSON.parse(buf.toString("utf8"))).not.toThrow();
  });
});
