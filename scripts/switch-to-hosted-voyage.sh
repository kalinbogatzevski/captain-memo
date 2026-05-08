#!/usr/bin/env bash
# Switch Captain Memo from local sidecar (voyage-4-nano @ 2048-dim) to
# Voyage's hosted API (voyage-4-lite @ 1024-dim).
#
# - stops worker + (you should Ctrl+C any running migration first)
# - wipes corpus data tables (memory + obs chunks; keeps schema)
# - rewrites worker.env with hosted-API config
# - restarts worker → re-indexes ~/.claude/projects/.../memory/ at 1024-dim
# - prints the migration command for you to run
#
# Idempotent — safe to re-run. Asks for confirmation before each destructive
# step. Pass --yes to auto-confirm everything.

set -euo pipefail

YES=0
[[ "${1-}" == "--yes" ]] && YES=1

confirm() {
  local prompt="$1"
  if [[ $YES -eq 1 ]]; then echo "  $prompt → auto-yes (--yes)"; return 0; fi
  read -r -p "  $prompt [y/N] " ans
  [[ "$ans" =~ ^[Yy]$ ]]
}

step() { echo; echo -e "\033[1;36m▸ $1\033[0m"; }
ok()   { echo -e "  \033[32m✓\033[0m $1"; }
warn() { echo -e "  \033[33m!\033[0m $1"; }

DATA_DIR="$HOME/.captain-memo"
META_DB="$DATA_DIR/meta.sqlite3"
VECTOR_DB="$DATA_DIR/vector-db/embeddings.db"
WORKER_ENV="$HOME/.config/captain-memo/worker.env"

echo "========================================"
echo "  Captain Memo — switch to hosted Voyage"
echo "========================================"
echo
echo "What this does:"
echo "  • Stop the worker"
echo "  • Wipe corpus chunks + migration progress (force re-index from sources)"
echo "  • Reconfigure worker.env to use https://api.voyageai.com (voyage-4-lite, dim 1024)"
echo "  • Restart worker → it re-embeds ~/.claude/projects/.../memory/ at 1024-dim"
echo "  • You then run 'captain-memo migrate-from-claude-mem' (one env-overridden line)"
echo
echo "What is preserved:"
echo "  • Source claude-mem DB at ~/.claude-mem/claude-mem.db (untouched, always)"
echo "  • Memory files in ~/.claude/projects/.../memory/ (the watcher re-reads them)"
echo "  • The local sidecar venv (just dormant; one env-var swap brings it back)"
echo

if [[ -z "${VOYAGE_KEY:-}" ]]; then
  warn "VOYAGE_KEY env var not set."
  echo "  Run as:  VOYAGE_KEY=pa-... $0"
  exit 2
fi

if ! confirm "Proceed?"; then echo "Aborted."; exit 0; fi

step "1/5  Stop captain-memo-worker (and warn about migration)"
echo "  If captain-memo migrate-from-claude-mem is still running, Ctrl+C it now"
echo "  in its own terminal. (This script only stops the worker.)"
if ! confirm "Confirmed — migration is NOT running?"; then echo "Aborted."; exit 0; fi
systemctl --user stop captain-memo-worker 2>/dev/null && ok "worker stopped" || warn "worker was not running"

step "2/5  Wipe corpus data tables (chunks, documents, migration_progress)"
if [[ ! -f "$META_DB" ]]; then
  warn "$META_DB does not exist — nothing to wipe"
else
  BEFORE_CHUNKS=$(sqlite3 "$META_DB" "SELECT COUNT(*) FROM chunks" 2>/dev/null || echo 0)
  BEFORE_DOCS=$(sqlite3 "$META_DB" "SELECT COUNT(*) FROM documents" 2>/dev/null || echo 0)
  BEFORE_MIG=$(sqlite3 "$META_DB" "SELECT COUNT(*) FROM migration_progress" 2>/dev/null || echo 0)
  echo "  before: chunks=$BEFORE_CHUNKS docs=$BEFORE_DOCS migration_progress=$BEFORE_MIG"
  if ! confirm "Wipe these (data only, schema stays)?"; then echo "Aborted."; exit 0; fi
  sqlite3 "$META_DB" \
    "DELETE FROM chunks; DELETE FROM documents; DELETE FROM migration_progress; VACUUM;"
  ok "meta.sqlite3 corpus tables truncated"
fi
if [[ -f "$VECTOR_DB" ]]; then
  rm -f "$VECTOR_DB" "$VECTOR_DB-shm" "$VECTOR_DB-wal"
  ok "embeddings.db deleted (will be recreated at dim=1024 on first write)"
else
  warn "no embeddings.db to delete"
fi

step "3/5  Rewrite $WORKER_ENV"
mkdir -p "$(dirname "$WORKER_ENV")"
if [[ -f "$WORKER_ENV" ]]; then
  cp "$WORKER_ENV" "$WORKER_ENV.bak.$(date +%Y%m%d_%H%M%S)"
  ok "backed up existing worker.env"
fi
# Preserve unrelated keys (summarizer, watch paths, etc.); only replace embedder-related lines.
{
  if [[ -f "$WORKER_ENV.bak."* ]]; then
    grep -vE '^(CAPTAIN_MEMO_EMBEDDER_|CAPTAIN_MEMO_EMBEDDING_DIM=)' "$WORKER_ENV" 2>/dev/null || true
  fi
  echo "# --- Voyage hosted API (switched $(date -Iseconds)) ---"
  echo "CAPTAIN_MEMO_EMBEDDER_ENDPOINT=https://api.voyageai.com/v1/embeddings"
  echo "CAPTAIN_MEMO_EMBEDDER_MODEL=voyage-4-lite"
  echo "CAPTAIN_MEMO_EMBEDDER_API_KEY=$VOYAGE_KEY"
  echo "CAPTAIN_MEMO_EMBEDDING_DIM=1024"
} > "$WORKER_ENV.new"
mv "$WORKER_ENV.new" "$WORKER_ENV"
chmod 600 "$WORKER_ENV"
ok "worker.env updated (mode 0600 — only your user can read it)"

step "4/5  Restart worker → it re-indexes memory at 1024-dim via hosted API"
systemctl --user daemon-reload 2>/dev/null || true
systemctl --user start captain-memo-worker
ok "worker started"
echo "  waiting 10s for initial re-index of memory channel..."
sleep 10
RESP=$(curl -s --max-time 5 http://127.0.0.1:39888/stats 2>/dev/null || echo '{}')
TOTAL=$(echo "$RESP" | python3 -c "import json,sys; r=json.loads(sys.stdin.read() or '{}'); print(r.get('total_chunks','?'))" 2>/dev/null || echo '?')
ok "worker /stats: total_chunks=$TOTAL (should grow to ~275 as it re-indexes)"

step "5/5  Run the migration with hosted API"
echo
echo "Now run THIS in your terminal (key is already in worker.env, but the migration"
echo "command needs it explicit too because it reads CAPTAIN_MEMO_VOYAGE_*):"
echo
echo "    CAPTAIN_MEMO_VOYAGE_ENDPOINT=https://api.voyageai.com/v1/embeddings \\"
echo "    CAPTAIN_MEMO_VOYAGE_MODEL=voyage-4-lite \\"
echo "    CAPTAIN_MEMO_VOYAGE_API_KEY=\$VOYAGE_KEY \\"
echo "    captain-memo migrate-from-claude-mem"
echo
echo "Expected: ~3-5 minutes total. Final corpus: ~95K chunks (275 memory + ~94K observations)."
