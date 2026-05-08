---
name: search
description: Hybrid search across Captain Memo's local memory + skills + observations. Use when the user types /captain-memo:search <query> to retrieve top hits without the model having to decide whether to call search_all on its own.
---

# Captain Memo — direct search

When the user invokes this skill, they want a direct hybrid search against Captain Memo's local index. Don't reason about it — just run it.

## What to do

1. Take the user's argument as the query string (everything after `/captain-memo:search `).
2. Run this Bash command and show the user the formatted result:

```bash
curl -s -X POST http://127.0.0.1:39888/search/all \
  -H 'content-type: application/json' \
  -d "$(jq -nc --arg q "<USER_QUERY>" '{query: $q, top_k: 5}')" \
  | jq -r '.results[] | "[\(.score | (. * 100 | floor) / 100)] \(.channel) · \(.title)\n   doc_id: \(.doc_id)\n   \(.snippet[0:200])\n"'
```

Replace `<USER_QUERY>` with the actual query the user provided. Use `jq -nc --arg q ...` to safely quote the query (avoids shell injection on special characters).

## Format the output as

```
3 hits for "the user's query":

[0.94] memory · feedback_no_clone_smy_in_cli_smoke
   doc_id: memory:feedback_no_clone_smy_in_cli_smoke:abc1234
   In the multi-tenant ERP at /home/kalin/projects/erp-platform/, do NOT use this pattern in CLI smoke tests…

[0.87] memory · feedback_iron_backend_dynamic_promos
   doc_id: memory:feedback_iron_backend_dynamic_promos:def5678
   …

[0.82] observation · 2026-04-30 · "Fix off-by-one in pro-ration loop"
   doc_id: observation:1700000000:ghi9012
   …
```

Tip the user: they can run `/captain-memo:recall <doc_id>` to fetch the full content of any hit.

## On error

- Worker returns 503 / not reachable: tell the user `captain-memo doctor` to diagnose
- Empty results: say "no hits — try a more specific query, or check `captain-memo stats` to confirm the corpus is indexed"
