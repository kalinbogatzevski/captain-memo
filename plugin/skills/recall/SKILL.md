---
name: recall
description: Print the full content of a single Captain Memo hit by its doc_id. Used after /captain-memo:search to expand a snippet into the full source.
---

# Captain Memo — recall full content by doc_id

When the user invokes this skill, they want the *full* text of a previously-found hit, not just a snippet.

## What to do

1. Take the user's argument as the doc_id (e.g. `memory:feedback_no_clone_smy:abc1234`).
2. Run:

```bash
curl -s -X POST http://127.0.0.1:39888/get_full \
  -H 'content-type: application/json' \
  -d "$(jq -nc --arg id "<DOC_ID>" '{doc_id: $id}')"
```

3. Format the response. The body is `{ content: "...", metadata: {...} }`.

## Output format

Show the source path from `metadata.source_path` first as a header, then the full `content`, then a small footer with notable metadata (memory_type, created_at_epoch as a date if present, etc.).

```
📄 /home/kalin/.claude/projects/.../memory/feedback_no_clone_smy.md
   type: feedback · 2026-04-15

In the multi-tenant ERP at /home/kalin/projects/erp-platform/, **do NOT** use
this pattern in CLI smoke tests:

```bash
php -r "require 'core/inc/boot.php'; \\$smy_test = clone \\$smy; ..."
```

[…full content…]
```

## On error

- 404 not_found: tell the user "no document with that doc_id — was the search recent? Try `/captain-memo:search` again to get fresh doc_ids"
- worker unreachable: `captain-memo doctor` to diagnose
