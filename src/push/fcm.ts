import { createSign } from "node:crypto";

/**
 * 앱(안드로이드) 푸시 서버 발송: Firebase Cloud Messaging(HTTP v1). wholesale·shipping-prj 공용.
 * 서비스 계정 키로 OAuth 토큰을 받아(JWT 서명, 외부 라이브러리 없이) 메시지를 보낸다. 환경변수가 없으면 아무것도 보내지 않는다(정상 상태).
 */

export interface FcmConfig {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

/** FCM_PROJECT_ID · FCM_CLIENT_EMAIL · FCM_PRIVATE_KEY (서비스 계정 JSON 의 값). 줄바꿈은 \n 문자로 넣어도 된다. 하나라도 없으면 null. */
export function loadFcm(env: Record<string, string | undefined> = process.env): FcmConfig | null {
  const projectId = env.FCM_PROJECT_ID;
  const clientEmail = env.FCM_CLIENT_EMAIL;
  const privateKey = env.FCM_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!projectId || !clientEmail || !privateKey) return null;

  return { projectId, clientEmail, privateKey };
}

/** 서버에 FCM 환경변수가 모두 있는지(앱 알림을 켤 수 있는지). */
export const isFcmConfigured = (): boolean => loadFcm() !== null;

/** 웹 푸시 구독은 https:// 주소이고, FCM 토큰은 그렇지 않다. */
export const isFcmEndpoint = (endpoint: string): boolean => !endpoint.startsWith("https://");

const b64url = (v: Buffer | string) => Buffer.from(v).toString("base64url");

/** OAuth 토큰 요청용 서명된 JWT(RS256). */
export function signServiceJwt(cfg: FcmConfig, nowSec: number): string {
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(
    JSON.stringify({
      iss: cfg.clientEmail,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: nowSec,
      exp: nowSec + 3600,
    }),
  );
  const sig = createSign("RSA-SHA256").update(`${head}.${claim}`).sign(cfg.privateKey);

  return `${head}.${claim}.${b64url(sig)}`;
}

type Fetch = typeof fetch;

let cached: { token: string; expiresAt: number; key: string } | null = null;

async function accessToken(cfg: FcmConfig, f: Fetch, now: () => number): Promise<string | null> {
  const key = `${cfg.clientEmail}:${cfg.projectId}`;

  if (cached && cached.key === key && cached.expiresAt - 60_000 > now()) return cached.token;

  const res = await f("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: signServiceJwt(cfg, Math.floor(now() / 1000)) }),
  });

  if (!res.ok) return null;

  const body = (await res.json()) as { access_token?: string; expires_in?: number };

  if (!body.access_token) return null;

  cached = { token: body.access_token, expiresAt: now() + (body.expires_in ?? 3600) * 1000, key };

  return body.access_token;
}

export function resetFcmTokenCache() {
  cached = null;
}

export interface FcmMessage {
  title: string;
  body: string;
  /** 알림을 누르면 열 앱 안 주소(각 앱의 사이트 안 경로, 예: /dashboard/orders) */
  url: string;
  tag: string;
}

export type FcmResult = { ok: true } | { ok: false; gone: boolean };

/**
 * 토큰 하나에 보낸다. 토큰이 만료·해지된 경우(UNREGISTERED·404, 잘못된 토큰)는 gone=true 로 알려 지우게 한다.
 * 알림 본문에는 연락처를 넣지 않는다(웹 푸시와 같은 규칙). Android 우선순위는 높음, 채널 "orders".
 */
export async function sendFcm(
  cfg: FcmConfig,
  token: string,
  msg: FcmMessage,
  deps: { fetch?: Fetch; now?: () => number } = {},
): Promise<FcmResult> {
  const f = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;

  try {
    const at = await accessToken(cfg, f, now);

    if (!at) return { ok: false, gone: false };

    const res = await f(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(cfg.projectId)}/messages:send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          token,
          notification: { title: msg.title, body: msg.body },
          data: { url: msg.url, tag: msg.tag },
          android: { priority: "HIGH", ttl: "1800s", notification: { channel_id: "orders", tag: msg.tag } },
        },
      }),
    });

    if (res.ok) return { ok: true };

    const err = (await res.json().catch(() => ({}))) as { error?: { status?: string; details?: Array<{ errorCode?: string; fieldViolations?: Array<{ field?: string }> }> } };
    const code = err.error?.details?.find((d) => d.errorCode)?.errorCode ?? err.error?.status;
    // INVALID_ARGUMENT 는 토큰이 잘못된 경우뿐 아니라 메시지(본문·데이터·채널)가 잘못된 경우에도 온다. 토큰 필드가 지목됐을 때만 토큰 문제로 본다.
    const tokenInvalid = res.status === 400 && code === "INVALID_ARGUMENT" && Boolean(err.error?.details?.some((d) => d.fieldViolations?.some((v) => /token/i.test(v.field ?? ""))));

    // 토큰 자체가 쓸 수 없는 경우만 지운다. 일시 장애·권한 문제·메시지 형식 문제로 토큰을 지우지 않는다.
    return { ok: false, gone: res.status === 404 || code === "UNREGISTERED" || tokenInvalid };
  } catch {
    return { ok: false, gone: false };
  }
}
