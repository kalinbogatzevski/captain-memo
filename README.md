# Captain Memo

> *Your AI coding agent's logbook — local memory, kept in sync, retrieved on every prompt.*

Captain Memo is a Claude Code plugin (and a self-contained local-memory layer for any AI coding agent that speaks the standard hook + MCP shapes). Every session leaves a wake; Captain Memo keeps the log so the next session sails with what was learned in the last one.

---

## Why I built this

I run an ISP and built the ERP platform behind it. The same platform now runs at a friend's ISP in another country, and most of the code that keeps both deployments alive passes through Claude Code on its way to production. Billing fixes, NAS migrations, OLT integrations, GitLab tickets that drag on for weeks. The kind of work where the *context* is half the job.

Sometime in the last year, my AI pair-programmer became my most patient colleague. It would sit through a four-hour debugging arc with me, never tire, never lose the thread inside that session. But the moment a session ended, every hard-won realisation went with it. The next morning I'd open a new chat and re-explain why we *don't* round in the middle of a billing calculation, why bills on one tenant are trigger-driven, why we never `clone $smy` in CLI smoke tests. The same lessons. Every. Single. Day.

I tried writing things down. The `~/.claude/memory/` folder filled up — feedback rules, project notes, references, observations from incidents. Hundreds of small markdown files, each a hard-earned scrap of judgment. Then [`claude-mem`](https://github.com/thedotmack/claude-mem) came along and made some of that searchable, and for months it was my colleague's memory. It helped me a lot. Without it, Captain Memo wouldn't exist — because I wouldn't have known what shape the problem really had.

Eventually I started noticing the gaps for the way *I* work: small English-only embeddings, opinionated retention, one cloud LLM. My Bulgarian-and-English notes returned no hits on the Bulgarian half. Some retrievals felt random on a corpus this size. None of that takes away from how useful claude-mem still is — it just turned out my work needed something a little different.

So I sat down to build that "something different" for myself, and ended up with something I think other people might want too.

---

## What it is

- **Local-first.** Vector store and metadata live on your machine — `sqlite-vec` + SQLite WAL. No cloud database, no per-call billing for retrieval, no network round-trips on the hot path.
- **Hybrid search.** Voyage-4-nano embeddings + FTS5 keyword index, fused via Reciprocal Rank Fusion. Multilingual (BG/EN/etc.) — your non-English memory is searchable too.
- **Three summarizer providers**, picked at install time:
  - `claude-code` — uses your existing **Claude Code Max/Pro** plan (no API key, no extra billing)
  - `openai-compatible` — Ollama / LM Studio / vLLM / OpenAI / OpenRouter / DeepSeek / Groq / Together / Mistral / etc.
  - `anthropic` — direct Anthropic SDK with `ANTHROPIC_API_KEY`
- **Local Voyage embedder** included — `voyageai/voyage-4-nano` open weights via a small FastAPI sidecar. No cloud key required for embeddings either.
- **Auto-injected context.** A `<memory-context>` envelope is added to every user prompt by the `UserPromptSubmit` hook. The model sees relevant memory, skills, and prior session observations before it answers.
- **Session observations.** Every tool use is captured fire-and-forget; on `Stop`, batched events are summarized into structured observations (type / title / facts / concepts) and indexed into the same hybrid search. Future sessions can recall them.
- **Indefinite retention.** No 30-day cleanups. A project takes years; your memory should too.

---

## Install (one command)

```bash
git clone https://github.com/<your-account>/captain-memo
cd captain-memo
bun install
sudo ./bin/captain-memo install
```

The `install` command runs an interactive wizard — asks which summarizer + embedder you want, where to find your memory files, then sets up:

- Embedder sidecar (systemd, runs voyage-4-nano locally on port 8124)
- Worker daemon (systemd, search + observation pipeline on port 39888)
- Claude Code plugin registration (`~/.claude/plugins/captain-memo` symlink)
- `/etc/captain-memo/worker.env` with your chosen config

After the wizard, restart any open Claude Code sessions. Hooks fire automatically in every future session.

```bash
captain-memo doctor    # check status across all components
captain-memo uninstall # clean removal (--purge for data too)
```

## Quick reference

```bash
captain-memo status              # is the worker reachable?
captain-memo stats               # corpus stats by channel
captain-memo reindex             # cheap sha-diff reindex (or --force to re-embed)
captain-memo observation list    # recent captured observations
captain-memo observation flush   # force-drain the queue
captain-memo config show         # effective config (secrets masked)
captain-memo doctor              # component health probe
```

---

## What's inside

| Component | What it does |
|---|---|
| **Worker** (`:39888`) | Long-lived HTTP daemon. Owns the SQLite + sqlite-vec stores, file watcher, observation queue, summarizer wiring. |
| **Embedder sidecar** (`:8124`) | Self-hosted voyage-4-nano via FastAPI + sentence-transformers. Optional — replace with any `/v1/embeddings`-compatible service. |
| **MCP server** (stdio) | Exposes 8 tools (`search_memory`, `search_skill`, `search_observations`, `search_all`, `get_full`, `reindex`, `stats`, `status`) to Claude Code. |
| **Four hooks** | `UserPromptSubmit` (inject envelope, ≤250 ms p95), `SessionStart` (warm worker), `PostToolUse` (fire-and-forget enqueue), `Stop` (drain → summarize → index). |
| **CLI** | The commands above. |

Channels indexed: `memory` (curated user memory files), `skill` (Claude Code skill bodies, section-level), `observation` (summarized session events).

Detailed docs: [`docs/USAGE.md`](docs/USAGE.md).

---

## Status

| Plan | Scope | State |
|---|---|---|
| 1 | Worker, MCP server, CLI, hybrid search, file watcher, ingest pipeline | Shipped |
| 2 | Hooks + observation pipeline + 3-provider summarizer + local embedder | Shipped |
| 3 | claude-mem migration · federation client · optimize/purge/forget · retrieval-quality eval · doctor | Drafted in [`docs/plans/`](docs/plans/) |

148 tests pass. Typecheck clean. Bun ≥ 1.1.14, TypeScript strict.

---

## Why "Captain Memo"

The captain keeps the ship's log. Every voyage gets entered. When the ship sails again, the captain remembers what happened on the last one — the storms, the trade winds, the islands that turned out to have fresh water. That's what this plugin does for your AI coding sessions.

The metaphor extends throughout the codebase: memory files = logbook entries, observations = voyage logs, the file watcher = lookout in the crow's nest, federation (Plan 3) = sister ships exchanging signals, claude-mem migration = transferring the old ship's log.

(There's a tiny in-joke in the name too. *cap**TAI**n* — the AI was always there, hiding in plain sight.)

---

## Open source, because

The people most likely to benefit are people working the way I work — alone or in small teams, on real systems, in languages other than English, with budgets that don't include a per-call billing line. The same shape of problem keeps showing up: *my AI forgets between sessions and I'm tired of re-saying the same things*. If you've felt that, this is the tool I wish I'd had a year earlier.

MIT-licensed. Run it locally, point it at any LLM you have, and tell it nothing it doesn't need to know. Captain Memo logs the voyage; you stay the captain.

## Contributing

Issues + PRs welcome. Plan 3's 35 tasks in [`docs/plans/`](docs/plans/) are good first contributions for the migration / federation / optimization layers.

## License

MIT — see [LICENSE](LICENSE).

— Kalin
