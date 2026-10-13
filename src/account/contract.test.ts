import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildSignedCall, hmacHex, type AccountCallAction as CallAction, type AccountSystem } from "./sign";
import { signSsoToken } from "./sso";
import { classifyAccountResponse, type AccountCallResult } from "./response";

/** account 가 만든 시험 벡터(account 저장소 docs/contract/integration-contract-vectors.json 의 복사본). 약속이 바뀌면 이 파일을 account 것으로 다시 복사한다. */
const vectors = JSON.parse(readFileSync(new URL("./__vectors__/integration-contract-vectors.json", import.meta.url), "utf8")) as {
  now: number;
  secrets_TEST_ONLY: Record<string, string>;
  sso_tokens: Array<{ id: string; system: AccountSystem; secretKey: string; token: string; expect: { ok: boolean; code?: string } }>;
  signed_calls: Array<{ id: string; secretKey: string; body: string; signature: string; expect: { ok: boolean; code?: string } }>;
  response_actions: Array<{ http: number | "network"; body: string; action: string }>;
};

describe("서명 호출 벡터", () => {
  it("모든 벡터에서 서명이 account 정답과 같다(서명 틀림·변조 벡터는 일부러 다르다)", () => {
    for (const call of vectors.signed_calls) {
      const mine = hmacHex(call.body, vectors.secrets_TEST_ONLY[call.secretKey]);
      const shouldMismatch = call.expect.code === "CALL_BAD_SIGNATURE";

      expect(mine === call.signature, call.id).toBe(!shouldMismatch);
    }
  });

  it("같은 입력으로 본문 문자열이 벡터와 정확히 같게 만들어진다(성공 벡터, action 이 있는 것)", () => {
    for (const call of vectors.signed_calls.filter((c) => c.expect.ok)) {
      const parsed = JSON.parse(call.body) as Record<string, string | number>;

      if (!parsed.action) continue; // 옛 호출(action 생략)은 새 코드가 만들지 않는다

      const { system, action, ext_tenant, jti, iat, exp, ...fields } = parsed;
      const built = buildSignedCall(vectors.secrets_TEST_ONLY[call.secretKey], { system: system as AccountSystem, action: action as CallAction, extTenant: String(ext_tenant), fields: fields as Record<string, string | number> }, { now: Number(iat) * 1000, jti: String(jti), ttl: Number(exp) - Number(iat) });

      expect(built.body, call.id).toBe(call.body);
      expect(built.signature, call.id).toBe(call.signature);
    }
  });

  it("수명은 60초를 넘기지 않는다", () => {
    const built = buildSignedCall("s".repeat(30), { system: "wholesale", action: "read_holds", extTenant: "t" }, { now: 1_000_000, jti: "jti-12345678", ttl: 999 });

    expect(JSON.parse(built.body)).toMatchObject({ iat: 1000, exp: 1060 });
  });
});

describe("SSO 토큰 벡터", () => {
  const verify = (token: string, secret: string) => {
    const [h, p, s] = token.split(".");

    return createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url") === s;
  };

  it("정상 토큰은 같은 입력으로 똑같은 토큰이 만들어진다", () => {
    for (const t of vectors.sso_tokens.filter((x) => x.expect.ok)) {
      const p = JSON.parse(Buffer.from(t.token.split(".")[1], "base64url").toString()) as Record<string, string | number>;
      const mine = signSsoToken(
        vectors.secrets_TEST_ONLY[t.secretKey],
        { system: p.iss as AccountSystem, extUser: String(p.ext_user), extTenant: String(p.ext_tenant), role: String(p.role), name: String(p.name), to: p.to as string | undefined, access: (p.access as "normal" | "read_only" | undefined) ?? null },
        { now: Number(p.iat) * 1000, jti: String(p.jti), ttl: Number(p.exp) - Number(p.iat) }
      );

      expect(mine, t.id).toBe(t.token);
    }
  });

  it("벡터 토큰의 서명은 우리 계산과 맞고, 서명 틀림 벡터만 다르다", () => {
    for (const t of vectors.sso_tokens) {
      expect(verify(t.token, vectors.secrets_TEST_ONLY[t.secretKey]), t.id).toBe(t.expect.code !== "SSO_BAD_SIGNATURE");
    }
  });

  it("경로는 /ledger 아래로만 제한하고, 잘못된 소유자 uuid·접근 값은 싣지 않는다", () => {
    const base = { system: "wholesale" as const, extUser: "u", extTenant: "t", role: "owner", name: "상호" };
    const claims = (input: Parameters<typeof signSsoToken>[1]) => JSON.parse(Buffer.from(signSsoToken("k".repeat(30), input, { now: 1000, jti: "j" }).split(".")[1], "base64url").toString());

    expect(claims({ ...base, to: "//evil" }).to).toBe("/ledger");
    expect(claims({ ...base, to: "/ledger/vat" }).to).toBe("/ledger/vat");
    expect(claims(base)).not.toHaveProperty("to");
    expect(claims({ ...base, ownerExtUser: "not-uuid" })).not.toHaveProperty("owner_ext_user");
    expect(claims({ ...base, access: "frozen" as never })).not.toHaveProperty("access");
    expect(claims({ ...base, access: "read_only", accessSeq: 5 })).toMatchObject({ access: "read_only", access_seq: 5 });
  });
});

describe("응답 분류 벡터", () => {
  const expected: Record<string, AccountCallResult> = {
    SUCCESS: "sent",
    SUCCESS_NOOP: "sent_noop",
    STOP: "stop",
    RETRY_NEW_JTI: "retry",
    RETRY_LATER: "retry_later",
    TREAT_AS_SENT: "treat_as_sent",
  };

  it("벡터 표의 모든 (상태, 코드) 조합이 약속한 처리로 분류된다", () => {
    for (const row of vectors.response_actions) {
      const codes = row.body.match(/[A-Z][A-Z_*]+/g) ?? [];
      const samples = row.http === 200 ? [] : codes.filter((c) => /_/.test(c)).map((c) => c.replace("*", "X"));

      if (row.http === "network") {
        expect(classifyAccountResponse("network", null).action).toBe(expected[row.action]);
      } else if (row.http === 200) {
        const statuses = row.body.match(/(?<=status: ).*/)?.[0].split("|").map((s) => s.trim()) ?? [];

        for (const status of statuses) {
          const want = expected[row.action === "SUCCESS" && ["NO_LINK", "NO_USER", "NOT_MEMBER"].includes(status) ? "SUCCESS_NOOP" : row.action];

          expect(classifyAccountResponse(200, { status }).action, `${row.http} ${status}`).toBe(want);
        }

        if (statuses.length === 0) expect(classifyAccountResponse(200, { total_count: 1 }).action).toBe("sent");
      } else {
        for (const code of samples) expect(classifyAccountResponse(row.http, { error: code }).action, `${row.http} ${code}`).toBe(expected[row.action]);
        if (samples.length === 0) expect(classifyAccountResponse(row.http, { error: "NOT_FOUND" }).action, `${row.http}`).toBe(expected[row.action]);
      }
    }
  });

  it("알 수 없는 5xx 는 재시도, 알 수 없는 4xx 는 멈춤", () => {
    expect(classifyAccountResponse(502, null).action).toBe("retry");
    expect(classifyAccountResponse(418, { error: "X" }).action).toBe("stop");
  });
});
