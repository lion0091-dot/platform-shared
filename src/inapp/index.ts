/** 카카오톡 인앱 브라우저 판별과 외부 브라우저로 열기 링크(순수 함수, 환경 무관). */

const KAKAO_IN_APP_PATTERN = /kakaotalk/i;

export function isKakaoInApp(userAgent: string | null | undefined): boolean {
  return KAKAO_IN_APP_PATTERN.test(userAgent ?? "");
}

/** 카카오톡이 지원하는 스킴으로 주어진 주소를 기기 기본 브라우저에서 다시 연다. */
export function kakaoExternalOpenUrl(pageUrl: string): string {
  return `kakaotalk://web/openExternal?url=${encodeURIComponent(pageUrl)}`;
}

/** 경로가 접두어와 정확히 같거나 `접두어/` 로 시작하면 참. `/shopping` 은 `/shop` 에 걸리지 않는다. 목록은 앱이 넘긴다. */
export function matchesPathPrefixes(pathname: string | null | undefined, prefixes: readonly string[]): boolean {
  const path = pathname ?? "";

  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}
