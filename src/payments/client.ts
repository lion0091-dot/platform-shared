import { classifyTossError } from "./classify";
import { assertIdempotencyKey, confirmIdempotencyKey } from "./idempotency";
import { assertOrderId } from "./orderId";
import type { CancelInput,CancelOutcome, ConfirmInput, ConfirmOutcome, LookupOutcome, TossCancel, TossConfig, TossPayment } from "./types";

const BASE_URL = "https://api.tosspayments.com";
export const TOSS_TIMEOUT_MS = 15_000;

type Raw =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; network: true; code: "TIMEOUT" | "NETWORK" }
  | { ok: false; network: false; status: number; code: string; message: string };

/** Basic 인증 헤더: base64("<시크릿키>:") */
export function basicAuthHeader(secretKey: string): string {
  return `Basic ${btoa(`${secretKey}:`)}`;
}

async function call(cfg: TossConfig, method: "GET" | "POST", path: string, opts: { body?: unknown; idempotencyKey?: string } = {}): Promise<Raw> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? TOSS_TIMEOUT_MS);
  const headers: Record<string, string> = { Authorization: basicAuthHeader(cfg.secretKey) };

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

  return {
    paymentKey: b.paymentKey,
    orderId: b.orderId,
    status: b.status,
    totalAmount: b.totalAmount,
    method: typeof b.method === "string" ? b.method : "",
    approvedAt: typeof b.approvedAt === "string" ? b.approvedAt : null,
    balanceAmount: typeof b.balanceAmount === "number" ? b.balanceAmount : null,
    cancels,
  };
}

/** 결제 승인 POST /v1/payments/confirm. 한 번만 호출한다(내부 재시도 없음). 불확실하면 uncertain/processing 을 돌려주니 앱이 조회·재호출한다. */
export async function confirmPayment(cfg: TossConfig, input: ConfirmInput): Promise<ConfirmOutcome> {
  const key = assertIdempotencyKey(input.idempotencyKey ?? confirmIdempotencyKey(input.orderId, input.paymentKey));

  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw new Error("INVALID_AMOUNT: 기대 금액은 양의 정수(원)여야 한다.");

  assertOrderId(input.orderId);

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
        return { kind: "session_expired", code: r.code };
      case "uncertain":
      case "retry_later":
        return { kind: "uncertain", code: r.code, message: r.message };
      default:
        return { kind: "fatal", code: r.code, message: r.message };
    }
  }

  const p = toPayment(r.body);

  if (!p) return { kind: "uncertain", code: "BAD_RESPONSE", message: "승인 응답 형식이 올바르지 않습니다." };
  // 상태를 먼저: DONE 이 아니면(IN_PROGRESS 등) 승인됐다고 단정할 수 없으니 불일치로 보지 않고 불확실(조회로 확정)
  if (p.status !== "DONE") return { kind: "uncertain", code: `STATUS_${p.status}`, message: "승인 응답의 상태가 DONE 이 아닙니다." };
  if (p.orderId !== input.orderId || p.paymentKey !== input.paymentKey) return { kind: "approved_mismatch", reason: "ORDER_MISMATCH", payment: p };
  if (p.totalAmount !== input.amount) return { kind: "approved_mismatch", reason: "AMOUNT_MISMATCH", payment: p };

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
export function getPayment(cfg: TossConfig, paymentKey: string): Promise<LookupOutcome> {
  return lookup(cfg, `/v1/payments/${encodeURIComponent(paymentKey)}`);
}

/** 앱이 게이트웨이처럼 쓰기 위한 묶음(설정을 한 번만 넘긴다). lookupByOrderId 포함. */
export function createTossClient(cfg: TossConfig) {
  return {
    confirm: (input: ConfirmInput) => confirmPayment(cfg, input),
    lookupByOrderId: (orderId: string) => getPaymentByOrderId(cfg, orderId),
    lookup: (paymentKey: string) => getPayment(cfg, paymentKey),
    cancel: (input: CancelInput) => cancelPayment(cfg, input),
  };
}

/** 결제 취소 POST /v1/payments/{paymentKey}/cancel. ALREADY_CANCELED/ALREADY_REFUND 는 paymentKey 조회로 CANCELED 를 확인하면 canceled(alreadyCanceled) 로 돌려준다. */
export async function cancelPayment(cfg: TossConfig, input: CancelInput): Promise<CancelOutcome> {
  const key = assertIdempotencyKey(input.idempotencyKey);
  const body: Record<string, unknown> = { cancelReason: input.cancelReason.slice(0, 200) };

  if (input.cancelAmount !== undefined) {
    if (!Number.isSafeInteger(input.cancelAmount) || input.cancelAmount <= 0) throw new Error("INVALID_AMOUNT: 취소 금액은 양의 정수(원)여야 한다.");

    body.cancelAmount = input.cancelAmount;
  }

  const r = await call(cfg, "POST", `/v1/payments/${encodeURIComponent(input.paymentKey)}/cancel`, { idempotencyKey: key, body });

  if (!r.ok) {
    if (r.network) return { kind: "uncertain", code: r.code, message: NET_MSG };

    const c = classifyTossError("cancel", r.status, r.code);

    if (c === "already_canceled") {
      const l = await getPayment(cfg, input.paymentKey);

      return l.kind === "found" && l.payment.status === "CANCELED"
        ? { kind: "canceled", payment: l.payment, alreadyCanceled: true }
        : { kind: "uncertain", code: r.code, message: "이미 취소됐다는 응답이지만 조회로 CANCELED 를 확인하지 못했습니다." };
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

  if (p && p.paymentKey === input.paymentKey && (p.status === "CANCELED" || p.status === "PARTIAL_CANCELED")) return { kind: "canceled", payment: p, alreadyCanceled: false };

  return { kind: "uncertain", code: "BAD_RESPONSE", message: "취소 응답의 상태를 확인하지 못했습니다." };
}
