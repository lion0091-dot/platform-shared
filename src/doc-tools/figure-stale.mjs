#!/usr/bin/env node
/**
 * 그림 변경 감지(figure-stale). Node 내장 모듈과 git 만 쓴다(의존성 0). 저장소를 읽기만 한다(아무것도 고치지 않는다).
 *
 *   node figure-stale.mjs --manifest FILE --repo DIR [--images-stale OUT [--stale-paths]]
 *                         [--docs GLOB ... --unregistered [--image-base DIR]] [--global-watch PATH ...] [--exit-zero]
 *
 * 매니페스트(JSON): 배열 `[{ id, file, route, role, seed, sources[], capturedCommit, note }]` 이거나
 *   `{ figures: [...], globalWatch: [경로...] }`. 기준 키는 그림 파일 경로(file)이다(id·file 중복은 오류).
 * 판정(항목마다 하나, 우선순위 누락 > 미확인 > 어긋남):
 *   누락         그림 파일이 저장소에 없다.
 *   미확인       capturedCommit 이 없거나 저장소에서 찾을 수 없다 / sources 가 비었거나 없는 파일이 있다.
 *   어긋남 후보  sources 가 capturedCommit 이후(작업 폴더 포함) git 에서 바뀌었다 — 바뀐 파일을 보여 준다.
 *   정상         건수만 출력한다.
 * 전역 감시(globalWatch 또는 --global-watch): 공용 문구 사전처럼 모든 화면에 영향을 주는 파일. 어떤 그림의 촬영 시점 이후 바뀌었으면
 *   «전체 재확인 권고» 한 행만 낸다(그림을 개별로 어긋남 처리하지 않는다).
 * 미등록 그림(--unregistered, --docs 필요): 문서의 `![](경로)`·`<img src>` 참조 중 매니페스트에 없는 그림을 목록으로 낸다.
 *   참조 경로는 기본으로 «그 문서가 있는 디렉터리» 기준이다. imageBase(매니페스트 최상위 `imageBase` 또는 --image-base, 저장소 기준 디렉터리)를
 *   주면 «지정한 디렉터리» 기준으로 해석한다(예: 모든 문서가 `images/…` 를 같은 폴더 기준으로 쓰는 경우). 앞이 `/` 인 경로는 항상 저장소 루트 기준이다.
 * images-stale 출력: 어긋남 후보 + 누락 그림의 파일 이름을 한 행에 하나씩(기본 이름만, --stale-paths 면 저장소 기준 경로).
 * 종료 코드: 0 = 목록 없음(또는 --exit-zero), 1 = 누락·미확인·어긋남·미등록 중 하나라도 있음, 2 = 사용법·매니페스트·git 오류.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listFiles, matchFiles, maskMarkdown } from "./doc-lint.mjs";

const posix = (p) => String(p).split(String.fromCharCode(92)).join("/").replace(/^\.\//, "");
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

function git(repo, args) {
  return execFileSync("git", ["-C", repo, "-c", "core.quotepath=false", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}
const gitOk = (repo, args) => {
  try {
    git(repo, args);
    return true;
  } catch {
    return false;
  }
};

/** 매니페스트 JSON 검증. { figures, globalWatch }. 잘못되면 Error. */
export function parseManifest(raw) {
  const figs = Array.isArray(raw) ? raw : isObj(raw) && Array.isArray(raw.figures) ? raw.figures : null;
  if (figs === null) throw new Error("매니페스트 오류: 배열이거나 figures 배열을 가진 객체여야 한다.");
  const watch = isObj(raw) && Array.isArray(raw.globalWatch) ? raw.globalWatch : [];
  if (!watch.every((w) => typeof w === "string" && w !== "")) throw new Error("매니페스트 오류: globalWatch 는 경로 문자열 배열이어야 한다.");
  const ids = new Set();
  const files = new Set();
  const figures = figs.map((x, i) => {
    if (!isObj(x) || typeof x.id !== "string" || x.id === "" || typeof x.file !== "string" || x.file === "") throw new Error(`매니페스트 오류: [${i}] 에 id·file 이 없다.`);
    const file = posix(x.file);
    if (ids.has(x.id)) throw new Error(`매니페스트 오류: id 중복 ${x.id}`);
    if (files.has(file)) throw new Error(`매니페스트 오류: 그림 파일 경로 중복 ${file}`);
    ids.add(x.id);
    files.add(file);
    const sources = Array.isArray(x.sources) && x.sources.every((s) => typeof s === "string" && s !== "") ? x.sources.map(posix) : null;
    return { id: x.id, file, sources, capturedCommit: typeof x.capturedCommit === "string" ? x.capturedCommit.trim() : "" };
  });
  const imageBase = isObj(raw) && typeof raw.imageBase === "string" && raw.imageBase !== "" ? trimSlash(posix(raw.imageBase)) : null;
  return { figures, globalWatch: watch.map(posix), imageBase };
}

const trimSlash = (p) => p.replace(/\/+$/, "");

/** 그림 참조 수집: 문서의 `![](경로)`·`<img src>` → { doc, line, path(저장소 기준) } */
export function collectRefs(repo, docGlobs, imageBase = null) {
  const refs = [];
  for (const doc of matchFiles(listFiles(repo), docGlobs)) {
    const text = readFileSync(path.join(repo, doc), "utf8");
    const lines = maskMarkdown(text, { keepLinks: true }).split("\n");
    const dir = imageBase !== null ? imageBase : path.posix.dirname(doc);
    lines.forEach((line, i) => {
      const found = [...line.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)/g)].map((m) => m[1]);
      found.push(...[...line.matchAll(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]));
      for (let src of found) {
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) continue;
        src = src.split(/[?#]/)[0];
        try {
          src = decodeURIComponent(src);
        } catch {
          /* 그대로 쓴다 */
        }
        const rel = src.startsWith("/") ? src.slice(1) : path.posix.normalize(path.posix.join(dir, src));
        refs.push({ doc, line: i + 1, path: rel });
      }
    });
  }
  return refs;
}

/** 검사 본체. { stale, unknown, missing, unregistered, globalChanged, ok, total } */
export function checkFigures({ manifest, repo, docs = [], unregistered = false, globalWatch = [], imageBase = null }) {
  if (!gitOk(repo, ["rev-parse", "--git-dir"])) throw new Error(`git 저장소가 아니다: ${repo}`);
  const res = { stale: [], unknown: [], missing: [], unregistered: [], globalChanged: null, ok: 0, total: manifest.figures.length };
  const known = new Set();
  const valid = [];
  for (const f of manifest.figures) {
    known.add(f.file);
    if (!existsSync(path.join(repo, f.file))) {
      res.missing.push({ id: f.id, file: f.file });
      continue;
    }
    const why = [];
    if (f.capturedCommit === "") why.push("capturedCommit 없음");
    else if (!gitOk(repo, ["cat-file", "-e", `${f.capturedCommit}^{commit}`])) why.push(`capturedCommit ${f.capturedCommit} 을 저장소에서 찾을 수 없음`);
    if (f.sources === null || f.sources.length === 0) why.push("sources 없음");
    else {
      const gone = f.sources.filter((s) => !existsSync(path.join(repo, s)));
      if (gone.length > 0) why.push(`sources 에 없는 파일: ${gone.join(", ")}`);
    }
    if (why.length > 0) {
      res.unknown.push({ id: f.id, file: f.file, why: why.join(" / ") });
      continue;
    }
    valid.push(f);
    const changed = git(repo, ["diff", "--name-only", f.capturedCommit, "--", ...f.sources]).split("\n").filter(Boolean);
    if (changed.length > 0) res.stale.push({ id: f.id, file: f.file, changed, commit: f.capturedCommit });
    else res.ok++;
  }
  const watch = [...new Set([...manifest.globalWatch, ...globalWatch.map(posix)])];
  if (watch.length > 0) {
    const changedWatch = new Set();
    const affected = new Set();
    for (const f of valid) {
      const changed = git(repo, ["diff", "--name-only", f.capturedCommit, "--", ...watch]).split("\n").filter(Boolean);
      if (changed.length > 0) affected.add(f.id);
      for (const c of changed) changedWatch.add(c);
    }
    if (changedWatch.size > 0) res.globalChanged = { files: [...changedWatch].sort(), figures: affected.size };
  }
  if (unregistered && docs.length > 0) {
    const seen = new Set();
    const base = imageBase !== null ? trimSlash(posix(imageBase)) : manifest.imageBase ?? null;
    for (const r of collectRefs(repo, docs, base)) {
      if (known.has(r.path) || seen.has(`${r.doc}:${r.path}`)) continue;
      seen.add(`${r.doc}:${r.path}`);
      res.unregistered.push(r);
    }
  }
  return res;
}

export function formatReport(res) {
  const out = [];
  if (res.stale.length > 0) {
    out.push(`[어긋남 후보] ${res.stale.length}건`);
    for (const s of res.stale) out.push(`  ${s.id}  ${s.file}  ← 바뀐 소스: ${s.changed.join(", ")}  (촬영 ${s.commit.slice(0, 7)})`);
  }
  if (res.unknown.length > 0) {
    out.push(`[미확인] ${res.unknown.length}건`);
    for (const u of res.unknown) out.push(`  ${u.id}  ${u.file}  ${u.why}`);
  }
  if (res.missing.length > 0) {
    out.push(`[누락] ${res.missing.length}건`);
    for (const m of res.missing) out.push(`  ${m.id}  ${m.file}`);
  }
  if (res.unregistered.length > 0) {
    out.push(`[미등록 그림] ${res.unregistered.length}건`);
    for (const r of res.unregistered) out.push(`  ${r.doc}:${r.line}  ${r.path}`);
  }
  if (res.globalChanged !== null) {
    out.push(`[전체 재확인 권고] 전역 감시 파일이 촬영 이후 바뀜: ${res.globalChanged.files.join(", ")} (영향 받을 수 있는 그림 ${res.globalChanged.figures}건, 개별 판정과 별개)`);
  }
  out.push(`figure-stale: 전체 ${res.total}건 중 정상 ${res.ok}건, 어긋남 후보 ${res.stale.length}건, 미확인 ${res.unknown.length}건, 누락 ${res.missing.length}건${res.unregistered.length > 0 ? `, 미등록 ${res.unregistered.length}건` : ""}`);
  return out;
}

const USAGE = "사용법: figure-stale --manifest 매니페스트.json --repo 저장소 [--images-stale 출력파일 [--stale-paths]] [--docs GLOB ... --unregistered [--image-base 디렉터리]] [--global-watch 경로 ...] [--exit-zero]";

export function parseArgs(argv) {
  const o = { manifest: null, repo: null, imagesStale: null, stalePaths: false, docs: [], unregistered: false, globalWatch: [], imageBase: null, exitZero: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--manifest") o.manifest = argv[++i];
    else if (a === "--repo") o.repo = argv[++i];
    else if (a === "--images-stale") o.imagesStale = argv[++i];
    else if (a === "--stale-paths") o.stalePaths = true;
    else if (a === "--docs") o.docs.push(argv[++i]);
    else if (a === "--unregistered") o.unregistered = true;
    else if (a === "--image-base") o.imageBase = argv[++i];
    else if (a === "--global-watch") o.globalWatch.push(argv[++i]);
    else if (a === "--exit-zero") o.exitZero = true;
    else throw new Error(`알 수 없는 인자: ${a}\n${USAGE}`);
  }
  if (!o.manifest || !o.repo) throw new Error(USAGE);
  if (o.unregistered && o.docs.length === 0) throw new Error(`--unregistered 는 --docs 가 필요하다.\n${USAGE}`);
  return o;
}

export function run(argv, io = {}) {
  const out = io.out ?? ((s) => process.stdout.write(`${s}\n`));
  const err = io.err ?? ((s) => process.stderr.write(`${s}\n`));
  try {
    const o = parseArgs(argv);
    const raw = JSON.parse(readFileSync(path.resolve(o.manifest), "utf8").replace(/^﻿/, ""));
    const repo = path.resolve(o.repo);
    const res = checkFigures({ manifest: parseManifest(raw), repo, docs: o.docs, unregistered: o.unregistered, globalWatch: o.globalWatch, imageBase: o.imageBase });
    for (const l of formatReport(res)) out(l);
    if (o.imagesStale !== null) {
      const names = [...res.stale, ...res.missing].map((x) => (o.stalePaths ? x.file : path.posix.basename(x.file)));
      writeFileSync(path.resolve(o.imagesStale), names.length > 0 ? `${[...new Set(names)].join("\n")}\n` : "", "utf8");
    }
    const listed = res.stale.length + res.unknown.length + res.missing.length + res.unregistered.length;
    return listed > 0 && !o.exitZero ? 1 : 0;
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return 2;
  }
}

const isMain = (() => {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return true;
  }
})();
if (isMain) process.exitCode = run(process.argv.slice(2));
