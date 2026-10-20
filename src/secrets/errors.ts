/**
 * 오류 코드. 메시지는 **코드 문자열 그대로**이며 평문·암호문·키 조각을 절대 담지 않는다(로그에 그대로 찍어도 안전).
 *
 *  SECRET_KEY_MISSING    마스터 키 환경변수가 없거나 비어 있음
 *  SECRET_KEY_INVALID    키 형식이 hex 64자도, 32바이트 base64 도 아님
 *  SECRET_KEY_DUPLICATE  현재 키와 이전 키(또는 이전 키끼리)가 같은 값
 *  SECRET_CONTEXT_INVALID tenantId·provider 형식이 허용되지 않음(AAD 구분자 오염 방지)
 *  SECRET_FORMAT         알 수 없는 봉투 형식이거나 깨진 문자열
 *  SECRET_KEY_UNKNOWN    봉투의 키 식별자(kid)에 해당하는 키가 키링에 없음(키 분실·환경 혼동)
 *  SECRET_DECRYPT_FAILED 변조되었거나, 다른 테넌트·provider 의 암호문이거나, 키가 다름
 */
export type SecretErrorCode =
  | "SECRET_KEY_MISSING"
  | "SECRET_KEY_INVALID"
  | "SECRET_KEY_DUPLICATE"
  | "SECRET_CONTEXT_INVALID"
  | "SECRET_FORMAT"
  | "SECRET_KEY_UNKNOWN"
  | "SECRET_DECRYPT_FAILED";

export class SecretError extends Error {
  readonly code: SecretErrorCode;

  constructor(code: SecretErrorCode) {
    super(code);
    this.name = "SecretError";
    this.code = code;
  }
}
