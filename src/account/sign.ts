import { createHmac, randomUUID } from "node:crypto";

/**
 * account 서버 호출(정지·해제·접근 모드·보류 읽기·대표 이전)의 서명과 본문 만들기 — 약속: account 저장소 docs/contract/integration-contract.md.
 * 서명 = HMAC-SHA256(본문 원문 문자열 전체, 비밀)의 hex 소문자 64자. **서명한 바로 그 문자열을 그대로 전송**한다(다시 직렬화 금지).
 * 비밀 값은 이 코드에 없다(호출하는 앱이 환경변수에서 읽어 넘긴다). 서버 전용.
 */
export type AccountSystem = "wholesale" | "shipping";
export type AccountCallAction = "suspend" | "resume" | "set_access" | "read_holds" | "transfer_owner";

export const hmacHex = (raw: string, secret: string): string => createHmac("sha256", secret).update(raw).digest("hex");

export interface SignedCallInput {
  system: AccountSystem;
  action: AccountCallAction;
  /** 외부 업체 id (ext_tenant) */
  extTenant: string;
  /** 동작별 추가 필드(ext_user, access, kind, new_owner·old_owner …). 넣은 순서대로 본문에 들어간다. */
  fields?: Record<string, string | number>;
}

export interface SignedCallDeps {
  now?: number;
  jti?: string;
  /** 본문 수명(초). 약속상 최대 60. */
  ttl?: number;
}

/** 서명된 호출: 본문(그대로 보낼 문자열)과 x-signature 값. iat=now, exp=now+ttl(최대 60초), 재시도마다 새 jti. */
export function buildSignedCall(secret: string, input: SignedCallInput, deps: SignedCallDeps = {}): { body: string; signature: string } {
  const iat = Math.floor((deps.now ?? Date.now()) / 1000);
  const ttl = Math.min(deps.ttl ?? 60, 60);
  const body = JSON.stringify({
    system: input.system,
    action: input.action,
    ext_tenant: input.extTenant,
    ...(input.fields ?? {}),
    jti: deps.jti ?? randomUUID(),
    iat,
    exp: iat + ttl,
  });

  return { body, signature: hmacHex(body, secret) };
}
