/**
 * 가시 범위·답글·승격·전이 판정(순수 함수). 최종 강제는 앱의 서버 액션과 DB(RPC·RLS)이며,
 * 이 함수는 세 앱이 같은 규칙을 쓰게 하는 계약이자 시험 기준이다.
 * 테넌트 일치(sameTenant)는 앱이 계산해 넘긴다 — 넘기지 않으면(거짓) 열람·답글·승격 모두 거부한다.
 */
import {
  BOARD_ERRORS,
  BOARD_TIER2_CATEGORIES,
  type BoardActorSide,
  type BoardAuthorKind,
  type BoardReplyVisibility,
  type BoardStatus,
  type BoardTier,
  type BoardTier2Status,
  type BoardViewerKind,
} from "./codes";
import { detectPii, type PiiKind } from "./pii";

export interface BoardViewer {
  viewerKind: BoardViewerKind;
  /** 그 글의 작성자 본인인가 */
  isAuthor?: boolean;
  /** 글의 테넌트 = 보는 사람의 테넌트인가 (PLATFORM 은 무시) */
  sameTenant?: boolean;
}

/** 글을 볼 수 있는가. 일반 사용자는 자기 글(1층)만, 직원은 자기 테넌트 전부, 플랫폼은 2층만. */
export function canView(post: { tier: BoardTier }, viewer: BoardViewer): boolean {
  switch (viewer.viewerKind) {
    case "USER":
      return post.tier === 1 && viewer.isAuthor === true && viewer.sameTenant === true;
    case "STAFF":
      return viewer.sameTenant === true;
    case "PLATFORM":
      return post.tier === 2;
    default:
      return false;
  }
}

/** 답글을 볼 수 있는가(답글 가시성 3종). 글 자체를 볼 수 있어야 한다. */
export function canViewReply(
  reply: { visibility: BoardReplyVisibility },
  post: { tier: BoardTier },
  viewer: BoardViewer,
): boolean {
  if (!canView(post, viewer)) {
    return false;
  }

  switch (reply.visibility) {
    case "TENANT_ONLY":
      return viewer.viewerKind === "STAFF";
    case "AUTHOR":
      return viewer.viewerKind === "STAFF" || (viewer.viewerKind === "USER" && post.tier === 1);
    case "PLATFORM":
      return post.tier === 2 && (viewer.viewerKind === "STAFF" || viewer.viewerKind === "PLATFORM");
    default:
      return false;
  }
}

/** 답글을 달 수 있는가. 종결(DECLINED)된 2층 글은 답글 불가(재문의는 새 글). */
export function canReply(post: { tier: BoardTier; status?: BoardStatus }, actor: BoardViewer): boolean {
  if (!canView(post, actor)) {
    return false;
  }

  if (post.tier === 1) {
    // 직원, 그리고 일반 사용자는 자기 글에만(canView 가 이미 보장)
    return actor.viewerKind === "STAFF" || actor.viewerKind === "USER";
  }

  if (post.status === "DECLINED") {
    return false;
  }

  return actor.viewerKind === "STAFF" || actor.viewerKind === "PLATFORM";
}

/** 그 사람이 이 글에 달 수 있는 답글 가시성. 답글 불가면 빈 배열. */
export function allowedReplyVisibilities(
  post: { tier: BoardTier; status?: BoardStatus },
  actor: BoardViewer,
): BoardReplyVisibility[] {
  if (!canReply(post, actor)) {
    return [];
  }

  if (post.tier === 1) {
    return actor.viewerKind === "STAFF" ? ["AUTHOR", "TENANT_ONLY"] : ["AUTHOR"];
  }

  return ["PLATFORM"];
}

/** 1층 글을 승격할 수 있는가. 승격 권한(hasEscalateRole)은 앱이 「대표·경리급」으로 판정해 넘긴다. */
export function canEscalate(
  post: { tier: BoardTier; escalated?: boolean },
  actor: BoardViewer & { hasEscalateRole?: boolean },
): boolean {
  return (
    post.tier === 1 &&
    post.escalated !== true &&
    actor.viewerKind === "STAFF" &&
    actor.sameTenant === true &&
    actor.hasEscalateRole === true
  );
}

/**
 * 2층 전이표. NONE→RECEIVED(승격)와 DONE→RECEIVED(재오픈)는 승격 권한자(hasEscalateRole)만.
 * 되돌림 없음: 승격은 한 방향, DECLINED 는 끝(재문의는 새 글).
 */
export function canTransition(
  from: BoardStatus,
  to: BoardTier2Status,
  actorSide: BoardActorSide,
  hasEscalateRole = false,
): boolean {
  if (actorSide === "TENANT") {
    if (from === "NONE" && to === "RECEIVED") {
      return hasEscalateRole;
    }
    if (from === "DONE" && to === "RECEIVED") {
      return hasEscalateRole;
    }
    return from === "NEED_INFO" && to === "RECEIVED";
  }

  if (from === "RECEIVED") {
    return to === "IN_PROGRESS" || to === "NEED_INFO" || to === "DONE" || to === "DECLINED";
  }
  if (from === "IN_PROGRESS") {
    return to === "NEED_INFO" || to === "DONE" || to === "DECLINED";
  }
  return false;
}

/** 사유(답글)가 필수인 전이 목적지. */
export function requiresReason(to: BoardTier2Status): boolean {
  return to === "DECLINED" || to === "NEED_INFO";
}

export interface EscalationInput {
  hasEscalateRole: boolean;
  /** 「개인정보 없음 확인」 체크 */
  privacyConfirmed: boolean;
  category: string;
  title: string;
  body: string;
  /** 승격 사유 */
  reason: string;
}

export type EscalationResult =
  | { ok: true }
  | { ok: false; errors: string[]; pii?: PiiKind[] };

/** 승격 직전 검증: 권한·분류·확인 체크·사유·본문 개인정보 재검사. 걸린 종류만 알려 주고 값은 되돌리지 않는다. */
export function validateEscalation(input: EscalationInput): EscalationResult {
  const errors: string[] = [];

  if (!input.hasEscalateRole) {
    errors.push(BOARD_ERRORS.NOT_AUTHORIZED);
  }
  if (!(BOARD_TIER2_CATEGORIES as readonly string[]).includes(input.category)) {
    errors.push(BOARD_ERRORS.INVALID_CATEGORY);
  }
  if (!input.privacyConfirmed) {
    errors.push(BOARD_ERRORS.PRIVACY_NOT_CONFIRMED);
  }
  if (input.title.trim().length === 0 || input.body.trim().length === 0) {
    errors.push(BOARD_ERRORS.EMPTY_CONTENT);
  }

  const reason = input.reason.trim();
  if (reason.length < 1 || reason.length > 500) {
    errors.push(BOARD_ERRORS.REASON_REQUIRED);
  }

  const pii = Array.from(new Set([...detectPii(input.title), ...detectPii(input.body)]));
  if (pii.length > 0) {
    errors.push(BOARD_ERRORS.PII_DETECTED);
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors, ...(pii.length > 0 ? { pii } : {}) };
}

/**
 * 「직원 답을 기다리는 건」(합산 수신함·배지 기준, 결정 #33): 1층 글에 답이 없거나, 마지막 답글 작성자가 직원이 아니면 참.
 * 종료·숨김 글 제외와 2층 제외는 호출하는 쪽 조건. 2층은 항상 거짓.
 */
export function needsStaffReply(post: {
  tier: BoardTier;
  lastReplyAuthorKind: BoardAuthorKind | null;
}): boolean {
  if (post.tier !== 1) {
    return false;
  }
  return post.lastReplyAuthorKind !== "STAFF";
}
