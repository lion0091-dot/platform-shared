import { configDefaults, defineConfig } from "vitest/config";

// 실제 토스 테스트 환경을 부르는 통합 시험은 평소 시험(npm test)에서 뺀다. 별도 설정(vitest.toss.config.ts)으로만 돈다.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, "src/payments/toss.integration.test.ts"] },
});
