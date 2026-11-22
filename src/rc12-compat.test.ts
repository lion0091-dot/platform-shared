import { describe, expect, it } from "vitest";
import * as aiGuard from "./ai-guard/index";
import * as payments from "./payments/index";
import * as push from "./push/fcm";
import * as withholding from "./withholding/index";

// rc.11 → rc.12 호출 앱 호환: 신규 서브패스는 추가형이고, 기존 공개 이름은 그대로 있다.
describe("rc.12 호환(추가형)", () => {
  it("withholding 서브패스의 공개 이름이 있다", () => {
    for (const n of ["computePersonalWithholding", "judgeWithholdingTarget", "isValidBusinessNumber"]) {
      expect(typeof (withholding as Record<string, unknown>)[n], n).toBe("function");
    }
    expect(withholding.WITHHOLDING_TOTAL_PER_1000).toBe(33);
    expect(withholding.WITHHOLDING_INCOME_PER_1000).toBe(30);
  });

  it("rc.11 의 기존 공개 이름이 그대로 있다(payments·push/fcm·ai-guard)", () => {
    expect(typeof payments.confirmPayment).toBe("function");
    expect(typeof payments.cancelPayment).toBe("function");
    expect(typeof push.sendFcm).toBe("function");
    expect(Object.keys(aiGuard).length).toBeGreaterThan(0);
  });
});
