import { createHmac, randomUUID } from "node:crypto";

/**
 * account SSO 토큰(JWT HS256, 60초, 일회용 jti) 만들기 — 약속: account 저장소 docs/contract/integration-contract.md §3.
 * 서버 전용. 비밀 값은 호출하는 앱이 환경변수에서 읽어 넘긴다. 이메일은 싣지 않는다(카카오 사용자는 없을 수 있다).
 */
export type AccountAccess = "normal" | "read_only";

export interface SsoClaimsInput {
  /** 토큰 발행 시스템(iss) */
  system: "wholesale" | "shipping";
  /** 외부 사용자 uuid */
  extUser: string;
  /** 외부 업체 uuid */
  extTenant: string;
  /** wholesale: owner|manager, shipping: owner|manager|viewer (account 가 역할을 매핑·거부한다) */
  role: string;
  /** 업체 이름 — account 테넌트를 처음 만들 때만 쓰인다(최대 100자) */
  name: string;
  /** 들어갈 account 화면 경로(/ledger 아래만 받아 준다). 없으면 싣지 않는다(account 는 /ledger). */
  to?: string;
  /** 대표가 아닌 사람이 처음 열 때 소유자 지정용 uuid */
  ownerExtUser?: string | null;
  /** 업체 상태에 따른 접근 모드. 없으면 싣지 않는다(account 는 옛 동작). */
  access?: AccountAccess | null;
  /** 접근 모드가 정해진 순서 번호(epoch ms). access 와 함께만 싣는다. (account 미구현 — 보내기만 한다) */
  accessSeq?: number | null;
}

const b64 = (v: Buffer | string) => Buffer.from(v).toString("base64url");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 들어갈 경로를 /ledger 아래 내부 경로로 제한한다(아니면 /ledger). account 쪽에서도 같은 검증을 한다. */
export function ssoTarget(to: unknown): string {
  if (typeof to !== "string" || !to.startsWith("/ledger") || to.startsWith("//") || to.includes("\\") || /[\r\n]/.test(to)) return "/ledger";
  if (to !== "/ledger" && !to.startsWith("/ledger/") && !to.startsWith("/ledger?")) return "/ledger";

  return to;
}

export function signSsoToken(secret: string, input: SsoClaimsInput, deps: { now?: number; jti?: string; ttl?: number } = {}): string {
  const iat = Math.floor((deps.now ?? Date.now()) / 1000);
  const hasAccess = input.access === "normal" || input.access === "read_only";
  const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64(
    JSON.stringify({
      iss: input.system,
      aud: "account",
      ext_user: input.extUser,
      ext_tenant: input.extTenant,
      role: input.role,
      name: input.name.trim().slice(0, 100),
      jti: deps.jti ?? randomUUID(),
      iat,
      exp: iat + Math.min(deps.ttl ?? 60, 60),
      ...(hasAccess ? { access: input.access } : {}),
      ...(hasAccess && Number.isSafeInteger(input.accessSeq) && (input.accessSeq as number) >= 1 ? { access_seq: input.accessSeq } : {}),
      ...(input.to !== undefined ? { to: ssoTarget(input.to) } : {}),
      ...(input.ownerExtUser && UUID_RE.test(input.ownerExtUser) ? { owner_ext_user: input.ownerExtUser } : {}),
    })
  );

  return `${head}.${body}.${createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`;
}
