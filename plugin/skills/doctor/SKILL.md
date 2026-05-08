---
name: doctor
description: Health probe across Captain Memo's components — embedder service, worker service, config, plugin registration, plugin manifest. Use when the user types /captain-memo:doctor or when something seems wrong.
---

# Captain Memo — doctor (health probe)

When invoked, run a comprehensive health check and report PASS/WARN/FAIL for each component, with one-line remediation hints when something's not green.

## What to do

The CLI has the canonical implementation. Just shell out:

```bash
captain-memo doctor
```

…and pass the output back to the user verbatim (it's already nicely formatted with colour and remediation hints).

If `captain-memo` isn't on PATH, fall back to:

```bash
/home/kalin/projects/captain-memo/bin/captain-memo doctor
```

…or whatever the actual install path is — find it via `readlink ~/.claude/plugins/captain-memo`.

## On error

If even the CLI invocation fails, that's a sign something is broken at the install layer. Suggest:

```bash
ls ~/.claude/plugins/captain-memo
systemctl --user list-units 'captain-memo-*'
```

…to see whether the install ever happened, then `captain-memo install` if not.
