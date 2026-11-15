/**
 * 동시성·경합 시나리오 6종(순수 데이터). 판정·멱등 키·재조회 확정은 쉐어드 시험이 증명하고,
 * DB 경합(행 수·알림 1회)은 각 앱 통합 시험이 이 표의 `assert` 를 그대로 단언한다. 쉐어드는 DB 를 읽지 않는다.
 */
export interface OutsideCancelScenario {
  id: string;
  name: string;
  /** 시험이 만들 상황 */
  given: string;
  /** 앱 통합 시험이 단언할 결과(전부 참이어야 통과) */
  assert: readonly string[];
}

export const OUTSIDE_CANCEL_SCENARIOS: readonly OutsideCancelScenario[] = [
  {
    id: "S1",
    name: "웹훅과 크론이 같은 결제를 동시에 처리",
    given: "토스에서 전액 취소된 결제 1건을 웹훅 경로와 크론 경로가 같은 순간에 처리한다.",
    assert: ["감지 기록 행은 1개", "환불 이력은 취소 건(transactionKey)마다 1줄(멱등 키 cncl:<해시>:<키>)", "알림 선점(claim)은 하나만 true → 알림 1회", "최종 상태는 어느 경로가 먼저여도 같다"],
  },
  {
    id: "S2",
    name: "웹훅 같은 이벤트 N회 재전송(토스 재시도)",
    given: "같은 PAYMENT_STATUS_CHANGED 본문을 N(≥5)회 보낸다.",
    assert: ["모든 응답이 같다", "감지 기록 행·환불 이력 줄·알림 횟수가 1회 처리 때와 같다"],
  },
  {
    id: "S3",
    name: "크론 두 실행이 겹침",
    given: "크론을 동시에 2번 시작한다.",
    assert: ["알림 1회·감지 행 1개", "지는 쪽은 아무것도 쓰지 않고 끝난다"],
  },
  {
    id: "S4",
    name: "앱 환불 진행 중에 감지가 겹침",
    given: "앱이 환불을 기록하는 중(최근 15분 안 갱신)에 감지가 돈다.",
    assert: ["방금 앱이 기록한 환불을 외부 취소로 오인하지 않는다(stillCurrent·재조회 확정 confirmStable·최근 갱신 유예 15분)", "감지 기록·알림이 생기지 않는다"],
  },
  {
    id: "S5",
    name: "알림 발송 실패",
    given: "알림 발송이 실패한다.",
    assert: ["알림 선점이 해제된다", "다음 실행이 재시도한다 — 알림 누락 0, 중복 0"],
  },
  {
    id: "S6",
    name: "토스 429·5xx·시간 초과",
    given: "토스 조회가 일부 건에서 429·5xx·시간 초과로 실패한다.",
    assert: ["그 건만 판정 보류(감지·알림 없음)", "실행은 계속되고 부분 실행으로 보고된다", "다음 실행에서 회복한다"],
  },
];
