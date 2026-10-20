import { describe, expect, it } from "vitest";
import { isKakaoInApp, kakaoExternalOpenUrl, matchesPathPrefixes } from "./index";

const KAKAO_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 KAKAOTALK 2510230";
const KAKAO_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KAKAOTALK 10.4.0";
const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

describe("isKakaoInApp", () => {
  it("카톡 인앱 UA(안드로이드·iOS, 대소문자 무관)는 참", () => {
    expect(isKakaoInApp(KAKAO_ANDROID)).toBe(true);
    expect(isKakaoInApp(KAKAO_IOS)).toBe(true);
    expect(isKakaoInApp("x kakaotalk y")).toBe(true);
  });

  it("일반 크롬·빈 문자열·null·undefined 는 거짓", () => {
    expect(isKakaoInApp(CHROME_ANDROID)).toBe(false);
    expect(isKakaoInApp("")).toBe(false);
    expect(isKakaoInApp(null)).toBe(false);
    expect(isKakaoInApp(undefined)).toBe(false);
  });
});

describe("kakaoExternalOpenUrl", () => {
  const PREFIX = "kakaotalk://web/openExternal?url=";

  it("쿼리·한글 주소를 인코딩해 싣고 복원하면 원본과 같다", () => {
    for (const url of ["https://example.com/a/b?x=1&y=한글#frag", "https://example.com/", "https://example.com/p?q=a b&r=%EA%B0%80"]) {
      const built = kakaoExternalOpenUrl(url);

      expect(built.startsWith(PREFIX)).toBe(true);
      expect(decodeURIComponent(built.slice(PREFIX.length))).toBe(url);
    }
  });

  it("인코딩된 값에 원본 주소의 & 와 ? 가 그대로 남지 않는다", () => {
    const built = kakaoExternalOpenUrl("https://example.com/a?x=1&y=2");

    expect(built.slice(PREFIX.length)).not.toMatch(/[?&]/);
  });
});

describe("matchesPathPrefixes", () => {
  const prefixes = ["/shop", "/go", "/doc", "/api"];

  it("정확 일치와 하위 경로는 참", () => {
    for (const path of ["/shop", "/shop/abc", "/shop/abc/checkout", "/go/outbound", "/doc/token", "/api/cron/x"]) {
      expect(matchesPathPrefixes(path, prefixes)).toBe(true);
    }
  });

  it("접두어만 같은 다른 경로·무관 경로는 거짓", () => {
    for (const path of ["/shopping", "/gone", "/", "/login", "/dashboard/orders/1", "/x/shop"]) {
      expect(matchesPathPrefixes(path, prefixes)).toBe(false);
    }
  });

  it("null·undefined·빈 목록은 거짓", () => {
    expect(matchesPathPrefixes(null, prefixes)).toBe(false);
    expect(matchesPathPrefixes(undefined, prefixes)).toBe(false);
    expect(matchesPathPrefixes("/shop", [])).toBe(false);
  });
});
