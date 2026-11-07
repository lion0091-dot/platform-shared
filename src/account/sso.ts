import { createHmac, randomUUID } from "node:crypto";
import { assertSignSecret, signNowSec, signTtl } from "./guard";

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
  if (typeof to !== "string" || !to.startsWith("/ledger") || to.startsWith("//") || to.includes("\\") || /[\u0000-\u001f\u007f]/.test(to)) return "/ledger";
  if (to !== "/ledger" && !to.startsWith("/ledger/") && !to.startsWith("/ledger?")) return "/ledger";
  if (!isCleanPath(to.split(/[?#]/, 1)[0])) return "/ledger";

  return to;
}

/**
 * 경로 구간 검사(보안 점검 2-1): `.`·`..` 구간(퍼센트 인코딩·이중 인코딩 포함), 인코딩된 `/`·`\`·제어문자, 깨진 퍼센트 인코딩이 있으면 거짓.
 * `/ledger/../admin` 처럼 접두만 맞고 브라우저가 정규화하면 다른 경로가 되는 값을 막는다. 쿼리는 검사하지 않는다(경로가 아니다).
 */
function isCleanPath(path: string): boolean {
  for (const segment of path.split("/")) {
    let s = segment;

    for (let i = 0; i < 3; i++) {
      let decoded: string;

      try {
        decoded = decodeURIComponent(s);
      } catch {
        return false;
      }

      if (decoded === s) break;

      s = decoded;
    }

    // 최대 3 번 풀어도 인코딩된 점·구분자(%2e·%2f·%5c·%00)가 남아 있는 구간(이중·삼중 인코딩)은 거부한다.
    if (s === "." || s === ".." || /[\/\\\u0000-\u001f\u007f]/.test(s) || /%(?:2e|2f|5c|00)/i.test(s)) return false;
  }

  return true;
}

export function signSsoToken(secret: string, input: SsoClaimsInput, deps: { now?: number; jti?: string; ttl?: number } = {}): string {
  assertSignSecret(secret);

  const iat = signNowSec(deps.now);
  const ttl = signTtl(deps.ttl);
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
      exp: iat + ttl,
      ...(hasAccess ? { access: input.access } : {}),
      ...(hasAccess && Number.isSafeInteger(input.accessSeq) && (input.accessSeq as number) >= 1 ? { access_seq: input.accessSeq } : {}),
      ...(input.to !== undefined ? { to: ssoTarget(input.to) } : {}),
      // account 는 uuid 를 소문자로 정규화해 처리한다(계약 §4) — 같은 값이 되도록 소문자로 싣는다.
      ...(input.ownerExtUser && UUID_RE.test(input.ownerExtUser) ? { owner_ext_user: input.ownerExtUser.toLowerCase() } : {}),
    })
  );

  return `${head}.${body}.${createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`;
}
