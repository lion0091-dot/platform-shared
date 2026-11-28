import { defineConfig } from "vitest/config";

// ai-guard 누락률 측정 전용(평소 npm test 에 넣지 않는다).
export default defineConfig({
  test: { include: ["scripts/ai-guard-measure/run.measure.ts"] },
});
