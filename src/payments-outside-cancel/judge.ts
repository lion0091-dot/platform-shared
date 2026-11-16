import { cancelEventKey } from "./helpers";
import type { NormalizedCancel, NormalizedPayment, OutsideCancelAppSide, OutsideCancelCore, OutsideCancelJudgement } from "./types";

const isMoney = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

const isDone = (c: NormalizedCancel): boolean => c.status == null || c.status === "DONE";

const EMPTY = { newCancels: [] as NormalizedCancel[], eventKeys: [] as string[], unkeyedCancels: 0 };

function newCancelInfo(toss: NormalizedPayment, known: ReadonlySet<string>) {
  const newCancels: NormalizedCancel[] = [];
  const eventKeys: string[] = [];
  const seen = new Set<string>();
  let unkeyedCancels = 0;

  for (const c of Array.isArray(toss.cancels) ? toss.cancels : []) {
    if (!c || !isDone(c)) continue;

    if (typeof c.providerCancelRef !== "string" || c.providerCancelRef.length === 0) {
      unkeyedCancels += 1;
      continue;
    }

    if (known.has(c.providerCancelRef) || seen.has(c.providerCancelRef)) continue;

    seen.add(c.providerCancelRef);
    newCancels.push(c);
    eventKeys.push(cancelEventKey(toss.providerPaymentRef, c.providerCancelRef));
  }

  return { newCancels, eventKeys, unkeyedCancels };
}

function core(toss: NormalizedPayment | null, app: OutsideCancelAppSide): OutsideCancelCore {
  if (!toss) return { verdict: "not_found" };

  if (toss.status === "PENDING_UNCONFIRMED" || toss.status === "FAILED") {
    return { verdict: "status_anomaly", status: toss.status, rawStatus: toss.rawStatus ?? null };
  }

  const tossCurrency = toss.currency ?? "KRW";

  if (!isMoney(toss.approvedAmount) || !isMoney(app.total)) {
    return { verdict: "amount_mismatch", tossTotal: Number(toss.approvedAmount), appTotal: Number(app.total), tossCurrency };
  }

  if (tossCurrency !== "KRW" || toss.approvedAmount !== app.total) {
    return { verdict: "amount_mismatch", tossTotal: toss.approvedAmount, appTotal: app.total, tossCurrency };
  }

  // PG 쪽 취소 누계: 어댑터 값 → 잔액 → 완료 취소 합 → CANCELED 면 총액. 승인 상태에서 아무 정보도 없으면 취소 0.
  const cancels = Array.isArray(toss.cancels) ? toss.cancels : [];
  let canceled: number | null = null;

  if (isMoney(toss.canceledTotal)) canceled = toss.canceledTotal;
  else if (isMoney(toss.balance)) canceled = toss.approvedAmount - toss.balance;
  else if (cancels.length > 0) canceled = cancels.filter((c) => c && isDone(c) && isMoney(c.amount)).reduce((s, c) => s + c.amount, 0);
  else if (toss.status === "CANCELED") canceled = toss.approvedAmount;
  else if (toss.status === "APPROVED") canceled = 0;

  if (canceled === null || canceled < 0) return { verdict: "unreadable" };

  const balance = isMoney(toss.balance) ? toss.balance : Math.max(toss.approvedAmount - canceled, 0);
  const full = toss.status === "CANCELED" || (toss.approvedAmount > 0 && canceled >= toss.approvedAmount);
  const appRefunded = isMoney(app.refunded) ? app.refunded : app.state === "refunded" ? app.total : 0;

  if (canceled > appRefunded) {
    return full
      ? { verdict: "external_full", unreflected: canceled - appRefunded, canceledTotal: canceled, balance }
      : { verdict: "external_partial", unreflected: canceled - appRefunded, canceledTotal: canceled, balance };
  }

  if (canceled < appRefunded) return { verdict: "app_ahead", diff: appRefunded - canceled, canceledTotal: canceled };

  return { verdict: "ok" };
}

/**
 * 토스 밖 취소(대시보드 직접 취소·부분 취소) 판정 — 순수 함수, 던지지 않는다(이상한 입력은 verdict 로 돌려준다).
 * toss 는 PG 중립 정규화 모양(null = 결제 없음), app 은 앱이 기록한 값. DB·네트워크·시계·환경변수를 읽지 않는다.
 * 앱은 이 결과로 «표시·알림»만 하고 결제·정산·장부 열을 자동으로 쓰지 않는다.
 * «전액 취소» 정의는 payments/status 의 isFullyCanceled 와 같다(CANCELED, 또는 취소 누계가 승인액 이상).
 */
export function judgeOutsideCancel(toss: NormalizedPayment | null, app: OutsideCancelAppSide): OutsideCancelJudgement {
  let c: OutsideCancelCore;

  try {
    c = core(toss, app);
  } catch {
    c = { verdict: "unreadable" };
  }

  if (!toss || c.verdict === "status_anomaly") return { ...c, ...EMPTY };

  try {
    return { ...c, ...newCancelInfo(toss, app.knownCancelKeys ?? new Set<string>()) };
  } catch {
    return { ...c, ...EMPTY };
  }
}

/**
 * 같은 실행에서 재조회한 두 판정이 «같은 결론»일 때만 확정한다(일시 오응답·앱 환불 진행과의 겹침 완화).
 * 비교는 verdict 와 금액 필드(newCancels·eventKeys 포함)이며, 어느 한쪽이 ok·not_found·status_anomaly·unreadable 이면 확정하지 않는다
 * (확정은 external_full·external_partial·app_ahead·amount_mismatch 처럼 사람이 볼 결론에만 의미가 있다).
 */
export function confirmStable(first: OutsideCancelJudgement, second: OutsideCancelJudgement): boolean {
  const confirmable = (j: OutsideCancelJudgement) => j.verdict === "external_full" || j.verdict === "external_partial" || j.verdict === "app_ahead" || j.verdict === "amount_mismatch";

  if (!confirmable(first) || !confirmable(second)) return false;

  return stable(first) === stable(second);
}

/** 키 순서와 무관한 직렬화(중첩 포함). */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;

    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(",")}}`;
  }

  return JSON.stringify(v) ?? "null";
}

const stable = (j: OutsideCancelJudgement): string => canon(j);
