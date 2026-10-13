/**
 * 앱(안드로이드, Capacitor) 푸시 등록 — 브라우저(클라이언트) 전용. 앱이 아닌 일반 브라우저에서는 쓰지 않는다.
 * 앱의 화면은 서버에서 불러오지만 푸시 플러그인은 앱 안에 들어 있어, 이 코드가 플러그인을 불러 FCM 토큰을 받고 서버에 저장한다.
 * 앱마다 다른 부분(알림을 눌렀을 때 열 수 있는 경로, 알림 채널 이름)은 createNativePush 의 설정으로 받는다. wholesale·shipping-prj 공용.
 */
import { Capacitor } from "@capacitor/core";
import { PushNotifications } from "@capacitor/push-notifications";

export interface NativePushConfig {
  /** 알림을 눌러 열 수 있는 앱 안 경로(전체 일치). 알림 데이터로 외부 주소를 열지 못하게 한다. */
  tapPath: RegExp;
  /** 안드로이드 알림 채널(소리·중요도). id 는 서버(fcm.ts)가 보내는 channel_id 와 같아야 한다("orders"). */
  channel: { name: string; description: string };
  /** 토큰을 기억해 두는 localStorage 키(기본 "fcm-token"). */
  tokenKey?: string;
}

export type NativeEnable = { ok: true; token: string } | { ok: false; reason: "denied" | "error" };

export function createNativePush(config: NativePushConfig) {
  const TOKEN_KEY = config.tokenKey ?? "fcm-token";

  const isNativeApp = (): boolean => {
    try {
      return Capacitor.isNativePlatform();
    } catch {
      return false;
    }
  };

  /** 알림을 눌러 열 주소는 설정한 경로만 허용한다. */
  function safeAppUrl(url: unknown): string | null {
    return typeof url === "string" && config.tapPath.test(url) && !url.includes("//") ? url : null;
  }

  const savedToken = (): string | null => {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  };

  const remember = (token: string | null) => {
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      // 저장소를 못 써도 푸시 자체는 동작한다
    }
  };

  let listening = false;

  /** 알림을 눌렀을 때 해당 화면으로 이동하는 리스너(한 번만 등록). */
  async function listenForTaps(): Promise<void> {
    if (listening) return;

    listening = true;
    await PushNotifications.addListener("pushNotificationActionPerformed", (e) => {
      const url = safeAppUrl(e.notification?.data?.url);

      if (url) window.location.assign(url);
    });
  }

  /** 권한을 받고 FCM 토큰을 등록한다. 토큰이 나오면 save 로 서버에 저장하고 기억해 둔다. */
  async function enableNativePush(save: (token: string) => Promise<boolean>): Promise<NativeEnable> {
    try {
      let perm = await PushNotifications.checkPermissions();

      if (perm.receive === "prompt" || perm.receive === "prompt-with-rationale") perm = await PushNotifications.requestPermissions();

      if (perm.receive !== "granted") return { ok: false, reason: "denied" };

      await PushNotifications.createChannel({ id: "orders", name: config.channel.name, description: config.channel.description, importance: 5, visibility: 1 });
      await listenForTaps();

      const handles: Array<{ remove: () => Promise<void> }> = [];
      const token = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout")), 15_000);

        void PushNotifications.addListener("registration", (t) => {
          clearTimeout(timer);
          resolve(t.value);
        }).then((h) => handles.push(h));
        void PushNotifications.addListener("registrationError", (e) => {
          clearTimeout(timer);
          reject(new Error(e.error));
        }).then((h) => handles.push(h));
        void PushNotifications.register();
      }).finally(() => {
        // 등록용 리스너만 정리한다(알림을 눌렀을 때 쓰는 리스너는 남겨 둔다)
        for (const h of handles) void h.remove();
      });

      if (!(await save(token))) return { ok: false, reason: "error" };

      remember(token);

      return { ok: true, token };
    } catch {
      return { ok: false, reason: "error" };
    }
  }

  /** 알림 끄기: 서버에서 토큰을 지우고 앱의 등록을 해제한다. */
  async function disableNativePush(remove: (token: string) => Promise<boolean>): Promise<boolean> {
    const token = savedToken();

    if (token && !(await remove(token))) return false;

    remember(null);
    await PushNotifications.unregister().catch(() => undefined);

    return true;
  }

  /** 이미 허용돼 있고 토큰을 저장해 둔 상태인지(켜짐 표시용). */
  async function nativePushState(): Promise<"on" | "off" | "denied"> {
    const perm = await PushNotifications.checkPermissions();

    if (perm.receive === "denied") return "denied";

    return perm.receive === "granted" && savedToken() ? "on" : "off";
  }

  return { isNativeApp, safeAppUrl, savedToken, listenForTaps, enableNativePush, disableNativePush, nativePushState };
}
