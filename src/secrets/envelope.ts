import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { SecretError } from "./errors";
import { keyEntries, type Keyring } from "./keyring";

/**
 * 봉투(AES-256-GCM). 서버 전용.
 *
 *   ENC:v2:<kid>:<base64url( iv(12) ‖ 태그(16) ‖ 암호문 )>
 *   AAD = "platform-secret/v2|" + tenantId(소문자) + "|" + provider
 *
 * 다른 테넌트 행·같은 테넌트의 다른 provider 칸으로 옮긴 암호문은 풀리지 않는다.
 * 쓰기는 항상 v2·현재 키. 읽기는 v2 와 아래 두 레거시 형식을 받는다(`needsRewrite: true` 로 알려 줌).
 *
 *   v1             `ENC:v1:` + base64(iv‖태그‖암호문), AAD = 테넌트 id 문자열 그대로(provider 는 묶이지 않음)
 *   legacy-dotted  접두 없음, `iv.태그.암호문`(각각 base64url), AAD 없음
 */

export interface SecretContext {
  /** 테넌트(운영사·공급사) id. `^[A-Za-z0-9-]{1,64}$`, v2 에서는 소문자로 정규화된다. */
  tenantId: string;
  /** 비밀의 종류 슬러그. `^[a-z0-9-]{1,32}$`(예: toss, bizppurio, popbill). */
  provider: string;
}

export type SecretFormat = "v2" | "v1" | "legacy-dotted";

export interface OpenedSecret {
  plain: string;
  /** true 면 레거시 형식이거나 이전 키로 봉인된 것 → 읽은 김에(또는 일괄 스크립트로) 다시 봉인해 저장할 것. */
  needsRewrite: boolean;
  format: SecretFormat;
}

const PREFIX_V2 = "ENC:v2:";
const PREFIX_V1 = "ENC:v1:";
const AAD_V2 = "platform-secret/v2|";
const IV_LEN = 12;
const TAG_LEN = 16;

const TENANT_RE = /^[A-Za-z0-9-]{1,64}$/;
const PROVIDER_RE = /^[a-z0-9-]{1,32}$/;
const KID_RE = /^[0-9a-f]{8}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function checkContext(ctx: SecretContext): { tenant: string; provider: string } {
  if (!ctx || typeof ctx.tenantId !== "string" || typeof ctx.provider !== "string") throw new SecretError("SECRET_CONTEXT_INVALID");

  if (!TENANT_RE.test(ctx.tenantId) || !PROVIDER_RE.test(ctx.provider)) throw new SecretError("SECRET_CONTEXT_INVALID");

  return { tenant: ctx.tenantId.toLowerCase(), provider: ctx.provider };
}

function aadV2(tenant: string, provider: string): Buffer {
  return Buffer.from(`${AAD_V2}${tenant}|${provider}`, "utf8");
}

function decryptWith(key: Buffer, iv: Buffer, tag: Buffer, body: Buffer, aad: Buffer | null): string | null {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);

    if (aad) decipher.setAAD(aad);

    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** 평문을 v2 봉투로 봉인한다(현재 키). 평문은 문자열(보통 provider 별 JSON 한 묶음). */
export function sealSecret(plain: string, ctx: SecretContext, ring: Keyring): string {
  if (typeof plain !== "string") throw new SecretError("SECRET_FORMAT");

  const { tenant, provider } = checkContext(ctx);
  const current = keyEntries(ring)[0];
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", current.bytes, iv);

  cipher.setAAD(aadV2(tenant, provider));

  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);

  return `${PREFIX_V2}${current.kid}:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url")}`;
}

/** 봉투를 연다. 실패는 SecretError(코드만). 레거시 형식은 읽기만 지원한다(쓰기 경로 없음). */
export function openSecret(token: string, ctx: SecretContext, ring: Keyring): OpenedSecret {
  const { tenant, provider } = checkContext(ctx);

  if (typeof token !== "string" || token === "") throw new SecretError("SECRET_FORMAT");

  const entries = keyEntries(ring);

  if (token.startsWith(PREFIX_V2)) return openV2(token, tenant, provider, ring);

  if (token.startsWith(PREFIX_V1)) {
    const b64 = token.slice(PREFIX_V1.length);

    if (!B64_RE.test(b64)) throw new SecretError("SECRET_FORMAT");

    const raw = Buffer.from(b64, "base64");

    if (raw.length < IV_LEN + TAG_LEN) throw new SecretError("SECRET_FORMAT");

    // 레거시 AAD 는 호출 쪽이 넘긴 테넌트 id 문자열 그대로(대소문자 보존)였다.
    const aad = Buffer.from(ctx.tenantId, "utf8");

    for (const e of entries) {
      const plain = decryptWith(e.bytes, raw.subarray(0, IV_LEN), raw.subarray(IV_LEN, IV_LEN + TAG_LEN), raw.subarray(IV_LEN + TAG_LEN), aad);

      if (plain !== null) return { plain, needsRewrite: true, format: "v1" };
    }

    throw new SecretError("SECRET_DECRYPT_FAILED");
  }

  if (token.startsWith("ENC:")) throw new SecretError("SECRET_FORMAT");

  const parts = token.split(".");

  if (parts.length !== 3 || !parts.every((p) => p !== "" && B64URL_RE.test(p))) throw new SecretError("SECRET_FORMAT");

  const iv = Buffer.from(parts[0], "base64url");
  const tag = Buffer.from(parts[1], "base64url");
  const body = Buffer.from(parts[2], "base64url");

  if (iv.length !== IV_LEN || tag.length !== TAG_LEN) throw new SecretError("SECRET_FORMAT");

  for (const e of entries) {
    const plain = decryptWith(e.bytes, iv, tag, body, null);

    if (plain !== null) return { plain, needsRewrite: true, format: "legacy-dotted" };
  }

  throw new SecretError("SECRET_DECRYPT_FAILED");
}

function openV2(token: string, tenant: string, provider: string, ring: Keyring): OpenedSecret {
  const parts = token.slice(PREFIX_V2.length).split(":");

  if (parts.length !== 2 || !KID_RE.test(parts[0]) || !B64URL_RE.test(parts[1])) throw new SecretError("SECRET_FORMAT");

  const raw = Buffer.from(parts[1], "base64url");

  if (raw.length < IV_LEN + TAG_LEN) throw new SecretError("SECRET_FORMAT");

  const entry = keyEntries(ring).find((e) => e.kid === parts[0]);

  if (!entry) throw new SecretError("SECRET_KEY_UNKNOWN");

  const plain = decryptWith(entry.bytes, raw.subarray(0, IV_LEN), raw.subarray(IV_LEN, IV_LEN + TAG_LEN), raw.subarray(IV_LEN + TAG_LEN), aadV2(tenant, provider));

  if (plain === null) throw new SecretError("SECRET_DECRYPT_FAILED");

  return { plain, needsRewrite: entry.kid !== ring.currentKid, format: "v2" };
}
