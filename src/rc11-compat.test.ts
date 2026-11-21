import { describe, expect, it } from "vitest";
import * as aiKey from "./ai-shared-key/index";
import * as payments from "./payments/index";
import * as fcm from "./push/fcm";

// rc.9 → rc.11 호출 앱(미트·이음) 호환: 앱이 쓰는 공개 이름이 그대로 있고, 새 옵션을 안 주면 기본 동작이 같다.
describe("rc.11 호환(추가형)", () => {
  it("payments 공개 함수가 그대로 있다", () => {
    for (const n of ["confirmPayment", "cancelPayment", "getPayment", "getPaymentByOrderId", "createTossClient", "cancelApprovedMismatch", "checkPartialCancel", "cancelIdempotencyKey", "confirmIdempotencyKey"]) {
      expect(typeof (payments as Record<string, unknown>)[n], n).toBe("function");
    }
  });

  it("push/fcm 공개 이름이 그대로 있고 새 상수가 추가됐다", () => {
    for (const n of ["loadFcm", "isFcmConfigured", "isFcmEndpoint", "signServiceJwt", "sendFcm", "resetFcmTokenCache"]) {
      expect(typeof (fcm as Record<string, unknown>)[n], n).toBe("function");
    }

    expect(fcm.FCM_TIMEOUT_MS).toBe(8_000);
  });

  it("ai-shared-key 공개 이름이 그대로 있다", () => {
    for (const n of ["createAiSharedKey", "withPlatformAiKey", "reservePlatformAiUsage", "recordPlatformAiUsage", "markPlatformKeyInvalid", "sealPlatformAiKey", "validateAiKeyShape", "keyHint", "anthropicVerifier"]) {
      expect(typeof (aiKey as Record<string, unknown>)[n], n).toBe("function");
    }

    expect(aiKey.AI_HOOK_TIMEOUT_MS).toBe(2_000);
  });
});
