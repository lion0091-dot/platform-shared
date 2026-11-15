import { judgeOutsideCancel } from "./judge";
import type { NormalizedPayment, OutsideCancelAppSide, OutsideCancelJudgement, OutsideCancelVerdictCode } from "./types";

/** 사례 입력(순수 데이터). 앱 쪽 집합은 JSON 으로 다룰 수 있게 배열로 둔다. */
export interface OutsideCancelCaseInput {
  app: Omit<OutsideCancelAppSide, "knownCancelKeys"> & { knownCancelKeys: readonly string[] };
  toss: NormalizedPayment | null;
}

/** 판정 결과를 비교용으로 줄인 값. amount = external_* 는 unreflected, app_ahead 는 diff, 나머지는 null. */
export interface OutsideCancelOutcome {
  verdict: OutsideCancelVerdictCode;
  amount: number | null;
  newCancelRefs: string[];
}

export interface OutsideCancelCase extends OutsideCancelCaseInput {
  name: string;
  expect: OutsideCancelOutcome;
}

export function summarizeJudgement(j: OutsideCancelJudgement): OutsideCancelOutcome {
  const amount = j.verdict === "external_full" || j.verdict === "external_partial" ? j.unreflected : j.verdict === "app_ahead" ? j.diff : null;

  return { verdict: j.verdict, amount, newCancelRefs: j.newCancels.map((c) => c.providerCancelRef ?? "") };
}

/** 쉐어드 판정 함수를 기준 어댑터로 돌린 결과. 앱 어댑터는 같은 입력으로 같은 요약을 돌려줘야 한다. */
export function referenceOutsideCancelAdapter(input: OutsideCancelCaseInput): OutsideCancelOutcome {
  return summarizeJudgement(judgeOutsideCancel(input.toss, { ...input.app, knownCancelKeys: new Set(input.app.knownCancelKeys) }));
}

const TOTAL = 50_000;
const REF = "pay_sample_0001";

const approved = (over: Partial<NormalizedPayment> = {}): NormalizedPayment => ({
  status: "APPROVED",
  rawStatus: "DONE",
  approvedAmount: TOTAL,
  currency: "KRW",
  canceledTotal: 0,
  balance: TOTAL,
  providerPaymentRef: REF,
  cancels: [],
  ...over,
});

const cancel = (ref: string | null, amount: number, status: string | null = "DONE") => ({ providerCancelRef: ref, amount, status, canceledAt: "2026-11-01T10:00:00+09:00" });

const paid = (refunded: number | null, known: string[] = [], state: OutsideCancelAppSide["state"] = "paid") => ({ total: TOTAL, refunded, knownCancelKeys: known, state });

/**
 * 공통 사례표(14건). 두 앱이 자기 어댑터(실제 DB 쿼리 변환·토스 원문 변환 코드)로 이 표를 통과해야 «같은 규칙»이다.
 * 사례를 고치거나 지우지 않는다 — 규칙이 바뀌어야 하면 사례를 «추가»하고 합의한 뒤에만 함수를 고친다.
 */
export const OUTSIDE_CANCEL_CASES: readonly OutsideCancelCase[] = [
  { name: "①토스 DONE·앱 paid → ok", app: paid(0), toss: approved(), expect: { verdict: "ok", amount: null, newCancelRefs: [] } },
  {
    name: "②토스 CANCELED·앱 환불 0 → external_full(미반영=총액)",
    app: paid(0),
    toss: approved({ status: "CANCELED", rawStatus: "CANCELED", canceledTotal: TOTAL, balance: 0, cancels: [cancel("t1", TOTAL)] }),
    expect: { verdict: "external_full", amount: TOTAL, newCancelRefs: ["t1"] },
  },
  {
    name: "③토스 CANCELED·앱 환불 완료(건 기록됨) → ok",
    app: paid(TOTAL, ["t1"], "refunded"),
    toss: approved({ status: "CANCELED", rawStatus: "CANCELED", canceledTotal: TOTAL, balance: 0, cancels: [cancel("t1", TOTAL)] }),
    expect: { verdict: "ok", amount: null, newCancelRefs: [] },
  },
  {
    name: "④토스 PARTIAL_CANCELED 잔액 0(실측, 전액 취소로 정규화) → external_full",
    app: paid(null),
    toss: approved({ status: "CANCELED", rawStatus: "PARTIAL_CANCELED", canceledTotal: TOTAL, balance: 0, cancels: [cancel("t1", 30_000), cancel("t2", 20_000)] }),
    expect: { verdict: "external_full", amount: TOTAL, newCancelRefs: ["t1", "t2"] },
  },
  {
    name: "⑤부분 취소 누계 > 앱 환불 → external_partial(차액)",
    app: paid(5_000, ["t0"]),
    toss: approved({ status: "PARTIAL_CANCELED", rawStatus: "PARTIAL_CANCELED", canceledTotal: 20_000, balance: 30_000, cancels: [cancel("t0", 5_000), cancel("t1", 15_000)] }),
    expect: { verdict: "external_partial", amount: 15_000, newCancelRefs: ["t1"] },
  },
  {
    name: "⑥앱 환불 > 토스 취소 → app_ahead(차액)",
    app: paid(30_000),
    toss: approved({ status: "PARTIAL_CANCELED", rawStatus: "PARTIAL_CANCELED", canceledTotal: 10_000, balance: 40_000, cancels: [cancel("t1", 10_000)] }),
    expect: { verdict: "app_ahead", amount: 20_000, newCancelRefs: ["t1"] },
  },
  { name: "⑦통화 USD → amount_mismatch", app: paid(0), toss: approved({ currency: "USD" }), expect: { verdict: "amount_mismatch", amount: null, newCancelRefs: [] } },
  {
    name: "⑧balance 없음·cancels 합으로 판정 → external_partial",
    app: paid(0),
    toss: approved({ status: "PARTIAL_CANCELED", rawStatus: "PARTIAL_CANCELED", canceledTotal: null, balance: null, cancels: [cancel("t1", 10_000), cancel("t2", 5_000)] }),
    expect: { verdict: "external_partial", amount: 15_000, newCancelRefs: ["t1", "t2"] },
  },
  {
    name: "⑨balance·cancels 둘 다 없는 PARTIAL_CANCELED → unreadable",
    app: paid(0),
    toss: approved({ status: "PARTIAL_CANCELED", rawStatus: "PARTIAL_CANCELED", canceledTotal: null, balance: null, cancels: [] }),
    expect: { verdict: "unreadable", amount: null, newCancelRefs: [] },
  },
  {
    name: "⑩진행 중 취소는 합계·새 건에서 제외 → external_partial(완료분만)",
    app: paid(0),
    toss: approved({ status: "PARTIAL_CANCELED", rawStatus: "PARTIAL_CANCELED", canceledTotal: null, balance: null, cancels: [cancel("t1", 10_000), cancel("t2", 7_000, "IN_PROGRESS")] }),
    expect: { verdict: "external_partial", amount: 10_000, newCancelRefs: ["t1"] },
  },
  {
    name: "⑪ABORTED·EXPIRED(승인 아님) → status_anomaly",
    app: paid(0),
    toss: approved({ status: "FAILED", rawStatus: "ABORTED", canceledTotal: null, balance: null }),
    expect: { verdict: "status_anomaly", amount: null, newCancelRefs: [] },
  },
  { name: "⑫토스에 결제 없음 → not_found", app: paid(0), toss: null, expect: { verdict: "not_found", amount: null, newCancelRefs: [] } },
  {
    name: "⑬같은 transactionKey 재관측 → 새 건 없음(멱등)",
    app: paid(10_000, ["t1"]),
    toss: approved({ status: "PARTIAL_CANCELED", rawStatus: "PARTIAL_CANCELED", canceledTotal: 10_000, balance: 40_000, cancels: [cancel("t1", 10_000)] }),
    expect: { verdict: "ok", amount: null, newCancelRefs: [] },
  },
  {
    name: "⑭회귀: 잔액 = 총액·취소 없음 → ok (미트 현행 balance>=total 과 같은 결과)",
    app: paid(0),
    toss: approved({ canceledTotal: null, balance: TOTAL, cancels: [] }),
    expect: { verdict: "ok", amount: null, newCancelRefs: [] },
  },
];

export interface OutsideCancelConformanceFailure {
  name: string;
  expected: OutsideCancelOutcome;
  actual: OutsideCancelOutcome | { error: string };
}

/**
 * 앱 어댑터를 사례표에 통과시킨다. adapter 는 «앱 기록 + 정규화된 토스 응답» 을 받아 판정 요약을 돌려준다
 * (앱이 자기 DB 값→app 모양, 토스 원문→정규화 변환을 거친 뒤 judgeOutsideCancel 을 부르는 경로 전체).
 * 실패 목록이 비어 있어야 통과. 던지지 않는다.
 */
export function runOutsideCancelConformance(adapter: (input: OutsideCancelCaseInput) => OutsideCancelOutcome, cases: readonly OutsideCancelCase[] = OUTSIDE_CANCEL_CASES): OutsideCancelConformanceFailure[] {
  const failures: OutsideCancelConformanceFailure[] = [];

  for (const c of cases) {
    try {
      const actual = adapter({ app: c.app, toss: c.toss });
      const same = actual.verdict === c.expect.verdict && actual.amount === c.expect.amount && JSON.stringify(actual.newCancelRefs) === JSON.stringify(c.expect.newCancelRefs);

      if (!same) failures.push({ name: c.name, expected: c.expect, actual });
    } catch (e) {
      failures.push({ name: c.name, expected: c.expect, actual: { error: e instanceof Error ? e.message : String(e) } });
    }
  }

  return failures;
}
