/**
 * RPC 계약 v1 정적 검사(DB 에 접속하지 않는다). 앱이 자기 마이그 SQL 텍스트를 넣으면 함수명·인자명(순서)·반환 종류·GRANT 를
 * 설계서 §4A 와 대조한다. 순수 문자열 처리라 클라이언트·CI 어디서나 돈다(node:crypto 없음).
 */
import { AI_RPC_DEFAULTS, resolveRpcNames, type AiRpcKey, type AiRpcNames } from "./types";

export const AI_CONTRACT_VERSION = 1;

interface Spec {
  params: readonly string[];
  returns: string;
  /** service: service_role 전용(anon·authenticated 에 GRANT 금지), owner: authenticated 에 GRANT. */
  audience: "service" | "owner";
}

export const AI_RPC_CONTRACT: Readonly<Record<AiRpcKey, Spec>> = {
  keySave: { params: ["p_actor", "p_ciphertext", "p_hint", "p_verified", "p_reason", "p_confirm"], returns: "jsonb", audience: "service" },
  keyRevoke: { params: ["p_actor", "p_reason", "p_confirm"], returns: "boolean", audience: "service" },
  keySetEnabled: { params: ["p_actor", "p_enabled", "p_reason"], returns: "text", audience: "service" },
  setCap: { params: ["p_actor", "p_calls", "p_tokens", "p_reason"], returns: "void", audience: "service" },
  keyStatus: { params: ["p_actor"], returns: "jsonb", audience: "service" },
  companySet: { params: ["p_actor", "p_tenant", "p_enabled", "p_calls", "p_tokens", "p_reason", "p_confirm"], returns: "void", audience: "service" },
  companyOverview: { params: ["p_actor", "p_tenant"], returns: "jsonb", audience: "service" },
  companySwitch: { params: ["p_actor", "p_tenant", "p_enabled", "p_reason", "p_confirm"], returns: "boolean", audience: "service" },
  companyList: { params: ["p_actor"], returns: "jsonb", audience: "service" },
  cipher: { params: ["p_provider"], returns: "text", audience: "service" },
  keyMark: { params: ["p_provider", "p_status", "p_code"], returns: "text", audience: "service" },
  reserve: { params: ["p_tenant", "p_provider", "p_calls", "p_tokens"], returns: "jsonb", audience: "service" },
  record: { params: ["p_tenant", "p_provider", "p_reserved", "p_input", "p_output", "p_cache", "p_failed"], returns: "void", audience: "service" },
  companyStatus: { params: ["p_tenant"], returns: "jsonb", audience: "owner" },
  companySetOwnerOff: { params: ["p_tenant", "p_off"], returns: "boolean", audience: "owner" },
  companySetLimits: { params: ["p_tenant", "p_calls", "p_tokens"], returns: "void", audience: "owner" },
};

export interface ContractProblem {
  rpc: AiRpcKey;
  name: string;
  code: "MISSING_FUNCTION" | "PARAMS_MISMATCH" | "RETURNS_MISMATCH" | "MISSING_GRANT" | "FORBIDDEN_GRANT";
  detail: string;
}
export interface ContractReport {
  ok: boolean;
  version: number;
  problems: ContractProblem[];
}

function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/** 괄호 깊이 0 의 쉼표로 인자를 나눈다(DEFAULT 안의 괄호 보호). */
function splitParams(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim() !== "") out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

interface Parsed {
  params: string[];
  returns: string;
}

function parseFunctions(sql: string): Map<string, Parsed[]> {
  const out = new Map<string, Parsed[]>();
  const re = /create\s+(?:or\s+replace\s+)?function\s+(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    let i = re.lastIndex;
    let depth = 1;
    while (i < sql.length && depth > 0) {
      const ch = sql[i++];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
    const list = sql.slice(re.lastIndex, i - 1);
    const rest = /^\s*returns\s+([a-z_][a-z0-9_]*)/i.exec(sql.slice(i));
    const params = splitParams(list).map((p) => p.replace(/^(?:in|out|inout|variadic)\s+/i, "").split(/\s+/)[0].toLowerCase());
    const arr = out.get(m[1].toLowerCase()) ?? [];
    arr.push({ params, returns: (rest?.[1] ?? "").toLowerCase() });
    out.set(m[1].toLowerCase(), arr);
  }
  return out;
}

/** GRANT/REVOKE 문에서 «함수명 → 부여 대상 역할 집합»을 모은다(대소문자 무시, 인자 목록은 무시). */
function parseGrants(sql: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const re = /grant\s+execute\s+on\s+function\s+(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?\s*\([^)]*\)\s+to\s+([^;]+);/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    const set = out.get(m[1].toLowerCase()) ?? new Set<string>();
    for (const r of m[2].split(",")) set.add(r.trim().replace(/"/g, "").toLowerCase());
    out.set(m[1].toLowerCase(), set);
  }
  return out;
}

/**
 * @param sqlText 앱 마이그 SQL(여러 파일을 이어 붙여도 된다).
 * @param rpcNames 앱이 덮어쓴 RPC 이름(없으면 기본값).
 * 같은 함수가 여러 번 정의되면(CREATE OR REPLACE 로 갱신) 마지막 정의를 기준으로 한다.
 */
export function checkRpcContract(sqlText: string, rpcNames?: Partial<AiRpcNames>): ContractReport {
  const names = resolveRpcNames(rpcNames);
  const sql = stripComments(sqlText);
  const fns = parseFunctions(sql);
  const grants = parseGrants(sql);
  const problems: ContractProblem[] = [];

  for (const key of Object.keys(AI_RPC_DEFAULTS) as AiRpcKey[]) {
    const spec = AI_RPC_CONTRACT[key];
    const name = names[key].toLowerCase();
    const defs = fns.get(name);
    if (!defs) {
      problems.push({ rpc: key, name, code: "MISSING_FUNCTION", detail: "function not found" });
      continue;
    }
    const def = defs[defs.length - 1];
    if (def.params.join(",") !== spec.params.join(",")) {
      problems.push({ rpc: key, name, code: "PARAMS_MISMATCH", detail: `expected (${spec.params.join(", ")}) got (${def.params.join(", ")})` });
    }
    if (def.returns !== spec.returns) {
      problems.push({ rpc: key, name, code: "RETURNS_MISMATCH", detail: `expected ${spec.returns} got ${def.returns || "?"}` });
    }
    const roles = grants.get(name) ?? new Set<string>();
    if (spec.audience === "service") {
      if (!roles.has("service_role")) problems.push({ rpc: key, name, code: "MISSING_GRANT", detail: "no GRANT EXECUTE to service_role" });
      for (const bad of ["public", "anon", "authenticated"]) {
        if (roles.has(bad)) problems.push({ rpc: key, name, code: "FORBIDDEN_GRANT", detail: `GRANT EXECUTE to ${bad} is not allowed` });
      }
    } else {
      if (!roles.has("authenticated")) problems.push({ rpc: key, name, code: "MISSING_GRANT", detail: "no GRANT EXECUTE to authenticated" });
      for (const bad of ["public", "anon"]) {
        if (roles.has(bad)) problems.push({ rpc: key, name, code: "FORBIDDEN_GRANT", detail: `GRANT EXECUTE to ${bad} is not allowed` });
      }
    }
  }
  return { ok: problems.length === 0, version: AI_CONTRACT_VERSION, problems };
}
