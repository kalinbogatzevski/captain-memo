# Native lifecycle capture across AI CLIs

Captain Memo prefers a vendor's native lifecycle hooks when they expose all three pieces needed for
the memory loop:

1. the submitted prompt, so relevant memory can be injected before the agent works;
2. the executed tool name, input, and result, so observations retain useful evidence;
3. a turn/session boundary, so queued events can be flushed promptly.

It never assumes support from a binary name alone. `captain-memo connect` capability-probes the
installed CLI, merges only Captain Memo-owned entries into the user's config, and leaves the existing
transcript or rollout reader enabled. Only a successfully delivered native PostToolUse event marks that
exact session native; from then on, the compatibility reader skips it to prevent duplicate observations.

## Audited contracts

| Runtime | Audited support | Decision |
|---|---|---|
| Codex CLI | The stable hooks feature provides `UserPromptSubmit`, `PostToolUse`, and `Stop`, with session/turn ids and full tool input/response. | Install native recall/capture hooks when `codex features list` reports the effective `hooks` value as `true`. Respect `hooks=false` and retain rollout capture. |
| Gemini CLI | Experimental hooks provide `BeforeAgent`, `AfterTool`, and `AfterAgent`; `AfterTool` includes `tool_name`, `tool_input`, and `tool_response`. | Probe `gemini hooks --help`, enable the two vendor-required settings, and install native hooks when present. Retain transcript capture for older releases. |
| Kimi CLI | Beta hooks in 1.28.0+ provide `UserPromptSubmit`, `PostToolUse`, and `Stop`; PostToolUse includes `tool_name`, `tool_input`, and `tool_output`. | Gate at 1.28.0 because Kimi has no feature-list command. Use plain stdout for prompt context, matching Kimi's documented protocol. Retain transcript capture below that version. |
| Antigravity (`agy`) | Agy 1.1.11 exposes named hooks, but its documented PostToolUse payload contains step/error metadata rather than the executed tool input and result. | Do not install a lossy observation hook. Continue reading the richer persisted conversation data. Re-audit when Agy expands the payload. |
| Ollama | Ollama exposes model inference and tool calling; the application around it owns the agent loop and tool execution. It does not expose an agent-session lifecycle hook contract. | Observe the host agent, such as Kimi or opencode, not Ollama. The same rule applies when Ollama is used only as Captain Memo's summarizer or embedder endpoint. |

Primary references:

- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Gemini CLI hooks](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/index.md)
- [Kimi CLI hooks](https://github.com/MoonshotAI/kimi-cli/blob/main/docs/en/customization/hooks.md)
- [Ollama tool calling](https://docs.ollama.com/capabilities/tool-calling)

The Agy result was audited against the hook reference embedded in the installed Agy 1.1.11 binary;
there is no stable public hook reference to link yet.

## Failure and upgrade behavior

- Hook config merges preserve foreign top-level settings, hook groups, and commands. Re-running
  `captain-memo connect` replaces only entries carrying Captain Memo's managed marker.
- Malformed existing JSON/TOML does not get overwritten. The connect report names the failure and
  the transcript/rollout reader remains active.
- Hook discovery or trust is not treated as successful delivery. This matters for Codex, which asks
  the user to review project hooks once in `/hooks`.
- A CLI upgrade needs no migration command: re-run `captain-memo connect`. Codex and Gemini are
  capability-probed again; Kimi's version gate is re-evaluated.
- Upgrading Captain Memo from a release before 0.43.3 on Windows: re-run `captain-memo connect` (or
  the installer). Earlier versions wrote the Codex and Gemini hook commands starting with a quoted
  `"bun"`, which PowerShell reads as a string expression, so every prompt logged `hook exited with
  code 1`; connect rewrites the managed entries in place and leaves foreign hooks alone.
- Older Captain Memo workers ignore the new hook provenance fields, while newer workers continue to
  accept the legacy Claude Code payload. The wire change is additive in both directions.

## What reaches the corpus

Native events use the same queue, summarizer, embedder, redaction, and storage pipeline as Claude Code
and transcript-derived observations. They differ only at capture time. Every stored observation keeps
its `origin_agent`, and `/stats.capture.native` reports how many sessions have proved native delivery
for Codex, Gemini, and Kimi.
