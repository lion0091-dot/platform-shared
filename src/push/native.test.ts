import { describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => false } }));
vi.mock("@capacitor/push-notifications", () => ({ PushNotifications: {} }));

import { createNativePush } from "./native";

const channel = { name: "새 알림", description: "시험" };

describe("safeAppUrl (알림을 눌렀을 때 열 주소)", () => {
  it("설정한 경로만 허용한다", () => {
    const dash = createNativePush({ tapPath: /^\/dashboard(\/[A-Za-z0-9\-_/]*)?$/, channel });

    expect(dash.safeAppUrl("/dashboard/orders")).toBe("/dashboard/orders");
    expect(dash.safeAppUrl("/dashboard")).toBe("/dashboard");
    expect(dash.safeAppUrl("/driver/orders/1")).toBeNull();

    const driver = createNativePush({ tapPath: /^\/driver\/[A-Za-z0-9\-_/]*$/, channel });

    expect(driver.safeAppUrl("/driver/orders/0b9f2c1e")).toBe("/driver/orders/0b9f2c1e");
    expect(driver.safeAppUrl("/dashboard/orders")).toBeNull();
  });

  it("외부 주소·이상한 값은 어떤 설정에서도 거부한다", () => {
    const dash = createNativePush({ tapPath: /^\/dashboard(\/[A-Za-z0-9\-_/]*)?$/, channel });

    for (const bad of ["https://evil.example.com", "//evil.example.com", "/admin", "/dashboardx", "/dashboard//evil.com", "/dashboard/../admin", "/dashboard/a?x=1", "javascript:alert(1)", "", null, undefined, 5]) {
      expect(dash.safeAppUrl(bad), String(bad)).toBeNull();
    }
  });

  it("앱 밖(일반 브라우저)에서는 네이티브가 아니다", () => {
    expect(createNativePush({ tapPath: /^\/x$/, channel }).isNativeApp()).toBe(false);
  });
});
