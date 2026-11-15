/**
 * 토스 밖 취소(대시보드 직접 취소·부분 취소) 감지 — 공용 타입(층 1). 이 모듈은 PG 이름·키·업체를 모른다.
 * 입력은 «PG 중립 정규화 모양»뿐이며, 토스 원문(TossPayment)은 `fromTossPayment` 가 이 모양으로 바꾼다.
 */

export type NormalizedStatus = "APPROVED" | "CANCELED" | "PARTIAL_CANCELED" | "PENDING_UNCONFIRMED" | "FAILED";

export interface NormalizedCancel {
  /** 건별 고유 키(토스 transactionKey). 없으면 null — 멱등 키를 만들 수 없는 건으로 센다. */
  providerCancelRef: string | null;
  /** 정수 원 */
  amount: number;
  /** PG 원문 취소 상태(감사용). null 이면 완료로 본다(토스 규칙: DONE 만 합계에 넣고 값 없음도 완료). */
  status: string | null;
  canceledAt: string | null;
}

export interface NormalizedPayment {
  status: NormalizedStatus;
  /** PG 원문 상태(감사·표시용). 판정 근거는 아니다. */
  rawStatus?: string | null;
  /** 승인 총액(정수 원) */
  approvedAmount: number;
  /** 통화. 생략·null 이면 KRW 로 본다. */
  currency?: string | null;
  /** PG 쪽 취소 누계(앱 기록과 무관). 구할 수 없으면 null. 완료된 취소만 합친 값이어야 한다. */
  canceledTotal: number | null;
  /** 취소 후 남은 금액. 응답에 없으면 null. */
  balance: number | null;
  /** 결제 식별자(토스 paymentKey). 해시·앞자리만 로그에 쓴다. */
  providerPaymentRef: string;
  cancels: NormalizedCancel[];
}

export interface OutsideCancelAppSide {
  /** 앱이 기록한 결제 총액(정수 원) */
  total: number;
  /** 앱이 «앱 환불로 기록한 누계». 부분 환불 누계 열이 없으면 null. */
  refunded: number | null;
  /** 앱이 환불 이력에 이미 남긴 PG 취소 건 키(transactionKey) 집합 */
  knownCancelKeys: ReadonlySet<string>;
  /** paid = 결제됨 · refunded = 앱이 전액 환불로 기록 · other = 그 밖(미결제·취소 등) */
  state: "paid" | "refunded" | "other";
}

export type OutsideCancelVerdictCode =
  | "ok"
  | "external_full"
  | "external_partial"
  | "app_ahead"
  | "amount_mismatch"
  | "status_anomaly"
  | "not_found"
  | "unreadable";

export type OutsideCancelCore =
  | { verdict: "ok" }
  /** unreflected = PG 취소 누계 − 앱 환불 누계(원) */
  | { verdict: "external_full"; unreflected: number; canceledTotal: number; balance: number }
  | { verdict: "external_partial"; unreflected: number; canceledTotal: number; balance: number }
  /** diff = 앱 환불 누계 − PG 취소 누계(원) */
  | { verdict: "app_ahead"; diff: number; canceledTotal: number }
  | { verdict: "amount_mismatch"; tossTotal: number; appTotal: number; tossCurrency: string }
  | { verdict: "status_anomaly"; status: NormalizedStatus; rawStatus: string | null }
  | { verdict: "not_found" }
  | { verdict: "unreadable" };

export type OutsideCancelJudgement = OutsideCancelCore & {
  /** 완료된 취소 중 앱이 아직 모르는 건(transactionKey 있음). 앱 환불 이력에 건별로 남길 때 쓴다. */
  newCancels: NormalizedCancel[];
  /** newCancels 와 같은 순서의 멱등 키 `cncl:<결제키 SHA-256>:<transactionKey 앞 100자>` */
  eventKeys: string[];
  /** 완료된 취소 중 건별 키가 없어 멱등 키를 만들 수 없는 건 수 */
  unkeyedCancels: number;
};
