/** 정적 검사: 클라이언트 서브패스가 서버 전용 코드를 끌어오지 않고, 비밀·로그·기본 키 이름이 코드에 없음을 확인한다. */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = __dirname;
const src = (f: string) => readFileSync(join(DIR, f), "utf8");
const prod = readdirSync(DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

describe("ai-shared-key 정적 검사", () => {
  it("types·contract 는 서버 전용 모듈(secrets·node:crypto)을 import 하지 않는다(클라이언트 번들 안전)", () => {
    for (const f of ["types.ts", "contract.ts"]) {
      expect(src(f)).not.toMatch(/from\s+["'](?:node:|\.\.\/secrets|\.\/index)/);
    }
  });
  it("제품 코드에 console 출력이 없다(키·암호문이 로그로 새지 않게)", () => {
    for (const f of prod) expect(src(f)).not.toMatch(/\bconsole\./);
  });
  it("마스터 키 환경변수의 기본 이름을 두지 않는다(앱이 이름을 정한다)", () => {
    for (const f of prod) expect(src(f)).not.toMatch(/TENANT_SECRET_KEY|process\.env\.[A-Z_]*(?:MASTER|AI_KEY)/);
  });
  it("실제 키 모양 문자열(sk-…)을 코드·시험에 넣지 않았다", () => {
    for (const f of readdirSync(DIR).filter((x) => x.endsWith(".ts"))) expect(src(f)).not.toMatch(/sk-(?:ant-)?[A-Za-z0-9_-]{20,}/);
  });
});
