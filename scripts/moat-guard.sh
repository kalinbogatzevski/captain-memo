#!/usr/bin/env bash
# ── MOAT GUARD ──────────────────────────────────────────────────────────────────────────────────
# The OSS master branch (and github) must contain ZERO federation code. The PRIVATE `federation`
# branch is ALLOWED to carry it — including the accept-capable link-server — because it never reaches
# github. This guard FAILS if federation code (src/worker/federation/) has leaked onto master. It is
# CI-robust: it resolves a master ref (local `master`, else `origin/master`), and if neither exists
# (a stray detached checkout) it falls back to checking the working tree. Runs on every github CI run
# (push:master + PRs) — the belt that backs the per-clone pre-push hook.
set -eo pipefail

ref=""
for r in master origin/master refs/remotes/origin/master; do
  if git rev-parse --verify -q "$r" >/dev/null 2>&1; then ref="$r"; break; fi
done

if [ -z "$ref" ]; then
  # No master ref available (e.g. shallow PR checkout without it): check the working tree instead.
  if [ -d src/worker/federation ]; then
    echo "✗ MOAT VIOLATION: src/worker/federation exists in the working tree (this should be OSS master)."
    exit 1
  fi
  echo "✓ moat-guard: no master ref available; working tree carries no federation code."
  exit 0
fi

if git ls-tree -r --name-only "$ref" -- src/worker/federation 2>/dev/null | grep -q .; then
  echo "✗ MOAT VIOLATION: src/worker/federation exists on '$ref' — federation code must never land on master/github:"
  git ls-tree -r --name-only "$ref" -- src/worker/federation | sed 's/^/    /' | head -20
  exit 1
fi
echo "✓ moat-guard: '$ref' carries no federation code (the federation listener stays private)."
