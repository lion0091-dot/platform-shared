import { describe, expect, it } from "vitest";
import { AI_CONTRACT_VERSION, AI_RPC_CONTRACT, checkRpcContract } from "./contract";
import { AI_RPC_DEFAULTS, type AiRpcKey } from "./types";

// 시험용 합성 SQL(실제 마이그 아님). 계약 표(AI_RPC_CONTRACT)로부터 정의·GRANT 문을 만든다.
const SQL_TYPES: Record<string, string> = {
  p_actor: "uuid", p_tenant: "uuid", p_ciphertext: "text", p_hint: "text", p_verified: "boolean", p_reason: "text", p_confirm: "text DEFAULT NULL",
  p_enabled: "boolean", p_calls: "integer", p_tokens: "bigint", p_provider: "text", p_status: "text", p_code: "text DEFAULT NULL", p_reserved: "bigint",
  p_input: "bigint", p_output: "bigint", p_cache: "bigint", p_failed: "boolean DEFAULT false", p_off: "boolean",
};
function build(opts: { rename?: Partial<Record<AiRpcKey, string>>; skip?: AiRpcKey[]; mutate?: (key: AiRpcKey, def: string) => string; grants?: (key: AiRpcKey, name: string, aud: string) => string } = {}): string {
  const out: string[] = ["-- CREATE FUNCTION public.commented_out(p_x uuid) RETURNS void  (주석은 무시되어야 한다)"];
  for (const key of Object.keys(AI_RPC_DEFAULTS) as AiRpcKey[]) {
    if (opts.skip?.includes(key)) continue;
    const spec = AI_RPC_CONTRACT[key];
    const name = opts.rename?.[key] ?? AI_RPC_DEFAULTS[key];
    const params = spec.params.map((p) => `${p} ${SQL_TYPES[p]}`).join(", ");
    let def = `CREATE FUNCTION public.${name}(${params}) RETURNS ${spec.returns}\nLANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN RETURN NULL; END; $$;`;
    if (opts.mutate) def = opts.mutate(key, def);
    out.push(def);
    const types = spec.params.map((p) => SQL_TYPES[p].split(" ")[0]).join(", ");
    const role = spec.audience === "service" ? "service_role" : "authenticated";
    out.push(opts.grants ? opts.grants(key, name, spec.audience) : `GRANT EXECUTE ON FUNCTION public.${name}(${types}) TO ${role};`);
  }
  return out.join("\n");
}

describe("checkRpcContract", () => {
  it("계약대로면 통과(버전 1)", () => {
    const r = checkRpcContract(build());
    expect(r).toEqual({ ok: true, version: AI_CONTRACT_VERSION, problems: [] });
    expect(AI_CONTRACT_VERSION).toBe(1);
  });
  it("함수 누락을 찾는다", () => {
    const r = checkRpcContract(build({ skip: ["record", "companyStatus"] }));
    expect(r.problems.map((p) => [p.rpc, p.code])).toEqual([["record", "MISSING_FUNCTION"], ["companyStatus", "MISSING_FUNCTION"]]);
  });
  it("인자 이름·순서가 다르면 PARAMS_MISMATCH", () => {
    const r = checkRpcContract(build({ mutate: (k, d) => (k === "reserve" ? d.replace("p_tenant uuid, p_provider text", "p_provider text, p_tenant uuid") : d) }));
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatchObject({ rpc: "reserve", code: "PARAMS_MISMATCH" });
  });
  it("인자 개수가 다르면(v1 record 에 인자 추가) PARAMS_MISMATCH", () => {
    const r = checkRpcContract(build({ mutate: (k, d) => (k === "record" ? d.replace("p_failed boolean DEFAULT false", "p_failed boolean DEFAULT false, p_feature text DEFAULT NULL") : d) }));
    expect(r.problems[0]).toMatchObject({ rpc: "record", code: "PARAMS_MISMATCH" });
  });
  it("반환 종류가 다르면 RETURNS_MISMATCH", () => {
    const r = checkRpcContract(build({ mutate: (k, d) => (k === "keyRevoke" ? d.replace("RETURNS boolean", "RETURNS void") : d) }));
    expect(r.problems).toEqual([expect.objectContaining({ rpc: "keyRevoke", code: "RETURNS_MISMATCH" })]);
  });
  it("service 함수를 anon·authenticated·PUBLIC 에 열면 FORBIDDEN_GRANT, service_role GRANT 가 없으면 MISSING_GRANT", () => {
    const bad = checkRpcContract(build({ grants: (k, n) => (k === "cipher" ? `GRANT EXECUTE ON FUNCTION public.${n}(text) TO service_role, authenticated;` : `GRANT EXECUTE ON FUNCTION public.${n}(x) TO service_role;`) }));
    expect(bad.problems.map((p) => [p.rpc, p.code])).toContainEqual(["cipher", "FORBIDDEN_GRANT"]);
    const miss = checkRpcContract(build({ grants: (k, n, aud) => (k === "keyMark" ? "" : `GRANT EXECUTE ON FUNCTION public.${n}(x) TO ${aud === "service" ? "service_role" : "authenticated"};`) }));
    expect(miss.problems).toEqual([expect.objectContaining({ rpc: "keyMark", code: "MISSING_GRANT" })]);
  });
  it("owner 함수는 authenticated GRANT 필요, anon·PUBLIC 은 금지", () => {
    const r = checkRpcContract(build({ grants: (k, n, aud) => (k === "companyStatus" ? `GRANT EXECUTE ON FUNCTION public.${n}(uuid) TO anon;` : `GRANT EXECUTE ON FUNCTION public.${n}(x) TO ${aud === "service" ? "service_role" : "authenticated"};`) }));
    expect(r.problems.map((p) => p.code).sort()).toEqual(["FORBIDDEN_GRANT", "MISSING_GRANT"]);
  });
  it("rpcNames 덮어쓰기(미트 식 이름)를 따른다", () => {
    const names = { reserve: "ai_reserve", record: "ai_record" };
    expect(checkRpcContract(build({ rename: names }), names).ok).toBe(true);
    expect(checkRpcContract(build({ rename: names })).ok).toBe(false); // 기본 이름으로는 못 찾는다
  });
  it("CREATE OR REPLACE 로 다시 정의하면 마지막 정의를 기준으로 한다", () => {
    const sql = build({ mutate: (k, d) => (k === "keyStatus" ? d.replace("CREATE FUNCTION", "CREATE FUNCTION") + "\n" + d.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION").replace("p_actor uuid", "p_who uuid") : d) });
    expect(checkRpcContract(sql).problems[0]).toMatchObject({ rpc: "keyStatus", code: "PARAMS_MISMATCH" });
  });
  it("대소문자·따옴표·schema 표기·IN 키워드 차이는 허용", () => {
    const sql = build({ mutate: (k, d) => (k === "cipher" ? d.replace("CREATE FUNCTION public.platform_ai_cipher(p_provider text)", 'create or replace function "public"."platform_ai_cipher"(IN p_provider text)').replace("RETURNS text", "returns TEXT") : d) });
    expect(checkRpcContract(sql).ok).toBe(true);
  });
  it("주석 안의 정의는 정의로 보지 않는다", () => {
    const sql = build({ skip: ["reserve"] }) + "\n/* CREATE FUNCTION public.platform_ai_reserve(p_tenant uuid, p_provider text, p_calls integer, p_tokens bigint) RETURNS jsonb */";
    expect(checkRpcContract(sql).problems[0]).toMatchObject({ rpc: "reserve", code: "MISSING_FUNCTION" });
  });
  it("잘못된 rpcNames 는 예외", () => {
    expect(() => checkRpcContract("", { reserve: "x; drop" })).toThrow();
  });
});
