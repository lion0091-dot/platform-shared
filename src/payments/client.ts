import { classifyTossError } from "./classify";
import { assertIdempotencyKey, cancelIdempotencyKey, confirmIdempotencyKey } from "./idempotency";
import { assertKeyMode } from "./keyMode";
import { assertOrderId } from "./orderId";
import { isFullyCanceled } from "./status";
import type { CancelInput, CancelOutcome, ConfirmInput, ConfirmOutcome, LookupOutcome, TossCancel, TossConfig, TossPayment, TossVirtualAccount } from "./types";

const BASE_URL = "https://api.tosspayments.com";
export const TOSS_TIMEOUT_MS = 15_000;
/** 호출 제한 시간 상한. 이보다 크면(Infinity·2^31 이상 포함, setTimeout 오버플로 시 즉시 중단되는 문제 방지) 이 값으로 줄인다. */
export const TOSS_TIMEOUT_MAX_MS = 120_000;

type Raw =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; network: true; code: "TIMEOUT" | "NETWORK" }
  | { ok: false; network: false; status: number; code: string; message: string };

/** Basic 인증 헤더: base64("<시크릿키>:") */
export function basicAuthHeader(secretKey: string): string {
  return `Basic ${btoa(`${secretKey}:`)}`;
}

/** paymentKey: 비어 있지 않은 보이는 ASCII 200자 이하(빈 값이면 URL 이 다른 엔드포인트가 된다) */
function assertPaymentKey(paymentKey: string): string {
  if (typeof paymentKey !== "string" || !/^[!-~]{1,200}$/.test(paymentKey)) throw new Error("INVALID_PAYMENT_KEY: paymentKey 는 1~200자의 보이는 ASCII 여야 한다.");

  return paymentKey;
}

async function call(cfg: TossConfig, method: "GET" | "POST", path: string, opts: { body?: unknown; idempotencyKey?: string } = {}): Promise<Raw> {
  if (!cfg.expectedMode) throw new Error("KEY_MODE_REQUIRED: expectedMode(\"test\"|\"live\") 를 지정해야 한다. 접두사 없는 모의 키는 \"unchecked\".");
  if (cfg.expectedMode !== "unchecked") assertKeyMode(cfg.secretKey, cfg.expectedMode);

  const timeoutMs = typeof cfg.timeoutMs === "number" && Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0 ? Math.min(cfg.timeoutMs, TOSS_TIMEOUT_MAX_MS) : TOSS_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  // 환경변수에 섞여 들어온 앞뒤 공백·개행은 지우고 보낸다(키 검사와 같은 기준)
  const headers: Record<string, string> = { Authorization: basicAuthHeader(cfg.secretKey.trim()) };

  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

  try {
    const res = await (cfg.fetch ?? fetch)(`${cfg.baseUrl ?? BASE_URL}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: ctrl.signal,
    });
    let parsed: unknown = null;

    try {
      const text = await res.text();
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }

    const obj = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;

    if (!res.ok) {
      return {
        ok: false,
        network: false,
        status: res.status,
        code: typeof obj.code === "string" ? obj.code : `HTTP_${res.status}`,
        message: (typeof obj.message === "string" ? obj.message : "결제 요청이 실패했습니다.").slice(0, 300),
      };
    }

    return { ok: true, body: obj };
  } catch (e) {
    return { ok: false, network: true, code: ctrl.signal.aborted || (e as { name?: string })?.name === "AbortError" ? "TIMEOUT" : "NETWORK" };
  } finally {
    clearTimeout(timer);
  }
}

const NET_MSG = "결제 서버 응답을 받지 못했습니다(결과 불명).";

function toPayment(b: Record<string, unknown>): TossPayment | null {
  if (typeof b.paymentKey !== "string" || typeof b.orderId !== "string" || typeof b.status !== "string" || typeof b.totalAmount !== "number") return null;

  const cancels: TossCancel[] = Array.isArray(b.cancels)
    ? b.cancels
        .filter((c): c is Record<string, unknown> => !!c && typeof c === "object" && typeof (c as Record<string, unknown>).cancelAmount === "number")
        .map((c) => ({
          cancelAmount: c.cancelAmount as number,
          cancelReason: typeof c.cancelReason === "string" ? c.cancelReason : "",
          canceledAt: typeof c.canceledAt === "string" ? c.canceledAt : null,
          transactionKey: typeof c.transactionKey === "string" ? c.transactionKey : null,
          cancelStatus: typeof c.cancelStatus === "string" ? c.cancelStatus : null,
        }))
    : [];

  const num = (v: unknown) => (typeof v === "number" ? v : null);
  const va = b.virtualAccount && typeof b.virtualAccount === "object" ? (b.virtualAccount as Record<string, unknown>) : null;
  const virtualAccount: TossVirtualAccount | null =
    va && typeof va.accountNumber === "string" && typeof va.bankCode === "string"
      ? {
          accountNumber: va.accountNumber,
          bankCode: va.bankCode,
          customerName: typeof va.customerName === "string" ? va.customerName : null,
          dueDate: typeof va.dueDate === "string" ? va.dueDate : null,
          refundStatus: typeof va.refundStatus === "string" ? va.refundStatus : null,
          expired: typeof va.expired === "boolean" ? va.expired : null,
        }
      : null;

  const payment: TossPayment = {
    currency: typeof b.currency === "string" ? b.currency : null,
    taxFreeAmount: num(b.taxFreeAmount),
    suppliedAmount: num(b.suppliedAmount),
    vat: num(b.vat),
    virtualAccount,
    paymentKey: b.paymentKey,
    orderId: b.orderId,
    status: b.status,
    totalAmount: b.totalAmount,
    method: typeof b.method === "string" ? b.method : "",
    approvedAt: typeof b.approvedAt === "string" ? b.approvedAt : null,
    balanceAmount: typeof b.balanceAmount === "number" ? b.balanceAmount : null,
    cancels,
  };

  // secret 은 열거되지 않게 둔다: 결과 객체를 로그·JSON 으로 찍거나 {...payment} 로 복사해도 새지 않는다. payment.secret 으로는 읽힌다(웹훅 대조용).
  Object.defineProperty(payment, "secret", { value: typeof b.secret === "string" ? b.secret : null, enumerable: false, writable: false, configurable: false });

  return payment;
}

/** 결제 승인 POST /v1/payments/confirm. 한 번만 호출한다(내부 재시도 없음). 불확실하면 uncertain/processing 을 돌려주니 앱이 조회·재호출한다. */
export async function confirmPayment(cfg: TossConfig, input: ConfirmInput): Promise<ConfirmOutcome> {
  const key = assertIdempotencyKey(input.idempotencyKey ?? confirmIdempotencyKey(input.orderId, input.paymentKey));

  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw new Error("INVALID_AMOUNT: 기대 금액은 양의 정수(원)여야 한다.");

  assertOrderId(input.orderId);
  assertPaymentKey(input.paymentKey);

  const r = await call(cfg, "POST", "/v1/payments/confirm", {
    idempotencyKey: key,
    body: { paymentKey: input.paymentKey, orderId: input.orderId, amount: input.amount },
  });

  if (!r.ok) {
    if (r.network) return { kind: "uncertain", code: r.code, message: NET_MSG };

    const c = classifyTossError("confirm", r.status, r.code);

    switch (c) {
      case "already_done":
        return { kind: "already_done", code: r.code };
      case "processing":
        return { kind: "processing", code: r.code };
      case "session_expired":
        return { kind: "session_expired", code: r.code, message: r.message };
      case "uncertain":
      case "retry_later":
        return { kind: "uncertain", code: r.code, message: r.message };
      default:
        return { kind: "fatal", code: r.code, message: r.message };
    }
  }

  const p = toPayment(r.body);

  if (!p) return { kind: "uncertain", code: "BAD_RESPONSE", message: "승인 응답 형식이 올바르지 않습니다." };
  // 가상계좌 발급: 같은 주문·금액이면 정상적인 입금 대기(승인 완료 아님)
  if (p.status === "WAITING_FOR_DEPOSIT" && p.orderId === input.orderId && p.paymentKey === input.paymentKey && p.totalAmount === input.amount) return { kind: "waiting_for_deposit", payment: p };
  // 상태를 먼저: DONE 이 아니면(IN_PROGRESS 등) 승인됐다고 단정할 수 없으니 불일치로 보지 않고 불확실(조회로 확정)
  if (p.status !== "DONE") return { kind: "uncertain", code: `STATUS_${p.status}`, message: "승인 응답의 상태가 DONE 이 아닙니다." };
  if (p.orderId !== input.orderId || p.paymentKey !== input.paymentKey) return { kind: "approved_mismatch", reason: "ORDER_MISMATCH", payment: p };
  if (p.totalAmount !== input.amount) return { kind: "approved_mismatch", reason: "AMOUNT_MISMATCH", payment: p };
  // 통화가 KRW 가 아니면 금액이 같아 보여도 같은 값이 아니다(응답에 통화가 없으면 KRW 로 본다). 토스에선 승인된 상태 → 취소 연계 대상
  if (p.currency && p.currency !== "KRW") return { kind: "approved_mismatch", reason: "CURRENCY_MISMATCH", payment: p };

  return { kind: "success", payment: p };
}

async function lookup(cfg: TossConfig, path: string): Promise<LookupOutcome> {
  const r = await call(cfg, "GET", path);

  if (!r.ok) {
    if (r.network) return { kind: "uncertain", code: r.code, message: NET_MSG };

    const c = classifyTossError("lookup", r.status, r.code);

    if (c === "not_found") return { kind: "not_found", code: r.code };
    if (c === "retry_later") return { kind: "retry_later", code: r.code };
    if (c === "uncertain" || c === "processing") return { kind: "uncertain", code: r.code, message: r.message };

    return { kind: "fatal", code: r.code, message: r.message };
  }

  const p = toPayment(r.body);

  return p ? { kind: "found", payment: p } : { kind: "uncertain", code: "BAD_RESPONSE", message: "조회 응답 형식이 올바르지 않습니다." };
}

/** 주문번호로 조회 GET /v1/payments/orders/{orderId} — paymentKey 를 모를 때(승인 응답을 못 받았을 때)의 복구 수단 */
export async function getPaymentByOrderId(cfg: TossConfig, orderId: string): Promise<LookupOutcome> {
  return lookup(cfg, `/v1/payments/orders/${encodeURIComponent(assertOrderId(orderId))}`);
}

/** paymentKey 로 조회 GET /v1/payments/{paymentKey} */
export async function getPayment(cfg: TossConfig, paymentKey: string): Promise<LookupOutcome> {
  return lookup(cfg, `/v1/payments/${encodeURIComponent(assertPaymentKey(paymentKey))}`);
}

/** 앱이 게이트웨이처럼 쓰기 위한 묶음(설정을 한 번만 넘긴다). lookupByOrderId 포함. */
export function createTossClient(cfg: TossConfig) {
  return {
    confirm: (input: ConfirmInput) => confirmPayment(cfg, input),
    lookupByOrderId: (orderId: string) => getPaymentByOrderId(cfg, orderId),
    lookup: (paymentKey: string) => getPayment(cfg, paymentKey),
    cancel: (input: CancelInput) => cancelPayment(cfg, input),
    cancelApprovedMismatch: (outcome: Extract<ConfirmOutcome, { kind: "approved_mismatch" }>) => cancelApprovedMismatch(cfg, outcome),
  };
}

/** 결제 취소 POST /v1/payments/{paymentKey}/cancel. ALREADY_CANCELED/ALREADY_REFUND 는 paymentKey 조회로 CANCELED 를 확인하면 canceled(alreadyCanceled) 로 돌려준다. */
export async function cancelPayment(cfg: TossConfig, input: CancelInput): Promise<CancelOutcome> {
  const key = assertIdempotencyKey(input.idempotencyKey);

  assertPaymentKey(input.paymentKey);

  if (typeof input.cancelReason !== "string" || input.cancelReason.trim().length === 0) throw new Error("INVALID_CANCEL_REASON: 취소 사유는 비어 있을 수 없다.");

  const body: Record<string, unknown> = { cancelReason: [...input.cancelReason].slice(0, 200).join("") };

  if (input.taxFreeAmount !== undefined) {
    if (input.cancelAmount === undefined) throw new Error("INVALID_TAX_FREE: 면세 금액은 부분 취소(cancelAmount 지정)에만 쓴다.");
    if (!Number.isSafeInteger(input.taxFreeAmount) || input.taxFreeAmount < 0 || input.taxFreeAmount > input.cancelAmount) throw new Error("INVALID_TAX_FREE: 면세 금액은 0 이상 취소 금액 이하의 정수(원)여야 한다.");

    body.taxFreeAmount = input.taxFreeAmount;
  }

  const acct = input.refundReceiveAccount;

  if (acct) {
    if (typeof acct.bank !== "string" || acct.bank.length === 0 || !/^\d{1,20}$/.test(acct.accountNumber ?? "") || typeof acct.holderName !== "string" || acct.holderName.length === 0 || acct.holderName.length > 60) {
      throw new Error("INVALID_REFUND_ACCOUNT: 은행 코드, 숫자만 20자 이하 계좌번호, 60자 이하 예금주가 필요하다.");
    }

    body.refundReceiveAccount = { bank: acct.bank, accountNumber: acct.accountNumber, holderName: acct.holderName };
  }

  if (input.cancelAmount !== undefined) {
    if (!Number.isSafeInteger(input.cancelAmount) || input.cancelAmount <= 0) throw new Error("INVALID_AMOUNT: 취소 금액은 양의 정수(원)여야 한다.");

    body.cancelAmount = input.cancelAmount;

    const t = input.alreadyCanceledTotal;

    if (typeof t !== "number" || !Number.isSafeInteger(t) || t < 0) throw new Error("INVALID_CANCELED_TOTAL: 부분 취소에는 요청 직전 취소 누계(alreadyCanceledTotal)가 필수다.");
  }

  const r = await call(cfg, "POST", `/v1/payments/${encodeURIComponent(input.paymentKey)}/cancel`, { idempotencyKey: key, body });

  if (!r.ok) {
    if (r.network) return { kind: "uncertain", code: r.code, message: NET_MSG };

    const c = classifyTossError("cancel", r.status, r.code);

    if (c === "already_canceled") {
      const l = await getPayment(cfg, input.paymentKey);

      return l.kind === "found" && isFullyCanceled(l.payment)
        ? { kind: "canceled", payment: l.payment, alreadyCanceled: true }
        : { kind: "uncertain", code: r.code, message: "이미 취소됐다는 응답이지만 조회로 취소 완료를 확인하지 못했습니다." };
    }

    switch (c) {
      case "processing":
        return { kind: "processing", code: r.code };
      case "retry_later":
        return { kind: "retry_later", code: r.code };
      case "uncertain":
        return { kind: "uncertain", code: r.code, message: r.message };
      case "not_cancelable":
        return { kind: "not_cancelable", code: r.code, message: r.message };
      default:
        return { kind: "fatal", code: r.code, message: r.message };
    }
  }

  const p = toPayment(r.body);

  if (p && p.paymentKey === input.paymentKey && (p.status === "CANCELED" || p.status === "PARTIAL_CANCELED")) {
    if (input.cancelAmount === undefined) {
      // 전액 요청: CANCELED, 또는 잔액 0 인 PARTIAL_CANCELED(토스는 부분 취소로 0 이 된 경우 이 상태로 남김)
      if (isFullyCanceled(p)) return { kind: "canceled", payment: p, alreadyCanceled: false };
    } else {
      // 부분 취소: 같은 키 재사용으로 토스가 첫 응답을 그대로 돌려준 경우(실제 환불 없음)를 걸러낸다 — 취소 누계가 이번 금액만큼 늘었어야 한다.
      const expected = input.alreadyCanceledTotal! + input.cancelAmount;
      const sum = p.cancels.reduce((s, c) => s + c.cancelAmount, 0);
      const byBalance = p.balanceAmount === null ? null : p.totalAmount - p.balanceAmount;
      const ok = (p.cancels.length > 0 || byBalance !== null) && (p.cancels.length === 0 || sum === expected) && (byBalance === null || byBalance === expected);

      if (ok) return { kind: "canceled", payment: p, alreadyCanceled: false };

      return { kind: "uncertain", code: "CANCEL_NOT_APPLIED", message: "취소 응답의 취소 누계가 요청 금액만큼 늘지 않았습니다(같은 키의 이전 응답일 수 있음). 조회로 확인하세요." };
    }
  }

  return { kind: "uncertain", code: "BAD_RESPONSE", message: "취소 응답의 상태를 확인하지 못했습니다." };
}

/**
 * confirm 이 approved_mismatch(토스에선 승인됨)를 돌려준 결제를 전액 취소한다. 표준 취소 키(cancelIdempotencyKey 전액)를 써서 다른 경로의 취소와 한 번만 처리되게 한다.
 * 호출 여부(자동/사람 확인 후)는 앱이 정한다 — 이 함수는 호출 방법만 통일한다. 결과 kind 는 cancelPayment 와 같다.
 */
export function cancelApprovedMismatch(cfg: TossConfig, outcome: Extract<ConfirmOutcome, { kind: "approved_mismatch" }>, idempotencyKey?: string): Promise<CancelOutcome> {
  return cancelPayment(cfg, {
    paymentKey: outcome.payment.paymentKey,
    cancelReason: `주문·금액 불일치 승인 취소(${outcome.reason})`,
    idempotencyKey: idempotencyKey ?? cancelIdempotencyKey({ paymentKey: outcome.payment.paymentKey }),
  });
}
