#!/usr/bin/env bash
# Re-record the README hero GIF (docs/demo.gif): the real `captain-memo connect` and `captain-memo stats` against a
# throwaway HOME and a made-up corpus, so nothing real appears on screen. See README.md in this folder.
#   scripts/record-demo/record.sh [out.gif]        (default: <work dir>/demo.gif)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
for t in bun agg python3 curl; do command -v "$t" >/dev/null || { echo "record-demo: '$t' is not installed" >&2; exit 1; }; done
BUN="$(command -v bun)"; AGG="$(command -v agg)"; PY="$(command -v python3)"
WORK="${DEMO_WORK:-$(mktemp -d)}"; mkdir -p "$WORK/bin"
DEMO_HOME="${DEMO_HOME:-/dev/shm/demo}"; PORT="${DEMO_PORT:-39990}"; OUT="${1:-$WORK/demo.gif}"
# This script deletes DEMO_HOME. Only a folder it created itself (marked) may be deleted, never a real home.
if [ -e "$DEMO_HOME" ] && [ ! -f "$DEMO_HOME/.record-demo" ]; then echo "record-demo: $DEMO_HOME exists and is not a demo home; pick another DEMO_HOME" >&2; exit 1; fi
THEME="121314,cacaca,1e1f20,d1626a,48af20,c7a259,5a8fd8,b37fd6,54e1b9,cacaca,7f7f80,e8788a,5bd12a,e0bd6f,78a9ee,c99be6,6fedc9,ffffff"

# the commands the recording types, and the two CLIs `connect` runs (a real CLI takes about 0.7 s per call)
printf '#!/bin/sh\nexec "%s" "%s/bin/captain-memo" "$@"\n' "$BUN" "$ROOT" > "$WORK/bin/captain-memo"
printf '#!/bin/sh\nsleep 0.7\nexit 0\n' > "$WORK/bin/codex"; cp "$WORK/bin/codex" "$WORK/bin/gemini"
chmod +x "$WORK/bin/captain-memo" "$WORK/bin/codex" "$WORK/bin/gemini"

# a fresh machine: one folder per tool the six adapters detect, the worker pointed at the scratch home
rm -rf "$DEMO_HOME"; mkdir -p "$DEMO_HOME/.config/captain-memo" "$DEMO_HOME/.captain-memo" "$DEMO_HOME/.codex" "$DEMO_HOME/.gemini/antigravity-cli" \
  "$DEMO_HOME/.cursor" "$DEMO_HOME/.config/goose" "$DEMO_HOME/.config/JetBrains"
touch "$DEMO_HOME/.record-demo"; printf 'extensions: {}\n' > "$DEMO_HOME/.config/goose/config.yaml"
export HOME="$DEMO_HOME" XDG_CONFIG_HOME="$DEMO_HOME/.config" CAPTAIN_MEMO_CONFIG_DIR="$DEMO_HOME/.config/captain-memo" \
  CAPTAIN_MEMO_DATA_DIR="$DEMO_HOME/.captain-memo" CAPTAIN_MEMO_WORKER_PORT="$PORT" CAPTAIN_MEMO_EMBEDDER_ENDPOINT="http://127.0.0.1:9" CAPTAIN_MEMO_DISABLE_SELF_HEAL=1
export PATH="$WORK/bin:$(dirname "$BUN"):/usr/bin:/bin"
cleanup() { [ -f "$WORK/worker.pid" ] && kill "$(cat "$WORK/worker.pid")" 2>/dev/null || true; rm -rf "$DEMO_HOME"; }
trap cleanup EXIT

cd "$ROOT"
"$BUN" "$HERE/seed.ts" && "$BUN" "$HERE/seed-audit.ts"                      # the sample corpus, then its recall history
(nohup "$BUN" src/worker/index.ts > "$WORK/worker.log" 2>&1 & echo $! > "$WORK/worker.pid")
for _ in $(seq 1 40); do curl -s -m 2 "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 1; done
curl -s -m 3 "http://127.0.0.1:$PORT/health" >/dev/null || { echo "record-demo: the scratch worker did not start (see $WORK/worker.log)" >&2; exit 1; }

"$PY" "$HERE/rec.py" "$WORK/take.cast" 100 30                                # 100 x 30 gives the 983 x 694 the pages expect
"$PY" "$HERE/retime.py" "$WORK/take.cast" "$WORK/final.cast"
"$AGG" --theme "$THEME" --font-size 16 --idle-time-limit 12 --last-frame-duration 9 "$WORK/final.cast" "$OUT" >/dev/null 2>&1

# a generic leak scan of everything the recording printed: a real-looking path, an email, or a URL other than loopback
"$PY" - "$WORK/final.cast" <<'PYEOF'
import json, re, sys
txt = ''.join(json.loads(l)[2] for l in open(sys.argv[1], encoding='utf-8').read().split('\n')[1:] if l.strip())
plain = re.sub(r'\x1b\[[0-9;?]*[A-Za-z]', '', txt)
bad = sorted(set(re.findall(r'/home/\S+|/Users/\S+|C:\\\S+|[\w.+-]+@[\w-]+\.[\w.-]+|https?://(?!127\.0\.0\.1)\S+', plain)))
if bad: print('record-demo: LEAK SCAN FAILED, the recording shows:', bad); sys.exit(1)
print('record-demo: leak scan ok (no home path, email or non-loopback URL on screen)')
PYEOF
echo "record-demo: wrote $OUT. Now LOOK at the frames before publishing: convert '$OUT' -coalesce frame-%02d.png"
