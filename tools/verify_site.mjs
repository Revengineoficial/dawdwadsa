#!/usr/bin/env node
/**
 * Static site-graph verifier for the ps4hen GitHub Pages build.
 *
 * Models browser resolution and checks, without a browser:
 *   1. every ES module import (static + dynamic) resolves to a real file,
 *      resolved relative to the importing module;
 *   2. every multi-importer module is imported under ONE identical specifier,
 *      so the engine yields a single instance (int64 is instanceof-checked
 *      across jb.js / mem.js / hx1400_port.js -- split instances break it);
 *   3. every document-relative reference (new Worker, <script src>, root
 *      redirect target) resolves relative to the HTML that serves it;
 *   4. every firmware row in ps4_offsets.js points at a kpatch/payload file
 *      that exists in the tree that serves it -- except KNOWN_MISSING blobs
 *      that were never built (jb.js fails closed on them with
 *      KPATCH-FETCH-404 -> kpatch-preconditions FAIL);
 *   5. every cache.appcache entry exists and its hash equals the bytes that
 *      will be served (the git blob -- not the autocrlf worktree copy).
 *
 * Usage: node tools/verify_site.mjs    (exit 0 clean / 1 regression)
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Referenced by ps4_offsets.js but never shipped in this repo. Each firmware
// holding one fails closed at the kpatch-preconditions gate.
const KNOWN_MISSING = new Set([
  "patches/1100.bin", // 11.00: blob never built
  "patches/1150.bin", // 11.50: blob never built
  "patches/1200.bin", // 12.00 + 12.02: blob never built
  "patches/1250.bin", // 12.50 + 12.52: blob never built
  "patches/1300.bin", // 13.00: placeholder replaced by 1302.bin (ps4_offsets.js)
]);

let passCount = 0;
let failCount = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    passCount++;
    return true;
  }
  failCount++;
  failures.push(name + (detail ? "  -- " + detail : ""));
  return false;
}

// Served bytes = the git blob (LF-normalized), not the autocrlf worktree copy.
const blobCache = new Map();
function servedBytes(relPath) {
  const key = relPath.split(sep).join("/");
  if (blobCache.has(key)) return blobCache.get(key);
  let buf;
  try {
    buf = execFileSync("git", ["show", ":" + key], {
      cwd: ROOT,
      maxBuffer: 1 << 26,
    });
  } catch {
    buf = readFileSync(join(ROOT, key)); // new/untracked file
  }
  blobCache.set(key, buf);
  return buf;
}
const sha256hex = (buf) => createHash("sha256").update(buf).digest("hex");
const stripQuery = (u) => u.replace(/\?.*$/, "");
const norm = (p) => posix.normalize(p.split(sep).join("/"));

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(rel(p));
  }
  return out;
}
const rel = (p) => relative(ROOT, p).split(sep).join("/");

const allFiles = new Set(walk(ROOT));
const jsFiles = [...allFiles].filter((f) => f.endsWith(".js")).sort();
const htmlFiles = [...allFiles].filter((f) => f.endsWith(".html")).sort();

// ---------- 1. module import graph (module-relative semantics) ----------
const edges = new Map(); // resolved file -> Set of exact specifiers
for (const f of jsFiles) {
  const src = readFileSync(join(ROOT, f), "utf8");
  const dir = norm(dirname(f));
  const specs = [];
  for (const m of src.matchAll(/from\s*["']([^"']+)["']/g)) specs.push(m[1]);
  for (const m of src.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)) specs.push(m[1]);
  for (const m of src.matchAll(/\bimport\s*["']([^"']+)["']/g)) specs.push(m[1]);
  for (const spec of specs) {
    if (!spec.startsWith(".")) {
      check("module:" + f, false, "non-relative specifier " + spec);
      continue;
    }
    const target = norm(posix.join(dir, stripQuery(spec)));
    check(
      "module:" + f + " -> " + spec,
      allFiles.has(target),
      "missing " + target,
    );
    if (!edges.has(target)) edges.set(target, new Set());
    edges.get(target).add(spec);
  }
}

// ---------- 2. one specifier per multi-importer module ----------
for (const [target, specs] of edges) {
  check(
    "single-specifier:" + target,
    specs.size === 1,
    specs.size > 1
      ? [...specs].join(" | ") + " -> split module instances (instanceof breaks)"
      : "",
  );
}

// ---------- 3. html-driven document-relative references ----------
const RE_SCRIPT_SRC = /<script[^>]*\bsrc=["']([^"']+)["']/g;
const RE_MODULE_IMPORT = /\bimport\s*["']([^"']+)["']/g;
const RE_WORKER = /new\s+Worker\s*\(\s*["']([^"']+)["']/g;
const RE_REDIRECT =
  /(?:location\.replace\(\s*|url=)(["']?)([^"'>\s]+?\.[a-z]+(?:\?[^"'>\s]*)?)\1/gi;

for (const h of htmlFiles) {
  const src = servedBytes(h).toString("utf8");
  const htmlDir = norm(dirname(h));

  for (const m of src.matchAll(RE_SCRIPT_SRC)) {
    const spec = m[1];
    if (/^(https?:|data:)/.test(spec)) continue;
    const target = norm(posix.join(htmlDir, stripQuery(spec)));
    check("script:" + h + " -> " + spec, allFiles.has(target), "missing " + target);
  }
  for (const m of src.matchAll(RE_REDIRECT)) {
    const spec = m[2];
    if (/^(https?:|data:)/.test(spec)) continue;
    const target = norm(posix.join(htmlDir, stripQuery(spec)));
    check("redirect:" + h + " -> " + spec, allFiles.has(target), "missing " + target);
  }

  // walk the module graph rooted at this document; worker URLs resolve
  // against the document base, imports against each module's own URL
  const seen = new Set();
  const queue = [];
  for (const m of src.matchAll(RE_MODULE_IMPORT)) queue.push(m[1]);
  while (queue.length) {
    const spec = queue.shift();
    const target = norm(posix.join(htmlDir, stripQuery(spec)));
    if (seen.has(target) || !allFiles.has(target)) continue;
    seen.add(target);
    const msrc = servedBytes(target).toString("utf8");
    const mdir = norm(dirname(target));
    for (const wm of msrc.matchAll(RE_WORKER)) {
      const w = norm(posix.join(htmlDir, stripQuery(wm[1])));
      check(
        "worker:" + target + " -> " + wm[1] + " (doc " + h + ")",
        allFiles.has(w),
        "missing " + w,
      );
    }
    for (const mm of msrc.matchAll(/from\s*["']([^"']+)["']/g)) {
      queue.push(norm(posix.join(mdir, mm[1])));
    }
    for (const dm of msrc.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)) {
      queue.push(norm(posix.join(mdir, stripQuery(dm[1]))));
    }
  }
}

// ---------- 4. firmware table -> kpatch/payload files ----------
const { PS4, offsetsFor } = await import(
  pathToFileURL(join(ROOT, "raw13", "ps4_offsets.js")).href
);

check("ps4_offsets: PS4['14.00'] row exists", !!PS4["14.00"]);
const det14 = offsetsFor("PlayStation 4/14.00");
check(
  "ps4_offsets: offsetsFor detects 14.00",
  det14.key === "14.00" && !!det14.off,
  JSON.stringify(det14.key),
);

for (const tree of ["raw13", "."]) {
  for (const [fw, off] of Object.entries(PS4)) {
    if (!off) continue;
    const kpatch = off.kpatch || fw.replace(".", "") + ".bin";
    const payload = off.payload || "payload.bin";
    const kp = posix.join(tree, "patches", kpatch);
    const pl = posix.join(tree, payload);

    if (allFiles.has(kp)) {
      check("fw " + fw + " [" + tree + "] kpatch " + kp, true);
    } else if (KNOWN_MISSING.has("patches/" + kpatch)) {
      check(
        "fw " + fw + " [" + tree + "] kpatch " + kp,
        true,
        "known-unshipped blob (fails closed in jb.js)",
      );
    } else {
      check("fw " + fw + " [" + tree + "] kpatch " + kp, false, "missing blob");
    }

    check(
      "fw " + fw + " [" + tree + "] payload " + pl,
      allFiles.has(pl),
      "missing payload",
    );
  }
}

// ---------- 5. appcache manifest ----------
const AC = "raw13/cache.appcache";
if (allFiles.has(AC)) {
  let section = "CACHE";
  for (const raw of servedBytes(AC).toString("utf8").split(/\r?\n/)) {
    const t = raw.trim();
    if (!t || t.startsWith("#")) continue;
    if (/^CACHE MANIFEST$/i.test(t)) continue;
    const sec = t.match(/^(CACHE|NETWORK|FALLBACK):$/i);
    if (sec) {
      section = sec[1].toUpperCase();
      continue;
    }
    if (section !== "CACHE") continue;
    const m = t.match(/^(\S+)\s+#([0-9a-fA-F]{64})$/);
    if (!m) {
      check("appcache: " + t, false, "expected '<url> #<sha256-hex>'");
      continue;
    }
    const [, url, hash] = m;
    const file = norm(posix.join("raw13", stripQuery(url)));
    if (!check("appcache entry: " + url, allFiles.has(file), "missing " + file))
      continue;
    const actual = sha256hex(servedBytes(file));
    check(
      "appcache hash: " + url,
      actual === hash.toLowerCase(),
      "manifest=" + hash.slice(0, 12) + "... served=" + actual.slice(0, 12) + "...",
    );
  }
}

// ---------- report ----------
console.log("ps4hen site-graph verify");
console.log("  root: " + ROOT);
console.log("  pass: " + passCount + "  fail: " + failCount);
if (failCount) {
  console.log("\nFAILURES:");
  for (const f of failures) console.log("  x " + f);
  process.exit(1);
}
console.log("\nALL CHECKS PASS");
