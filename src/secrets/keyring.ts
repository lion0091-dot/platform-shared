import { createHash } from "node:crypto";
import { SecretError } from "./errors";

/**
 * 마스터 키 로더와 키링. 서버 전용(node:crypto).
 *
 * 키 형식(둘 다 32바이트): hex 64자, 또는 base64/base64url(패딩 유무 무관).
 * 두 형식은 길이가 달라 모호하지 않아, 기존 두 앱의 환경변수 값을 **그대로** 넘길 수 있다(키를 바꾸지 않고 형식만 이전).
 *
 * 키링 = 현재 키 1개(쓰기·우선 읽기) + 이전 키 0개 이상(읽기 전용). 키 식별자 kid 는 키 바이트의 SHA-256 앞 4바이트 hex 라
 * 설정이 필요 없고 키 값이 드러나지 않는다.
 */

export interface KeyringOptions {
  /** 현재 키 환경변수 이름. 기본 `TENANT_SECRET_KEY`. */
  current?: string;
  /** 이전 키(쉼표로 여러 개) 환경변수 이름. 기본 `<current>_PREVIOUS`. */
  previous?: string;
}

interface KeyEntry {
  kid: string;
  bytes: Buffer;
}

const keyMaterial = new WeakMap<Keyring, readonly KeyEntry[]>();

/** 키 바이트를 노출하지 않는 불투명 객체. 직렬화·콘솔 출력에는 kid 만 나온다. */
export class Keyring {
  readonly currentKid: string;
  readonly previousKids: readonly string[];

  constructor(entries: readonly KeyEntry[]) {
    if (entries.length === 0) throw new SecretError("SECRET_KEY_MISSING");

    this.currentKid = entries[0].kid;
    this.previousKids = entries.slice(1).map((e) => e.kid);
    keyMaterial.set(this, entries);
  }

  toJSON(): { currentKid: string; previousKids: readonly string[] } {
    return { currentKid: this.currentKid, previousKids: this.previousKids };
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `Keyring(current=${this.currentKid}, previous=[${this.previousKids.join(",")}])`;
  }
}

/** 패키지 내부용(index 에서 내보내지 않음). 현재 키가 맨 앞. */
export function keyEntries(ring: Keyring): readonly KeyEntry[] {
  const entries = keyMaterial.get(ring);

  if (!entries) throw new SecretError("SECRET_KEY_INVALID");

  return entries;
}

export function kidOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest().subarray(0, 4).toString("hex");
}

const HEX64 = /^[0-9a-fA-F]{64}$/;
const B64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

/** 키 문자열 하나를 32바이트로. 형식이 틀리면 SECRET_KEY_INVALID(값은 메시지에 없음). */
export function parseKey(raw: string): Buffer {
  const value = raw.trim();

  if (HEX64.test(value)) return Buffer.from(value, "hex");

  // 32바이트의 base64 는 패딩 포함 44자, 패딩 없으면 43자. 그 밖의 길이는 받지 않는다(느슨한 디코딩 방지).
  if ((value.length === 44 || value.length === 43) && B64.test(value)) {
    const bytes = Buffer.from(value, "base64");

    if (bytes.length === 32) return bytes;
  }

  throw new SecretError("SECRET_KEY_INVALID");
}

/**
 * 환경에서 키링을 만든다. 환경 객체를 인자로 받아(전역 process.env 직접 읽기 없음) 시험이 쉽다.
 *  - 현재 키가 없으면 SECRET_KEY_MISSING, 형식이 틀리면 SECRET_KEY_INVALID(이전 키 포함), 같은 키가 둘 이상이면 SECRET_KEY_DUPLICATE.
 */
export function loadKeyring(env: Record<string, string | undefined>, opts: KeyringOptions = {}): Keyring {
  const currentName = opts.current ?? "TENANT_SECRET_KEY";
  const previousName = opts.previous ?? `${currentName}_PREVIOUS`;

  const current = env[currentName];

  if (typeof current !== "string" || current.trim() === "") throw new SecretError("SECRET_KEY_MISSING");

  const previousRaw = env[previousName];
  const previous =
    typeof previousRaw === "string"
      ? previousRaw
          .split(",")
          .map((v) => v.trim())
          .filter((v) => v !== "")
      : [];

  const entries: KeyEntry[] = [current, ...previous].map((raw) => {
    const bytes = parseKey(raw);

    return { kid: kidOf(bytes), bytes };
  });

  if (new Set(entries.map((e) => e.kid)).size !== entries.length) throw new SecretError("SECRET_KEY_DUPLICATE");

  return new Keyring(entries);
}
