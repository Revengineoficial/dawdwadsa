# ps4hen

What is dead may never die.

PS4 jailbreak host: WebKit + kernel exploit chain for FW 13.00-13.52 (full JB)
and 14.00 (HX1400 dev path), shipped as a static GitHub Pages site.

## Layout

| Path | What it is |
|---|---|
| `index.html` | Root entry - single redirect into the live tree |
| `raw13/` | **Live tree.** jb.html + jb.js + core.js + mem.js + int64.js + ps4_offsets.js + rpc_worker.js + hx1400_port.js + hx_tables.js + payloads + patches |
| `raw13/ps4_offsets.js` | Per-firmware offsets. 14.00's kernel table ships in `hx_tables.js` and only loads in HX1400 mode (`?hx1400=1`) |
| `raw13/cache.appcache` | Offline manifest. NOT wired to `<html manifest>` - kept accurate so it can be enabled later; regenerate hashes on every content change |
| `patches/` | Root-tree copy of the kernel patch blobs (mirror of `raw13/patches/`) |
| `assets/`, `jar_extract/` | "Bonk" HEN extraction (hen.bin + local templates) + captures |
| `research/` | 14.00 WebKit research page + gadget/offset dumps |
| `tools/verify_site.mjs` | Static site-graph verifier (see Testing) |

Kernel patch blobs shipped: 1302, 1350, 1352, 1400. The 11.00/11.50/12.00/
12.50/13.00 blobs were never committed - those firmwares fail closed in jb.js
with an explicit `KPATCH-FETCH-404` line instead of a silent 404.

## Run locally

Any static file server from the repo root:

```
python -m http.server 8000
```

Open `http://localhost:8000/` in the PS4 browser. A desktop browser is a dry
run only - the exploit arms on PS4 hardware.

## Testing

```
node tools/verify_site.mjs
```

Checks that every module import, worker URL, `<script src>`, root redirect,
firmware kpatch/payload path and appcache hash resolves to a real file with
the exact bytes GitHub Pages serves. Wired into the Pages deploy workflow.

## Conventions

- Every module import carries a `?v=N` cache-buster. When a file's content
  changes, bump its version in EVERY importer in the same commit - a shared
  module (e.g. `int64.js`) must keep one identical specifier everywhere or the
  engine loads two instances and `instanceof` checks split.
- `tools/verify_site.mjs` runs in CI before the Pages upload and blocks the
  deploy on a broken graph.

