import { createVerify, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isFcmEndpoint, loadFcm, resetFcmTokenCache, sendFcm, signServiceJwt, type FcmConfig } from "./fcm";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const CFG: FcmConfig = { projectId: "demo-proj", clientEmail: "svc@demo-proj.iam.gserviceaccount.com", privateKey };
const MSG = { title: "새 주문", body: "주문 1건", url: "/dashboard/orders", tag: "order-o1" };
const TOKEN = "f".repeat(60);

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => resetFcmTokenCache());

describe("설정·구분", () => {
  it("환경변수가 모두 있어야 켜지고, 줄바꿈 \\n 은 실제 줄바꿈으로 바뀐다", () => {
    expect(loadFcm({})).toBeNull();
    expect(loadFcm({ FCM_PROJECT_ID: "p", FCM_CLIENT_EMAIL: "e" })).toBeNull();
    expect(loadFcm({ FCM_PROJECT_ID: "p", FCM_CLIENT_EMAIL: "e", FCM_PRIVATE_KEY: "a\\nb" })).toEqual({ projectId: "p", clientEmail: "e", privateKey: "a\nb" });
  });

  it("https:// 가 아니면 앱(FCM) 토큰으로 본다", () => {
    expect(isFcmEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBe(false);
    expect(isFcmEndpoint(TOKEN)).toBe(true);
  });
});

describe("서비스 계정 JWT", () => {
  it("RS256 으로 서명되고 공개키로 검증되며 필요한 항목이 들어 있다", () => {
    const jwt = signServiceJwt(CFG, 1_000_000);
    const [h, c, s] = jwt.split(".");

    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(c, "base64url").toString())).toEqual({
      iss: CFG.clientEmail, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: "https://oauth2.googleapis.com/token", iat: 1_000_000, exp: 1_003_600,
    });
    expect(createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(s, "base64url"))).toBe(true);
  });
});

describe("sendFcm", () => {
  const ok = () =>
    vi.fn(async (url: string | URL | Request, _init?: RequestInit) => (String(url).includes("oauth2") ? json({ access_token: "at-1", expires_in: 3600 }) : json({ name: "projects/demo-proj/messages/1" })));

  it("토큰을 받아 메시지를 보낸다(높은 우선순위, 채널, 누르면 열 주소, 연락처 없음)", async () => {
    const f = ok();

    expect(await sendFcm(CFG, TOKEN, MSG, { fetch: f as never })).toEqual({ ok: true });

    const [, sendCall] = f.mock.calls;

    expect(String(sendCall[0])).toBe("https://fcm.googleapis.com/v1/projects/demo-proj/messages:send");
    expect((sendCall[1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer at-1" });
    expect(JSON.parse((sendCall[1] as RequestInit).body as string)).toEqual({
      message: {
        token: TOKEN,
        notification: { title: "새 주문", body: "주문 1건" },
        data: { url: "/dashboard/orders", tag: "order-o1" },
        android: { priority: "HIGH", ttl: "1800s", notification: { channel_id: "orders", tag: "order-o1" } },
      },
    });
  });

  it("OAuth 토큰은 만료 전까지 다시 받지 않는다", async () => {
    const f = ok();

    await sendFcm(CFG, TOKEN, MSG, { fetch: f as never, now: () => 1_000 });
    await sendFcm(CFG, TOKEN, MSG, { fetch: f as never, now: () => 2_000 });

    expect(f.mock.calls.filter(([u]) => String(u).includes("oauth2"))).toHaveLength(1);
  });

  it("만료·해지된 토큰만 지우라고 알린다(UNREGISTERED·404·잘못된 토큰), 일시 장애는 지우지 않는다", async () => {
    const reply = (status: number, body: unknown) => vi.fn(async (u: string | URL | Request) => (String(u).includes("oauth2") ? json({ access_token: "at", expires_in: 3600 }) : json(body, status)));
    const run = async (status: number, body: unknown) => {
      resetFcmTokenCache();

      return sendFcm(CFG, TOKEN, MSG, { fetch: reply(status, body) as never });
    };

    expect(await run(404, { error: { status: "NOT_FOUND" } })).toEqual({ ok: false, gone: true });
    expect(await run(404, { error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } })).toEqual({ ok: false, gone: true });
    // 400 INVALID_ARGUMENT: 토큰 필드가 지목됐을 때만 지운다(메시지가 잘못된 경우 모든 기기를 지우면 안 된다)
    expect(await run(400, { error: { status: "INVALID_ARGUMENT", details: [{ fieldViolations: [{ field: "message.token" }] }] } })).toEqual({ ok: false, gone: true });
    expect(await run(400, { error: { status: "INVALID_ARGUMENT" } })).toEqual({ ok: false, gone: false });
    expect(await run(400, { error: { status: "INVALID_ARGUMENT", details: [{ fieldViolations: [{ field: "message.data" }] }] } })).toEqual({ ok: false, gone: false });
    expect(await run(500, { error: { status: "INTERNAL" } })).toEqual({ ok: false, gone: false });
    expect(await run(403, { error: { status: "PERMISSION_DENIED" } })).toEqual({ ok: false, gone: false });
    expect(await run(429, { error: { status: "QUOTA_EXCEEDED" } })).toEqual({ ok: false, gone: false });
  });

  it("OAuth 실패·네트워크 오류는 보내지 못한 것으로만 센다(토큰을 지우지 않는다)", async () => {
    expect(await sendFcm(CFG, TOKEN, MSG, { fetch: vi.fn(async () => json({}, 401)) as never })).toEqual({ ok: false, gone: false });
    resetFcmTokenCache();
    expect(await sendFcm(CFG, TOKEN, MSG, { fetch: vi.fn(async () => { throw new Error("net"); }) as never })).toEqual({ ok: false, gone: false });
  });
});
