/**
 * ai-guard 누락률 측정용 «가짜» 예문 생성기. 실제 개인정보는 하나도 없다.
 * - 모든 값은 고정 시드 난수로 만든 형식만 맞춘 가짜 값이다(이메일 도메인은 example.* 등 예약 도메인).
 * - 사업자번호·카드는 실제 데이터처럼 검증식(체크섬·Luhn)을 맞춘다(실제 서류의 번호는 검증식을 통과하므로).
 * - 같은 시드면 항상 같은 예문이 나온다(결과 재현용).
 */

export type PiiKind = "NAME" | "PHONE" | "RRN" | "BIZNO" | "ACCOUNT" | "CARD" | "ADDRESS" | "EMAIL" | "PLATE";
export type DecoyCat = "AMOUNT" | "ORDER_NO" | "TRACKING_NO" | "DATE" | "DATETIME" | "QTY" | "PRODUCT_CODE" | "REP_PHONE" | "ZIP" | "WORD";

export type Seg = string | { pii: PiiKind; v: string; variant: string } | { decoy: DecoyCat; v: string; variant: string };

export interface Sample {
  id: string;
  /** 대표 종류(누락 집계용 분류). 섞인 예문은 "MIXED", 개인정보 없는 예문은 "NONE". */
  group: PiiKind | "MIXED" | "NONE";
  segs: Seg[];
}

// ── 고정 시드 난수 ───────────────────────────────────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeDataset(seed = 20261128): Sample[] {
  const rnd = mulberry32(seed);
  const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const digits = (n: number, firstNonZero = false): string => {
    let s = "";
    for (let i = 0; i < n; i++) s += String(i === 0 && firstNonZero ? int(1, 9) : int(0, 9));
    return s;
  };
  const pad = (n: number, w: number): string => String(n).padStart(w, "0");
  const fw = (s: string): string => s.replace(/[0-9]/g, (d) => String.fromCharCode(0xff10 + Number(d))); // 전각 숫자

  // ── 값 생성기 ──────────────────────────────────────────────
  const SUR = ["김", "이", "박", "최", "정", "강", "조", "윤", "장", "임", "한", "오", "서", "신", "권", "황", "안", "송"];
  const GIV = ["민", "서", "지", "하", "준", "현", "유", "도", "윤", "수", "연", "우", "은", "재", "예", "시", "채", "나", "람", "빈"];
  const HANJA_NAMES = ["金敏洙", "李瑞妍", "朴智勳", "崔有娜", "鄭夏凜", "姜道潤"];
  const EN_NAMES = ["Minsu Kim", "KIM MINSU", "Seoyeon Lee", "Jihoon Park", "Yuna Choi", "Haneul Jung"];
  const hname = (): string => pick(SUR) + pick(GIV) + pick(GIV);

  const luhnCheck = (body: string): string => {
    let sum = 0;
    for (let i = 0; i < body.length; i++) {
      let d = Number(body[body.length - 1 - i]);
      if (i % 2 === 0) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    return String((10 - (sum % 10)) % 10);
  };
  const bizno = (): string => {
    const head = pad(int(101, 899), 3) + pad(int(1, 99), 2) + digits(4);
    const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += Number(head[i]) * w[i]!;
    sum += Math.floor((Number(head[8]) * 5) / 10);
    return head + String((10 - (sum % 10)) % 10);
  };
  const card16 = (): string => {
    const body = pick(["9410", "4518", "5310", "3560", "9430"]) + digits(11);
    return body + luhnCheck(body);
  };
  const amex = (): string => {
    const body = "37" + digits(12);
    return body + luhnCheck(body);
  };
  const ACCT_FORMATS: number[][] = [[6, 2, 6], [3, 3, 6], [4, 3, 6], [3, 4, 4, 2], [3, 6, 2, 3], [3, 6, 5], [4, 2, 7], [3, 2, 6]];
  const BANKS = ["국민", "신한", "우리", "농협", "기업", "하나", "카카오뱅크", "SC제일"];
  const acctParts = (): string[] => pick(ACCT_FORMATS).map((n) => digits(n));
  const mobile = (): string[] => ["010", String(int(2, 9)) + digits(3), digits(4)];
  const landline = (): string[] => {
    const area = pick(["02", "031", "051", "064", "070"]);
    return [area, String(int(2, 9)) + digits(area === "02" ? int(2, 3) : 2), digits(4)];
  };
  const rrnFront = (): string => {
    const y = pick([int(50, 99), int(0, 9)]);
    return pad(y, 2) + pad(int(1, 12), 2) + pad(int(1, 28), 2);
  };
  const ROMAN = ["minsu", "seoyeon", "jihoon", "yuna", "haneul", "doyun", "jaewoo", "eunji"];
  const DOMAINS = ["example.com", "example.co.kr", "example.net", "mail.example.org", "test.example.kr"];
  const PLATE_H = ["가", "나", "다", "라", "마", "거", "너", "더", "러", "고", "노", "도", "로", "구", "누", "두", "바", "사", "아", "자", "하", "허", "호", "배"];
  const SIDO = ["서울특별시 강남구", "서울 마포구", "경기도 성남시 분당구", "부산광역시 해운대구", "인천 연수구", "대구광역시 수성구", "광주 서구", "제주특별자치도 제주시"];
  const ROADS = ["테헤란로", "월드컵북로", "판교역로", "센텀중앙로", "컨벤시아대로", "달구벌대로", "상무중앙로", "연동로"];
  const DONGS = ["역삼동", "망원동", "삼평동", "우동", "송도동", "범어동", "치평동", "연동"];

  // ── 종류별 변형(값 + 변형 이름) ───────────────────────────
  type Gen = () => { v: string; variant: string };
  const VARIANTS: Record<PiiKind, Gen[]> = {
    NAME: [
      () => ({ v: hname(), variant: "한글3자" }),
      () => ({ v: pick(SUR) + pick(GIV), variant: "한글2자(외자)" }),
      () => ({ v: pick(["남궁", "황보", "제갈", "선우"]) + pick(GIV) + pick(GIV), variant: "복성4자" }),
      () => ({ v: pick(HANJA_NAMES), variant: "한자이름" }),
      () => ({ v: pick(EN_NAMES), variant: "영문이름" }),
    ],
    PHONE: [
      () => ({ v: mobile().join("-"), variant: "휴대폰-하이픈" }),
      () => ({ v: mobile().join(" "), variant: "휴대폰-띄어쓰기" }),
      () => ({ v: mobile().join(""), variant: "휴대폰-붙여쓰기" }),
      () => ({ v: mobile().join("."), variant: "휴대폰-점" }),
      () => ({ v: fw(mobile().join("-")), variant: "휴대폰-전각숫자" }),
      () => ({ v: mobile().join("–"), variant: "휴대폰-유니코드대시" }),
      () => ({ v: "+82 " + mobile().join("-").slice(1), variant: "국제+82" }),
      () => ({ v: landline().join("-"), variant: "유선·070" }),
      () => {
        const p = mobile();
        return { v: `${p[0]}-${p[1]} - ${p[2]}`, variant: "휴대폰-구분자앞뒤공백" };
      },
      () => {
        const p = mobile();
        return { v: `${p[0]} - ${p[1]} - ${p[2]}`, variant: "휴대폰-구분자양쪽공백" };
      },
    ],
    RRN: [
      () => ({ v: `${rrnFront()}-${int(1, 4)}${digits(6)}`, variant: "주민-하이픈" }),
      () => ({ v: `${rrnFront()}${int(1, 4)}${digits(6)}`, variant: "주민-붙여쓰기" }),
      () => ({ v: `${rrnFront()} ${int(1, 4)}${digits(6)}`, variant: "주민-띄어쓰기" }),
      () => ({ v: `${rrnFront()} - ${int(1, 4)}${digits(6)}`, variant: "주민-하이픈양쪽공백" }),
      () => ({ v: `${rrnFront()}-${int(5, 8)}${digits(6)}`, variant: "외국인-하이픈" }),
      () => ({ v: `${rrnFront()}${int(5, 8)}${digits(6)}`, variant: "외국인-붙여쓰기" }),
      () => ({ v: fw(`${rrnFront()}-${int(1, 4)}${digits(6)}`), variant: "주민-전각숫자" }),
      () => ({ v: `${rrnFront()}.${int(1, 4)}${digits(6)}`, variant: "주민-점구분" }),
    ],
    BIZNO: [
      () => {
        const b = bizno();
        return { v: `${b.slice(0, 3)}-${b.slice(3, 5)}-${b.slice(5)}`, variant: "사업자-하이픈" };
      },
      () => ({ v: bizno(), variant: "사업자-붙여쓰기" }),
      () => {
        const b = bizno();
        return { v: `${b.slice(0, 3)} ${b.slice(3, 5)} ${b.slice(5)}`, variant: "사업자-띄어쓰기" };
      },
      () => {
        const b = bizno();
        return { v: `${b.slice(0, 3)}.${b.slice(3, 5)}.${b.slice(5)}`, variant: "사업자-점" };
      },
      () => {
        const b = bizno();
        return { v: fw(`${b.slice(0, 3)}-${b.slice(3, 5)}-${b.slice(5)}`), variant: "사업자-전각숫자" };
      },
    ],
    ACCOUNT: [
      () => ({ v: acctParts().join("-"), variant: "계좌-하이픈" }),
      () => ({ v: acctParts().join(""), variant: "계좌-붙여쓰기" }),
      () => ({ v: acctParts().join(" "), variant: "계좌-띄어쓰기" }),
      () => ({ v: fw(acctParts().join("-")), variant: "계좌-전각숫자" }),
      () => ({ v: acctParts().join("–"), variant: "계좌-유니코드대시" }),
      () => {
        const p = acctParts();
        return { v: p.join("-").replace("-", " - "), variant: "계좌-구분자공백" };
      },
    ],
    CARD: [
      () => ({ v: card16().replace(/(\d{4})(?=\d)/g, "$1-"), variant: "카드-하이픈" }),
      () => ({ v: card16().replace(/(\d{4})(?=\d)/g, "$1 "), variant: "카드-띄어쓰기" }),
      () => ({ v: card16(), variant: "카드-붙여쓰기" }),
      () => {
        const a = amex();
        return { v: `${a.slice(0, 4)}-${a.slice(4, 10)}-${a.slice(10)}`, variant: "아멕스15자리" };
      },
      () => ({ v: card16().replace(/(\d{4})(?=\d)/g, "$1."), variant: "카드-점" }),
      () => ({ v: fw(card16().replace(/(\d{4})(?=\d)/g, "$1-")), variant: "카드-전각숫자" }),
    ],
    ADDRESS: [
      () => ({ v: `${pick(SIDO)} ${pick(ROADS)} ${int(1, 399)}`, variant: "도로명" }),
      () => ({ v: `${pick(SIDO)} ${pick(ROADS)} ${int(1, 399)}, ${int(101, 120)}동 ${int(1, 25)}0${int(1, 4)}호`, variant: "도로명+동호수" }),
      () => ({ v: `${pick(SIDO)} ${pick(DONGS)} ${int(1, 1999)}-${int(1, 99)}`, variant: "지번" }),
      () => ({ v: `${pick(DONGS)} ${int(1, 1999)}-${int(1, 99)} ${int(2, 9)}층`, variant: "동+지번(짧게)" }),
      () => ({ v: `(${pad(int(1000, 63999), 5)}) ${pick(SIDO)} ${pick(ROADS)} ${int(1, 399)}`, variant: "우편번호+도로명" }),
    ],
    EMAIL: [
      () => ({ v: `${pick(ROMAN)}${int(1, 99)}@${pick(DOMAINS)}`, variant: "이메일-보통" }),
      () => ({ v: `${pick(ROMAN)}.${pick(ROMAN)}@${pick(DOMAINS)}`.toUpperCase(), variant: "이메일-대문자" }),
      () => ({ v: `${pick(ROMAN)}${int(1, 99)}＠${pick(DOMAINS)}`, variant: "이메일-전각@" }),
      () => ({ v: `${pick(ROMAN)}${int(1, 99)} at ${pick(DOMAINS).replace(/\./g, " dot ")}`, variant: "이메일-at/dot풀어쓰기" }),
      () => ({ v: `${pick(ROMAN)}${int(1, 99)}(at)${pick(DOMAINS)}`, variant: "이메일-(at)" }),
      () => ({ v: `${pick(ROMAN)}${int(1, 99)} @ ${pick(DOMAINS)}`, variant: "이메일-@양쪽공백" }),
    ],
    PLATE: [
      () => ({ v: `${pad(int(10, 99), 2)}${pick(PLATE_H)} ${digits(4, true)}`, variant: "번호판-2자리" }),
      () => ({ v: `${int(100, 699)}${pick(PLATE_H)}${digits(4, true)}`, variant: "번호판-3자리붙여" }),
      () => ({ v: `${pick(["서울", "경기", "부산", "인천"])}${pad(int(10, 99), 2)}${pick(PLATE_H)}${digits(4, true)}`, variant: "번호판-지역명" }),
      () => ({ v: `${pick(["경기", "서울"])} ${pad(int(80, 97), 2)}바 ${digits(4, true)}`, variant: "번호판-영업용지역띄움" }),
      () => ({ v: `${pad(int(10, 99), 2)}${pick(PLATE_H)}-${digits(4, true)}`, variant: "번호판-하이픈" }),
      () => ({ v: `${pad(int(10, 99), 2)} ${pick(PLATE_H)}  ${digits(4, true)}`, variant: "번호판-두칸띄움" }),
    ],
  };

  // ── 종류별 문맥(앞·뒤 문장) ─────────────────────────────────
  type Ctx = [string, string];
  const CTX: Record<PiiKind, Ctx[]> = {
    NAME: [
      ["담당자 ", " 확인 부탁드립니다."],
      ["받는분: ", " / 내일 오전 도착"],
      ["", " 과장님께 전달해 주세요."],
      ["어제 ", "이 전화로 물량 변경을 요청했습니다."],
      ["예금주 ", ", 입금 확인 바랍니다."],
      ["", " 씨가 하차 담당입니다."],
      ["인수자(引受者) ", " 서명 받았음"],
      ["Contact: ", " (sales)"],
      ["오늘 상차는 ", "랑 같이 갑니다."],
      ["", "님 앞으로 세금계산서 발행"],
    ],
    PHONE: [
      ["연락처 ", " 로 전화 주세요."],
      ["Tel. ", ""],
      ["H.P ", " (기사님)"],
      ["도착 전에 ", "로 문자 부탁드립니다."],
      ["連絡處: ", ""],
      ["", " 번으로 연락 바람"],
      ["받는분 전화번호는 ", "입니다."],
    ],
    RRN: [
      ["주민등록번호 ", ""],
      ["생년월일·번호: ", " 확인"],
      ["외국인등록번호(外國人登錄番號) ", " 사본 첨부"],
      ["원천징수용 ", " 입니다"],
      ["", " 로 조회해 주세요."],
      ["ID no. ", ""],
    ],
    BIZNO: [
      ["사업자등록번호 ", ""],
      ["거래처 사업자번호는 ", "입니다."],
      ["", " 로 세금계산서 발행 바랍니다."],
      ["事業者番號 ", ""],
      ["Biz No. ", " (VAT)"],
    ],
    ACCOUNT: [
      ["입금 계좌 ", " 로 부탁드립니다."],
      ["%BANK% ", " 예금주 확인"],
      ["환불은 %BANK%은행 ", "으로 해 주세요."],
      ["", " 로 대금 송금 바랍니다."],
      ["Account: ", ""],
      ["계좌번호(口座番號) ", ""],
    ],
    CARD: [
      ["카드번호 ", " 로 결제 부탁"],
      ["", " 카드로 승인됐습니다."],
      ["법인카드 ", " 유효기간 12/28"],
      ["Card no: ", ""],
      ["결제수단 신용카드(", ")"],
    ],
    ADDRESS: [
      ["배송지 ", ""],
      ["주소: ", " 로 보내 주세요."],
      ["", " 앞에서 하차합니다."],
      ["상차지는 ", "이고 지게차 있습니다."],
      ["住所 ", ""],
      ["Address: ", ""],
    ],
    EMAIL: [
      ["이메일 ", " 로 견적서 보내 주세요."],
      ["e-mail: ", ""],
      ["", " 으로 회신 바랍니다."],
      ["세금계산서 받을 메일은 ", "입니다."],
    ],
    PLATE: [
      ["차량번호 ", " 기사님 배정"],
      ["", " 차량이 도착했습니다."],
      ["오늘 배차: ", " (5톤 윙바디)"],
      ["車輛番號 ", ""],
      ["입차 차량 ", " 확인 바람"],
    ],
  };

  // ── 개인정보가 아닌 비슷한 값(오탐 측정용) ──────────────────
  const DECOYS: Record<DecoyCat, Array<() => { v: string; variant: string; ctx: Ctx }>> = {
    AMOUNT: [
      () => ({ v: `${int(1, 99)},${pad(int(0, 999), 3)},${pad(int(0, 999), 3)}원`, variant: "쉼표금액", ctx: ["합계 ", " 입니다."] }),
      () => ({ v: `${int(1, 9)}${digits(6)}원`, variant: "붙인금액(7자리)", ctx: ["운임 ", " 청구"] }),
      () => ({ v: `${int(1, 9)}${digits(9)}원`, variant: "붙인금액(10자리)", ctx: ["연간 매출 ", " 기준"] }),
      () => ({ v: `${int(1, 9)}${digits(8)}00원`, variant: "붙인금액(11자리·둥근)", ctx: ["누계 ", ""] }),
      () => ({ v: `₩${int(1, 99)},${pad(int(0, 999), 3)},${pad(int(0, 999), 3)}`, variant: "원화기호", ctx: ["단가 ", ""] }),
      () => ({ v: `${int(1, 9)}${digits(9)} 원`, variant: "붙인금액(10자리·띄운 단위)", ctx: ["청구액 ", ""] }),
    ],
    ORDER_NO: [
      () => ({ v: `ORD-2026${pad(int(1, 12), 2)}${pad(int(1, 28), 2)}-${digits(4)}`, variant: "영문접두주문번호", ctx: ["주문 ", " 건 확인"] }),
      () => ({ v: `2026${pad(int(1, 12), 2)}${pad(int(1, 28), 2)}${digits(5)}`, variant: "날짜+일련(13자리)", ctx: ["주문번호 ", ""] }),
      () => ({ v: `${digits(10, true)}`, variant: "숫자10자리", ctx: ["주문 No. ", " 취소 요청"] }),
      () => ({ v: `${digits(12, true)}`, variant: "숫자12자리", ctx: ["접수번호 ", ""] }),
      () => ({ v: `2026-${pad(int(1, 12), 2)}${pad(int(1, 28), 2)}-${digits(6)}`, variant: "하이픈주문번호", ctx: ["발주번호 ", ""] }),
    ],
    TRACKING_NO: [
      () => ({ v: `${digits(4, true)}-${digits(4)}-${digits(4)}`, variant: "송장(4-4-4)", ctx: ["송장 ", " 출고"] }),
      () => ({ v: `${digits(12, true)}`, variant: "송장12자리", ctx: ["운송장번호 ", ""] }),
      () => ({ v: `${digits(10, true)}`, variant: "송장10자리", ctx: ["택배 ", " 조회"] }),
    ],
    DATE: [
      () => ({ v: `2026-${pad(int(1, 12), 2)}-${pad(int(1, 28), 2)}`, variant: "ISO날짜", ctx: ["납기 ", ""] }),
      () => ({ v: `2026.${pad(int(1, 12), 2)}.${pad(int(1, 28), 2)}`, variant: "점날짜", ctx: ["계약일 ", ""] }),
      () => ({ v: `2026${pad(int(1, 12), 2)}${pad(int(1, 28), 2)}`, variant: "8자리날짜", ctx: ["기준일 ", ""] }),
      () => ({ v: `2026년 ${int(1, 12)}월 ${int(1, 28)}일`, variant: "한글날짜", ctx: ["", " 입고"] }),
      () => ({ v: `${pad(int(1, 28), 2)}/${pad(int(1, 12), 2)}/2026`, variant: "슬래시날짜", ctx: ["Due ", ""] }),
    ],
    DATETIME: [
      () => ({ v: `2026${pad(int(1, 12), 2)}${pad(int(1, 28), 2)}${pad(int(0, 23), 2)}${pad(int(0, 59), 2)}${pad(int(0, 59), 2)}`, variant: "14자리일시", ctx: ["접수일시 ", ""] }),
      () => ({ v: `2026${pad(int(1, 12), 2)}${pad(int(1, 28), 2)}${pad(int(0, 23), 2)}${pad(int(0, 59), 2)}`, variant: "12자리일시", ctx: ["등록 ", ""] }),
      () => ({ v: `2026-${pad(int(1, 12), 2)}-${pad(int(1, 28), 2)} ${pad(int(0, 23), 2)}:${pad(int(0, 59), 2)}`, variant: "ISO일시", ctx: ["도착 ", ""] }),
    ],
    QTY: [
      () => ({ v: `${int(1, 9)},${pad(int(0, 999), 3)}kg`, variant: "무게", ctx: ["총중량 ", ""] }),
      () => ({ v: `${int(10, 999)}박스`, variant: "수량", ctx: ["", " 상차"] }),
      () => ({ v: `-${int(1, 25)}.${int(0, 9)}℃`, variant: "온도", ctx: ["보관온도 ", ""] }),
    ],
    PRODUCT_CODE: [
      () => ({ v: `880${digits(10)}`, variant: "바코드13자리", ctx: ["상품 바코드 ", ""] }),
      () => ({ v: `SKU-${digits(4)}-${digits(4)}`, variant: "SKU", ctx: ["", " 품절"] }),
      () => ({ v: `AB-${int(1000, 9999)}`, variant: "모델명", ctx: ["모델 ", ""] }),
    ],
    REP_PHONE: [
      () => ({ v: `${pick(["1588", "1577", "1644", "1661"])}-${digits(4)}`, variant: "대표번호", ctx: ["고객센터 ", ""] }),
    ],
    ZIP: [() => ({ v: pad(int(1000, 63999), 5), variant: "우편번호단독", ctx: ["우편번호 ", ""] })],
    WORD: [
      () => ({ v: "이름 변경 요청", variant: "업무문장", ctx: ["", "이 들어왔습니다."] }),
      () => ({ v: "담당 부서 확인", variant: "업무문장", ctx: ["", " 후 회신"] }),
      () => ({ v: "산업 현장", variant: "상호접미어같은낱말", ctx: ["", " 안전교육"] }),
      () => ({ v: "무역 수지", variant: "상호접미어같은낱말", ctx: ["이번 달 ", " 적자"] }),
      () => ({ v: "고객님", variant: "호칭만", ctx: ["", " 문의 감사합니다."] }),
      () => ({ v: "정상 처리", variant: "성씨로시작낱말", ctx: ["", "되었습니다."] }),
      () => ({ v: "한우 등심", variant: "성씨로시작낱말", ctx: ["", " 20kg 추가"] }),
      () => ({ v: "강남 센터", variant: "성씨로시작낱말", ctx: ["", " 입고 예정"] }),
      () => ({ v: "기사님", variant: "호칭만", ctx: ["", " 도착하셨나요?"] }),
      () => ({ v: "이사님", variant: "호칭만", ctx: ["", " 결재 대기"] }),
      () => ({ v: "가공 상회", variant: "상호접미어같은낱말", ctx: ["", " 지원 사업"] }),
    ],
  };
  const DECOY_CATS = Object.keys(DECOYS) as DecoyCat[];
  const decoy = (cat?: DecoyCat): Seg[] => {
    const c = cat ?? pick(DECOY_CATS);
    const d = pick(DECOYS[c])();
    return [d.ctx[0], { decoy: c, v: d.v, variant: d.variant }, d.ctx[1]];
  };

  const fill = (s: string): string => s.replace("%BANK%", pick(BANKS));
  const piiSegs = (kind: PiiKind, vi: number, ci: number): Seg[] => {
    const g = VARIANTS[kind][vi % VARIANTS[kind].length]!();
    const ctx = CTX[kind][ci % CTX[kind].length]!;
    return [fill(ctx[0]), { pii: kind, v: g.v, variant: g.variant }, fill(ctx[1])];
  };

  const out: Sample[] = [];
  const KINDS = Object.keys(VARIANTS) as PiiKind[];
  // 1) 종류별 단독 예문: 종류마다 36건(변형 × 문맥을 돌려 가며), 3건 중 1건은 비슷한 숫자 미끼를 함께 둔다.
  for (const kind of KINDS) {
    for (let i = 0; i < 36; i++) {
      const segs = piiSegs(kind, i, i * 7 + Math.floor(i / VARIANTS[kind].length));
      if (i % 3 === 2) segs.push(" / ", ...decoy());
      out.push({ id: `${kind}-${pad(i + 1, 2)}`, group: kind, segs });
    }
  }
  // 2) 여러 개인정보가 섞인 접수·메모 문장 30건
  for (let i = 0; i < 30; i++) {
    const ks = [pick(KINDS), pick(KINDS), pick(KINDS)];
    const segs: Seg[] = [];
    ks.forEach((k, j) => {
      if (j > 0) segs.push(pick([" ", ", ", "\n", " / "]));
      segs.push(...piiSegs(k, int(0, 20), int(0, 20)));
    });
    if (i % 2 === 0) segs.push(" ", ...decoy());
    out.push({ id: `MIXED-${pad(i + 1, 2)}`, group: "MIXED", segs });
  }
  // 3) 개인정보 없는 예문(미끼만) 90건: 분류마다 고르게
  for (let i = 0; i < 90; i++) {
    const segs: Seg[] = [...decoy(DECOY_CATS[i % DECOY_CATS.length])];
    if (i % 2 === 1) segs.push(" ", ...decoy());
    out.push({ id: `NONE-${pad(i + 1, 2)}`, group: "NONE", segs });
  }
  return out;
}

export function sampleText(s: Sample): string {
  return s.segs.map((x) => (typeof x === "string" ? x : x.v)).join("");
}
