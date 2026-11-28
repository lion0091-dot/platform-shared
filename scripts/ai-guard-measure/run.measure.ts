/**
 * ai-guard 누락률·오탐률 측정 실행 파일. 평소 시험(npm test)에는 들어가지 않는다.
 *   npx vitest run --config scripts/ai-guard-measure/vitest.measure.config.ts
 * 결과: scripts/ai-guard-measure/result-shared.md (다시 돌리면 덮어씀). 외부 호출 없음.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { guard } from "../../src/ai-guard";
import { normalizeText } from "../../src/ai-guard/normalize";
import type { GuardLevel, GuardPolicy } from "../../src/ai-guard";
import { makeDataset } from "./dataset";
import { evaluate, renderMarkdown, type Adapter } from "./evaluate";

const policy = (level: GuardLevel): GuardPolicy => ({
  policyId: `measure.${level.toLowerCase()}`,
  level,
  kinds: { PLATE: "MASK" }, // 기본 OFF 인 차량번호도 재려고 켠다. 나머지는 기본값.
  restoreKinds: [],
  maxCharsPerField: 2000,
  maxCharsTotal: 2000,
  maxReplacements: 200,
});

const sharedAdapter = (level: GuardLevel): Adapter => {
  const p = policy(level);
  return {
    name: `shared ai-guard (${level})`,
    normalize: normalizeText,
    run: (raw) => {
      const r = guard(raw, p);
      return r.ok ? { ok: true, output: r.payload.value as string } : { ok: false, reason: r.reason };
    },
  };
};

it("ai-guard 누락률·오탐률 측정", async () => {
  const data = makeDataset();
  expect(data.length).toBeGreaterThanOrEqual(300);
  const parts: string[] = [];
  parts.push(`예문 ${data.length}건 (시드 20261128, 개인정보 칸 ${data.flatMap((s) => s.segs).filter((x) => typeof x !== "string" && "pii" in x).length}개, 미끼 칸 ${data.flatMap((s) => s.segs).filter((x) => typeof x !== "string" && "decoy" in x).length}개)`, "");
  for (const level of ["STANDARD", "STRICT"] as const) {
    const ev = evaluate(sharedAdapter(level), data);
    parts.push(renderMarkdown(ev, ev.adapter));
    writeFileSync(join(__dirname, `detail-shared-${level.toLowerCase()}.json`), JSON.stringify({ pii: ev.pii.filter((r) => r.status === "누락" || r.status === "부분"), fp: ev.decoys.filter((d) => d.fp) }, null, 1));
  }
  writeFileSync(join(__dirname, "result-shared.md"), parts.join("\n"));
}, 120_000);
