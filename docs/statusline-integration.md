# Statusline Integration — see your Captain in the bar

Add a compact Captain Memo summary to your Claude Code status line so you always know the corpus is healthy and what it's doing.

```
kalin@dev:~/projects/erp-platform  |  Opus 4.7 (1M)  effort:high
ctx:23% used  cache:125k  |  cm:● 2,413 obs · 571M  |  ↑4 pending
```

- `cm:●` — green when the worker is HEALTHY, red when down.
- `2,413 obs · 571M` — total observations and corpus disk size, grouped as "corpus size".
- `↑4 pending` — observations still in the ingest queue (only shown when > 0).
- `idx 45/279` — reindex progress (only shown while a reindex is running).

## Prerequisites

- `captain-memo` ≥ 0.1.2 — earlier versions don't have `--json`.
- `jq`, `flock`, `awk` — present on every modern Linux/macOS.
- A Claude Code `statusLine` already in `~/.claude/settings.json`, or willingness to add one.

## How it works

Two scripts cooperate to keep the bar responsive even though `captain-memo` takes ~400 ms to answer:

1. **Cache producer** — runs `captain-memo stats --json` + `status --json`, formats a single ANSI-colored line, writes it atomically to `~/.cache/captain-memo/statusline`. Uses `flock` so concurrent refreshes don't pile up.
2. **Statusline consumer** — your `statusLine.command`. Reads the cache file (sub-millisecond) and prints it. If the cache is older than 30 s, it kicks off a background refresh and uses the stale value. This means the bar paints fast on every CC redraw, and the cache catches up in the background.

> The bar refreshes when Claude Code redraws (prompt submitted, tool result returned, model token streamed). Claude Code does not poll the statusline on a timer, so during idle periods the bar shows the last snapshot. The moment you interact, it refreshes — and if needed, fires off a background refresh of the cache too.

## 1. The cache producer

Save as `~/.claude/captain-memo-statusline-refresh.sh` and `chmod +x` it:

```bash
#!/usr/bin/env bash
# Captain Memo statusline cache producer.
set -u

cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/captain-memo"
cache_file="$cache_dir/statusline"
lock_file="$cache_dir/statusline.lock"
mkdir -p "$cache_dir"

# Single-flight: bail if another refresh is already running.
exec 9>"$lock_file"
flock -n 9 || exit 0

fmt_int() {
    # Comma-separated thousands, e.g. 2413 → "2,413".
    awk -v n="${1:-0}" 'BEGIN{
        x = sprintf("%d", n); s = ""
        while (length(x) > 3) {
            s = "," substr(x, length(x)-2) s
            x = substr(x, 1, length(x)-3)
        }
        print x s
    }'
}

fmt_bytes() {
    local b="${1:-0}"
    if   [ "$b" -lt 1024 ];       then printf "%dB" "$b"
    elif [ "$b" -lt 1048576 ];    then awk -v b="$b" 'BEGIN{printf "%.0fK", b/1024}'
    elif [ "$b" -lt 1073741824 ]; then awk -v b="$b" 'BEGIN{printf "%.0fM", b/1048576}'
    else awk -v b="$b" 'BEGIN{printf "%.1fG", b/1073741824}'
    fi
}

stats_json=$(captain-memo stats --json 2>/dev/null)
status_json=$(captain-memo status --json 2>/dev/null)
[ -z "$stats_json" ] && exit 0   # graceful degrade — leave old cache untouched

healthy=$(echo "$status_json"  | jq -r '.healthy // false')
obs_total=$(echo "$stats_json" | jq -r '.observations.total // 0')
obs_pending=$(echo "$stats_json"    | jq -r '.observations.queue_pending // 0')
obs_processing=$(echo "$stats_json" | jq -r '.observations.queue_processing // 0')
idx_status=$(echo "$stats_json" | jq -r '.indexing.status // "ready"')
idx_done=$(echo "$stats_json"   | jq -r '.indexing.done // 0')
idx_total=$(echo "$stats_json"  | jq -r '.indexing.total // 0')
disk_bytes=$(echo "$stats_json" | jq -r '.disk.bytes // 0')

RESET='\033[0m'; DIM='\033[2m'
GREEN='\033[32m'; RED='\033[31m'; YELLOW='\033[33m'; CYAN='\033[36m'

[ "$healthy" = "true" ] && dot="${GREEN}●${RESET}" || dot="${RED}●${RESET}"

total_fmt=$(fmt_int "$obs_total")
out="${DIM}cm:${RESET}${dot} ${CYAN}${total_fmt}${RESET}${DIM} obs${RESET}"

if [ "$disk_bytes" -gt 0 ] 2>/dev/null; then
    disk_fmt=$(fmt_bytes "$disk_bytes")
    out="${out} ${DIM}·${RESET} ${CYAN}${disk_fmt}${RESET}"
fi

in_flight=$(( obs_pending + obs_processing ))
if [ "$in_flight" -gt 0 ]; then
    out="${out}  ${DIM}|${RESET}  ${YELLOW}↑${in_flight}${RESET}${DIM} pending${RESET}"
fi

if [ "$idx_status" = "indexing" ] && [ "$idx_total" -gt 0 ]; then
    out="${out}  ${DIM}|${RESET}  ${YELLOW}idx ${idx_done}/${idx_total}${RESET}"
fi

# Atomic write — the consumer never sees a half-written file.
printf "%b" "$out" > "$cache_file.tmp" && mv "$cache_file.tmp" "$cache_file"
```

## 2. The statusline consumer

In your existing `~/.claude/statusline-command.sh`, add this block where you want the Captain Memo segment to appear (typically the last thing on a line):

```bash
cm_cache="${XDG_CACHE_HOME:-$HOME/.cache}/captain-memo/statusline"
cm_refresh="$HOME/.claude/captain-memo-statusline-refresh.sh"
cm_ttl=30  # seconds

if [ -x "$cm_refresh" ]; then
    cm_age=999999
    if [ -r "$cm_cache" ]; then
        cm_mtime=$(stat -c %Y "$cm_cache" 2>/dev/null || echo 0)
        cm_age=$(( $(date +%s) - cm_mtime ))
    fi

    # Async refresh when stale (single-flight is enforced inside the script).
    if [ "$cm_age" -gt "$cm_ttl" ]; then
        (nohup "$cm_refresh" >/dev/null 2>&1 &) >/dev/null 2>&1
    fi

    if [ -s "$cm_cache" ]; then
        printf "  %b" "$(cat "$cm_cache")"
    fi
fi
```

> On macOS, `stat -c %Y` is `stat -f %m` instead. If you support both, branch on `$(uname)` or use `date -r "$cm_cache" +%s` which works everywhere.

## 3. Wire it up in `settings.json`

```json
{
  "statusLine": {
    "type": "command",
    "command": "bash /home/<you>/.claude/statusline-command.sh",
    "padding": 0
  }
}
```

That's it. Open a Claude Code session — the bar redraws on the next event and your Captain is on deck.

## Tuning

| Field | Where | Notes |
|---|---|---|
| TTL | `cm_ttl=30` in consumer | Lower (`5`) → fresher data, more `captain-memo` calls. Higher (`120`) → cheaper, more stale at peak. |
| Disk separator | `${DIM}·${RESET}` in producer | Use `·` for tight grouping (obs + disk = "corpus size"). Use `|` to start a new logical cluster (`pending`, `idx`). |
| Pending threshold | `in_flight > 0` in producer | Bump to `> 5` if you don't want to see normal-flow blips. |
| Two-line bar | Add `printf "\n"` between segments | Claude Code renders every line of stdout from the command. |

## Reference: the JSON shapes you're parsing

```jsonc
// captain-memo stats --json
{
  "total_chunks": 101378,
  "by_channel": { "memory": 279, "observation": 101099 },
  "observations": { "total": 2412, "queue_pending": 1, "queue_processing": 2 },
  "indexing": { "status": "ready", "total": 279, "done": 279, "percent": 100, "errors": 0, "last_error": null, "elapsed_s": 0, "started_at_epoch": 1778407869, "finished_at_epoch": 1778407869 },
  "project_id": "default",
  "embedder": { "model": "voyage-4-lite", "endpoint": "https://api.voyageai.com/v1/embeddings" },
  "disk": { "bytes": 598395312, "path": "/home/kalin/.captain-memo" },
  "version": "0.1.2"
}

// captain-memo status --json
{ "healthy": true, "total_chunks": 101378, "project_id": "default" }
// or, when worker is down:
{ "healthy": false }
```

## Pattern: this works for any slow CLI

The producer/consumer split here isn't Captain-Memo-specific. Whenever you want to surface data from a CLI that takes more than ~50 ms, the recipe is:

1. Cache producer writes a one-line summary atomically.
2. Statusline consumer reads the cache (instant) and fires async refresh if stale.
3. Single-flight via `flock` so a bursty statusline doesn't fork a refresh army.

The bar stays snappy; the data is at most `cm_ttl` seconds behind.
