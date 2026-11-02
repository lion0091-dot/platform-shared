import { defineConfig } from "vitest/config";

// npm run test:toss 전용. TOSS_INTEGRATION=1 은 시험 파일이 "일부러 실행했다"를 알아보는 표시다.
export default defineConfig({
  test: { include: ["src/payments/toss.integration.test.ts"], env: { TOSS_INTEGRATION: "1" } },
});
