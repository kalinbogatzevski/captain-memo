<p align="center">
  <img src="docs/logo.png" alt="Captain Memo — The Ship-Log for Your Digital World" width="320">
</p>

<h1 align="center">Captain Memo</h1>

<p align="center"><em>Your AI coding agent's logbook — local memory, kept in sync, retrieved on every prompt.</em></p>

<p align="center">
  Built by <a href="https://github.com/kalinbogatzevski">Kalin Bogatzevski</a> · <a href="LICENSE">Apache-2.0</a> · <a href="https://github.com/kalinbogatzevski/captain-memo/issues">Issues</a>
</p>

Captain Memo is a Claude Code plugin — and a **cross-AI local-memory layer**: one local corpus shared by every MCP-speaking coding agent on your machine (Claude Code, Codex, Gemini CLI, Antigravity, Cursor, opencode, Kimi CLI), so what one tool learns, the others recall. Every session leaves a wake; Captain Memo keeps the log so the next session — in any of your AI tools — sails with what was learned in the last one.

> **Platforms — Linux + native Windows (x64).** Linux runs under `systemd --user`; Windows runs natively under a per-user Scheduled Task (no WSL, no admin) — see [Windows (native)](#windows-native) below, or use the [WSL2 fallback](#wsl2-fallback). macOS support is still pending; Mac users can run the worker manually under launchd / tmux / nohup, see [issue #1](https://github.com/kalinbogatzevski/captain-memo/issues/1).

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
- **Cross-AI — one corpus, many tools.** Claude Code, Codex, Gemini CLI, Antigravity (`agy`, the Gemini-CLI successor), Cursor, opencode, Mistral Vibe, Kimi CLI, VS Code (Copilot), and JetBrains (AI Assistant) all share the same local memory through Captain Memo's MCP server + a portable skill. `captain-memo install` (or `captain-memo connect`) auto-detects the AI tools on your machine and wires each one — no manual setup. Verified live: Codex *and* Gemini CLI recalling an observation Claude Code captured, from the same worker; the rest are supported via their standard MCP config (JetBrains is IDE-only config, so `connect` drops a paste-ready snippet instead of auto-wiring). See [docs/cross-ai-tools.md](docs/cross-ai-tools.md).
- **Auto-discovered memory — every assistant, not just Claude.** `CAPTAIN_MEMO_WATCH_MEMORY=auto` (the install default) probes the machine and indexes whichever AI memory files actually exist: `~/.claude/CLAUDE.md`, per-project Claude memories, `~/.codex/`, `~/.gemini/`, `~/.cursor/rules/`, repo-level `AGENTS.md` / `CLAUDE.md` / `.github/copilot-instructions.md`. Each doc is tagged with the `tool` it came from. Composes with your own globs (`auto,/my/notes/*.md`). Credentials and session logs are structurally unindexable — every discovery glob must end in `.md`/`.mdc`, which is enforced by a test, not a blocklist.
- **Hybrid search.** Voyage embeddings (default) + SQLite FTS5 keyword index, fused by weighted cosine + BM25 scoring (RRF still available via the `legacy` rank profile), with a recency-aware re-rank on observations. Multilingual (BG/EN/etc.) — your non-English memory is searchable too.
- **Five summarizer providers**, picked at install time:
  - `claude-oauth` *(default)* — direct Anthropic API using the OAuth token Claude Code already stored. No API key. ~700 ms/call. Just works on a Max plan.
  - `codex` — **`codex exec` on your ChatGPT Plus/Pro account. No API key, no Anthropic subscription needed.** The zero-key option if you don't have Claude Max. ~6–7 s/call (that's Codex booting its agent runtime, not inference — it's flat across the model ladder, so a small model saves quota, not time). Defaults to `gpt-5.4-mini`. Runs on the background tick, so it never blocks a prompt. Requires `codex login`.
  - `anthropic` — direct Anthropic SDK with `ANTHROPIC_API_KEY` (paid)
  - `claude-code` — `claude -p` subprocess (slower; for users without OAuth file access)
  - `openai-compatible` — Ollama / LM Studio / vLLM / OpenAI / OpenRouter / DeepSeek / Groq / Together / Mistral / etc.
- **Four embedder backends**, picked at install time:
  - `voyage-hosted` *(default)* — Voyage API (`voyage-4-lite`, 1024-dim). Free signup, ~$0.30/year typical use, fast on any hardware.
  - `local-sidecar` — `voyageai/voyage-4-nano` open weights via a self-contained FastAPI sidecar (offline, private, 2048-dim, AVX2 recommended)
  - `openai-compatible` — Any `/v1/embeddings` endpoint (Ollama, OpenAI, OpenRouter, etc.)
  - `skip` — keyword-only retrieval (FTS5 only, no vectors)
- **Auto-injected context.** A `<memory-context>` envelope is added to every user prompt by the `UserPromptSubmit` hook. The model sees relevant memory, skills, and prior session observations before it answers.
- **Session observations.** Every tool use is captured fire-and-forget; on `Stop`, batched events are summarized into structured observations (type / title / facts / concepts) and indexed into the same hybrid search. Future sessions can recall them.
- **Work-coordination board.** Before every Edit/Write/MultiEdit/NotebookEdit, a `PreToolUse` hook publishes a transient "I'm touching these files" claim to a shared board. Any other AI tool on the same machine editing overlapping files is flagged instantly — by file path, and by *meaning* (a semantic pass catches two agents working on the same thing in different files, which a plain glob match misses). Advisory only, never blocks an edit; claims are leases that auto-expire, so a crashed session never leaves a phantom claim behind.
- **Indefinite retention.** No 30-day cleanups. A project takes years; your memory should too.

---

## Requirements

**Always required:**

| Component | Minimum | Notes |
|---|---|---|
| OS | Linux (systemd) **or** Windows x64 | Windows uses a per-user Scheduled Task; `win32-arm64` and macOS not yet supported |
| Bun | ≥ 1.1.14 | https://bun.com |
| Disk | ~50 MB | The corpus itself + worker code; grows ~1 MB per few hundred chunks |
| Sudo | **not required** | The default install runs entirely as your user. Sudo only needed for `--system` (multi-user / always-on server). |

**Plus, depending on the embedder you pick:**

| If you choose | Extra requirement | Approx footprint |
|---|---|---|
| **Hosted Voyage API** *(recommended)* | Free API key from [dash.voyageai.com](https://dash.voyageai.com), outbound HTTPS | ~$0.30/year typical use, no install bloat |
| **Local voyage-4-nano sidecar** | Python 3.11+, AVX2 CPU recommended (works without — ~10× slower), 4 GB RAM, ~6 GB disk | Self-contained but heavy; bring patience for first-time pip install + model download |
| **Other OpenAI-compatible endpoint** (Ollama, OpenAI, OpenRouter) | Whatever your endpoint requires | Depends on backend |

**And, depending on the summarizer you pick:**

| If you choose | Extra requirement |
|---|---|
| **Claude Max via OAuth** *(recommended)* | A Claude Max subscription + `claude login` already done. No API key. |
| **Anthropic API** | `ANTHROPIC_API_KEY=sk-ant-…` (paid per token) |
| **Claude Code subprocess** | `claude` CLI on PATH; uses Max plan but adds 5–15 s per call vs OAuth |
| **OpenAI / Ollama / OpenRouter** | Endpoint URL + optional API key |

The install wizard runs **pre-flight checks** before touching anything — it tells you exactly which requirement is unmet and how to fix it. If your CPU can't run the local embedder, the wizard recommends a hosted backend instead.

## Install — pick a path

All paths lead to the same plugin loaded into Claude Code. The wizard asks which embedder + summarizer to use, then sets everything up.

```bash
git clone https://github.com/kalinbogatzevski/captain-memo
cd captain-memo
bun install
./bin/captain-memo install
```

The wizard asks ~5 questions and sets up:
- **Worker daemon** at `~/.config/systemd/user/captain-memo-worker.service` (port 39888)
- **Plugin registration** via `claude plugin marketplace add` + `claude plugin install` — your hooks, MCP server, and slash commands all auto-register
- **Config** at `~/.config/captain-memo/worker.env`
- **CLI shim** at `~/.local/bin/captain-memo` (`/usr/local/bin` in system mode)
- **Cross-AI wiring** — auto-detects the other AI tools on the machine (Codex, Gemini CLI, Cursor, opencode, …) and points each at the same worker (re-runnable anytime with `captain-memo connect`; skip with `--no-cross-ai`)
- **Embedder sidecar** at `~/.captain-memo/embed/` *(only if you pick the local backend)*

After the wizard, **fully restart Claude Code** (quit the `claude` process, not just the session) for the plugin to load.

### What the wizard asks you

**Question 1 — Summarizer** (compresses tool-use events into observation chunks):

| Pick | When |
|---|---|
| **Claude Max via OAuth** *(recommended)* | You have a Claude Max subscription. Free, fast (~700 ms/call), no API key — Captain Memo reads the OAuth token Claude Code already stored. |
| Anthropic API | You want explicit per-token billing or don't have Max. |
| Claude Code subprocess | OAuth not available; falls back to spawning `claude -p` per call (slower). |
| OpenAI / Ollama / OpenRouter | You're routing to a different model fleet. |
| Skip | Events queue but don't summarize (rare; you keep raw events for later). |

**Question 2 — Embedder** (turns text into vectors for semantic search):

| Pick | When |
|---|---|
| **Hosted Voyage API** *(recommended)* | Best for most users. Fast on any hardware, ~$0.30/year typical use, free signup at [dash.voyageai.com](https://dash.voyageai.com). 1024-dim. |
| Local voyage-4-nano sidecar | You want offline / fully-private inference. Needs AVX2 CPU + 6 GB Python install. 2048-dim. |
| External /v1/embeddings | Self-hosted (Ollama, vLLM, llama.cpp), or another hosted provider. |
| Skip | Keyword-only retrieval (FTS5, no vectors). Search quality drops a lot. |

If you pick Voyage hosted and don't have your API key handy, leave it blank — the wizard writes `worker.env` without a key and tells you to add one before starting; put a `CAPTAIN_MEMO_EMBEDDER_API_KEY=…` line in `worker.env` and restart the worker.

**Question 3 — Watched memory files** (which markdown the worker indexes and keeps in sync):

| Pick | When |
|---|---|
| **All Claude project memories** *(recommended)* | Index every project's `~/.claude/projects/*/memory/*.md`. |
| User-global only | Just `~/.claude/memory/*.md`. |
| Custom paths | You keep memory files elsewhere — the wizard prompts for comma-separated globs. |
| Skip | No file watching; observations only. |

### System-wide install (headless servers, multi-user)

For headless boxes, multi-user dev servers, or "always-on regardless of who's logged in":

```bash
sudo ./bin/captain-memo install --system
```

Installs to `/opt/captain-memo-embed/` + `/etc/systemd/system/` + `/etc/captain-memo/` instead of `$HOME`. Same wizard, same result, just at system scope. Survives any user logout.

### Plugin-only install (advanced, no local worker)

If you already have a Captain Memo worker running on another box and just want THIS Claude Code install to talk to it:

```bash
claude plugin marketplace add kalinbogatzevski/captain-memo
claude plugin install captain-memo@captain-memo
```

The plugin only ever talks to a worker on **localhost** (`CAPTAIN_MEMO_WORKER_PORT` overrides the port, not the host), so forward the remote worker's `:39888` onto this machine's localhost — e.g. `ssh -L 39888:localhost:39888 <remote-host>`. This is a power-user setup; most people should run the wizard.

### Updating

```bash
claude plugin update captain-memo@captain-memo
```

Use the **fully-qualified id** (`captain-memo@captain-memo`). The simplest upgrade is to **re-run `captain-memo install`** — it refreshes Claude Code's plugin cache for you. (A `directory`-source marketplace is snapshotted at *add* time, so a bare `claude plugin marketplace add` is a no-op once it exists; the installer does `marketplace remove`→`add` to force a fresh copy of the current hooks + bundle.) To refresh by hand instead: `claude plugin marketplace remove captain-memo` then `claude plugin marketplace add <path>`. A GitHub marketplace re-fetches on its own.

**Auto-updates.** Install the plugin from the **GitHub marketplace** (`claude plugin marketplace add kalinbogatzevski/captain-memo`) and Claude Code re-fetches new versions on its own — **no git required**. When a newer version goes live, Captain Memo's SessionStart hook self-heals the worker to it and shows a one-time **`⚓ Captain Memo self-upgraded: vX → vY`** banner. It only ever touches the plugin + worker process — **never** your `worker.env`, config, or corpus. Opt out of the auto worker-restart with `CAPTAIN_MEMO_DISABLE_SELF_HEAL=1`. (The local-clone full install is a `directory`-source snapshot Claude Code doesn't auto-refetch, so there you upgrade by re-running `captain-memo install`.)

### Windows (native)

Captain Memo runs natively on **Windows x64** — no WSL required.

```powershell
git clone https://github.com/kalinbogatzevski/captain-memo
cd captain-memo
bun install            # MUST run on Windows x64 — see note below
bun .\bin\captain-memo install
```

Requirements and behavior on the native path:

- **Bun on PATH** ([bun.com](https://bun.com)). The same `bun` runs the worker, the MCP server, and the hooks.
- **Run `bun install` on the Windows x64 machine.** `sqlite-vec` ships its native loadable extension per-platform; the x64 install pulls in `vec0.dll`. A `node_modules` copied from Linux/macOS lacks the DLL and the worker can't load vectors. **`win32-arm64` is unsupported** — on ARM64 hardware, run x64 Bun under emulation.
- **Hosted Voyage is the default embedder** — pure HTTPS, nothing local to install or misconfigure. The local Python sidecar (`local-sidecar`) is still available on Windows via a PowerShell installer if you want offline embeddings.
- **Supervision is a per-user Scheduled Task**, not systemd. The wizard registers `captain-memo-worker` to start at logon with restart-on-failure — no admin / UAC prompt. Config lives at `%APPDATA%\captain-memo\worker.env`.

After the wizard, **fully restart Claude Code** (run it on Windows too) for the plugin to load.

#### Upgrading on Windows

To move an existing native install to a newer release:

```powershell
# The worker runs from your checkout; find it if you're unsure:
#   (Get-ScheduledTask -TaskName 'captain-memo-worker').Actions[0].WorkingDirectory
cd <your captain-memo checkout>
git pull
bun install                       # refresh deps (and vec0.dll) on this x64 box
Stop-ScheduledTask -TaskName 'captain-memo-worker'; Start-ScheduledTask -TaskName 'captain-memo-worker'
captain-memo doctor               # confirm the worker is healthy on :39888
```

The Windows CLI shim runs the TypeScript source directly (`captain-memo.cmd` → `bun "<repo>\src\cli\index.ts"`), so `git pull` makes the new CLI live **with no rebuild** — `captain-memo help` then prints the new version. Re-running `bun .\bin\captain-memo install` is an equivalent, idempotent alternative: it replaces the Scheduled Task in place (`schtasks … /F`) and re-grants permissions. If `captain-memo` isn't on PATH, prefix every command with `bun bin\captain-memo` from the checkout.

Re-running `bun .\bin\captain-memo install` also **refreshes the plugin cache** for you (it does `marketplace remove`→`add`), so the cached hooks and MCP bundle always match your checkout — there's no separate `claude plugin update` step to remember. `captain-memo doctor` should then report all green. The `/stats` version (`captain-memo stats`) updates once the worker task has restarted, since the worker reads its version at process start.

If Claude Code is in a restrictive permission mode (e.g. "don't ask") and the plugin's tools get auto-denied, allowlist them once in `%USERPROFILE%\.claude\settings.json` — `captain-memo install` (v0.2.7+) writes this for you, and `--no-grant-permissions` opts out:

```json
{ "permissions": { "allow": ["mcp__plugin_captain-memo_captain-memo__*"] } }
```

`settings.json` is read at session start, so **restart the CLI after editing it.**

### WSL2 fallback

If you'd rather not run the native path — or you want the local Python sidecar with zero native-Windows work — run Captain Memo inside **WSL2** and treat it as a Linux box:

1. Enable WSL2 and install a distro (e.g. `wsl --install`).
2. Inside the WSL distro, run the **unchanged Linux installer** exactly as documented above (`git clone` → `bun install` → `./bin/captain-memo install`).
3. **Run Claude Code inside WSL too**, so its hooks and MCP server reach the worker over localhost in the same Linux environment.

This is the simplest route for local-sidecar-heavy users: everything stays on the supported Linux path.

### Other lifecycle commands

```bash
captain-memo doctor              # health check across all components
captain-memo restart             # restart the worker (reload config / recover; --force to hard-stop)
captain-memo connect             # re-wire the other AI tools to this worker (--list to see them)
captain-memo uninstall           # clean removal (--purge for data too)
captain-memo uninstall --system  # for the system-mode install
```

### Backup & restore

Move a captain's memories to a new machine, or recover them after a loss:

```bash
captain-memo backup create --out ~/cm-backup.tar.gz   # hot snapshot; worker stays up
captain-memo backup info ~/cm-backup.tar.gz           # inspect without restoring
captain-memo backup restore ~/cm-backup.tar.gz --force # replace the local corpus
```

The archive contains your memory DBs, config, **and `worker.env` (API keys)** — it is
written `chmod 600`; store it securely. On restore, vectors are reused when the target
embedder matches the backup, and otherwise rebuilt from source automatically.
Merging two corpora (`import`) is planned separately.

### Local device pairing

Pair a second device (phone, tablet, another machine) to this captain's memory — no hub, no
external relay, entirely self-hosted:

```bash
captain-memo gateway pair --label "phone"     # prints a one-time token + connector URL
captain-memo gateway list                     # show paired devices
captain-memo gateway revoke <device-id>       # remove a device; its token stops working at once
captain-memo restart                          # apply the change
```

Revoking a device blocks any new connection immediately; an already-connected session keeps
working until it closes or you restart the worker.

The worker itself serves an authenticated HTTP-MCP listener (localhost-only) once a device is
paired — nothing runs unless you pair something. Reach it from outside your machine via your own
reverse proxy (nginx, Caddy, a tunnel) with TLS; captain-memo never binds a public interface or
manages certificates itself. Every paired device gets the same tool access a local session has —
there's no separate identity or trust model to configure, just this one corpus, one more
authenticated way in.

---

## Inside Claude Code

After install + a full Claude Code restart, the plugin exposes two layers to every session:

### 5 slash commands you can type directly

```
/captain-memo:search <query>      # hybrid search across memory + skills + observations, top 5 hits
/captain-memo:recall <doc_id>     # full content of a hit (use the doc_id from a search result)
/captain-memo:observations        # recent captured session observations (--limit N optional)
/captain-memo:stats               # corpus stats inline in chat
/captain-memo:doctor              # health probe inline in chat
```

### 12 MCP tools the model calls automatically

These fire when the model decides retrieval would help your prompt — no slash command required. List them anytime with `/mcp`:

| Tool | Purpose |
|---|---|
| `search_all` | Hybrid search across all channels |
| `search_memory` | Curated memory only (filter: type, project) |
| `remember` | Persist a durable decision / preference / fact into curated memory (create or update-in-place) |
| `search_skill` | Skill bodies only (filter: skill_id) |
| `search_observations` | Past session observations (filter: type, files, since) |
| `get_full` | Full content of a hit by `doc_id` |
| `reindex` | Trigger re-embed |
| `stats` | Corpus stats |
| `status` | Worker health |
| `work_set` | Coordination board: publish/refresh "I'm working on X, touching these files"; returns any overlapping claims |
| `work_active` | Coordination board: list live claims, and which overlap yours |
| `work_clear` | Coordination board: drop your claim early (task done) |

## CLI commands (any terminal)

```bash
captain-memo status              # is the worker reachable?
captain-memo stats               # corpus stats by channel + indexing progress
captain-memo top                 # interactive live stats (htop-style); press ? for help
captain-memo dedup               # fold near-duplicate observations (dry-run by default)
captain-memo reindex             # cheap sha-diff reindex (or --force to re-embed)
captain-memo remember            # persist a curated memory entry (--type, --name, --slug; body via --body/--file/stdin)
captain-memo observation list    # recent captured observations
captain-memo observation flush   # force-drain the queue
captain-memo config show         # effective config (secrets masked)
captain-memo doctor              # component health probe
captain-memo install             # interactive install wizard
captain-memo connect             # wire other AI tools (Codex, Gemini, Cursor, opencode…) to this worker (--list)
captain-memo uninstall           # clean removal
captain-memo inspect-claude-mem        # read-only row counts of ~/.claude-mem/
captain-memo migrate-from-claude-mem   # one-time migration (--dry-run for preview)
```

`status` and `stats` accept `--json` for machine-readable output — handy for statuslines, dashboards, monitoring probes. `captain-memo watch` is a deprecated alias for `top`.

### Interactive `top` (v0.1.16)

`captain-memo top` is an htop-style live view of how memory is being used. A
compact dashboard (corpus + recall + a "last surfaced" pulse) opens onto a
navigable table you can reshape in place:

- `s` / `r` / `n` — Surfaced / Recalled / Recent views
- `↑↓` / `j` `k`, `PgUp` / `PgDn`, `g` / `G` — move + page the selection
- `o` sort · `t` type filter · `/` find-by-title · `c` collapse near-duplicates
- `Tab` cycle views (in the table) · `+` / `-` refresh rate (on the dashboard)
- `⏎` open the full observation (counts as a drill) · `Esc` back · `?` help · `q` quit

A live date/time clock sits top-right and advances on every refresh, so you can
see the data updating. Piped (non-TTY) stdout falls back to a single static
`stats` render.

## Recipes

- **[Statusline integration](docs/statusline-integration.md)** — surface worker health, observation count, disk usage, and indexing progress in your Claude Code status bar. Cached for sub-millisecond reads; uses the `--json` output from `stats` / `status`.

### Token-savings badges

Each captured observation records how many tokens the summarizer spent producing it (`work_tokens = input + output`). When the `<memory-context>` envelope is built, a per-hit savings badge shows how much was compressed compared to injecting the raw session events. By default only the percentage is shown; the absolute amounts are opt-in so the envelope stays concise.

| Env var | Default | Shows |
|---|---|---|
| `CAPTAIN_MEMO_SHOW_SAVINGS_PERCENT` | `1` (on) | `saved X%` |
| `CAPTAIN_MEMO_SHOW_SAVINGS_AMOUNT` | `0` (off) | `N tokens saved` |
| `CAPTAIN_MEMO_SHOW_WORK_TOKENS` | `0` (off) | `work N` |
| `CAPTAIN_MEMO_SHOW_READ_TOKENS` | `0` (off) | `recall N` |

Set any flag to `0` to hide it, or `1` to show it. When all four are `0` no badge line is emitted. Observations captured before v0.1.6, and those migrated from claude-mem without a `discovery_tokens` record, silently skip the badge (`work_tokens = NULL`). Migrated observations that _do_ have a `discovery_tokens` value inherit it as `work_tokens` so the badge renders for historical data too.

### Recall audit log

Disabled by default. Enable with `CAPTAIN_MEMO_RECALL_AUDIT=1` in your `worker.env` to start recording retrieved hits and boost provenance to `${CAPTAIN_MEMO_DATA_DIR:-~/.captain-memo}/recall-audit.jsonl` (one JSON line per auto-injection — the `UserPromptSubmit` hook's `/inject/context` call; explicit MCP searches are not audited). Each line records the timestamp, session and project IDs, the query, and for every returned hit: the chunk ID, channel, score, a 200-character snippet, and which of the identifier-match, rare-token, or same-branch boosts fired and with what multiplier. The active rank profile is recorded on each line too. Useful for tuning the search boosts against real prompts. The file is append-only; rotate manually if needed.

### Retrieval tracking with provenance (v0.1.12+)

Always on, zero config. Every observation chunk surfaced by the worker is counted, broken down by which path surfaced it. Three counters on each `observations` row track the breakdown, plus a single `last_surfaced_at` timestamp:

| Column | Bumped by | Semantic meaning |
|---|---|---|
| `from_auto`   | `/inject/context` (the `UserPromptSubmit` hook) | Memory thematically matched what you were typing — *passive surfacing* |
| `from_search` | `/search/all` · `/search/memory` · `/search/skill` · `/search/observations` | You or Claude explicitly searched — *active surfacing* |
| `from_drill`  | `/get_full` | The full content was actually fetched — *drilled in* (strongest signal of usefulness) |

The bump is fire-and-forget and exception-safe — a write failure cannot fail the originating search/inject request.

Pre-v5 schemas used a single `retrieval_count` column that only covered `/search/*` and `/get_full`. The migration to v5 backfills historical bumps into `from_search` (the dominant pre-v5 path) so no signal is lost; the legacy columns remain on the row but are no longer written.

#### Why provenance matters

Without a per-path breakdown, "this observation was retrieved 142 times" is ambiguous. Two failure modes hide in that single number:

1. **Popular by accident.** A row keeps tripping over auto-injection because its embedding lexically resembles many prompts. High `from_auto`, low `from_search`, zero `from_drill` = candidate for downranking or Dreaming compaction.
2. **Popular by intent.** You actively search for and drill into the row. Low `from_auto`, high `from_search`, non-zero `from_drill` = exactly what memory exists for.

`captain-memo stats` surfaces this directly:

```
Recall ──────────────────────────── how memory actually gets used
Last surfaced  4s ago · [discovery] update-status skill… · auto
Surfaced      9 876 / 18 470   (53.5% of corpus)
Recalled         42 / 18 470   (0.23% of corpus)
Drill-in rate  0.43%   (42/9876 recalled out of surfaced)

Top surfaced
  142×  [feature] Add retrieval tracking fields…
        auto: 138   search: 3   drill: 1
   17×  [discovery] update-status skill command… (+3 similar)
        auto: 17    search: 0   drill: 0
```

The "last surfaced" pulse and the `(+N similar)` near-duplicate collapse are new
in v0.1.16; `captain-memo top` makes the same data interactive.

You can also query directly:

```bash
sqlite3 ~/.captain-memo/observations.db \
  "SELECT id, type, title,
          from_auto, from_search, from_drill,
          datetime(last_surfaced_at, 'unixepoch') AS last_surfaced
   FROM observations
   WHERE (from_auto + from_search + from_drill) > 0
   ORDER BY from_drill DESC, (from_auto + from_search) DESC
   LIMIT 20;"
```

The signal feeds future importance / decay scoring and "Dreaming" clustering — clusters of observations you actually keep drilling into, not just clusters that happen to share vocabulary.

### Vendor provenance (v0.16.0+)

Every captured observation is tagged with which AI tool wrote it — `claude-code`, `codex`, `cursor`, `gemini`, `opencode`, `vibe`, `vscode`, `jetbrains`, or `unknown` for older/unattributed rows — surfaced in `metadata.origin_agent` on every search and `get_full` hit. Today only Claude Code's hooks actively capture (the other tools are read-only recall, see [Cross-AI](#what-it-is)), so this is foundational: the tag is already there, ready for when another vendor's capture path lands, and it never blocks a capture — an unrecognized or missing signal always degrades to `unknown`, never an error.

## Migrating from claude-mem

If you've been using [`claude-mem`](https://github.com/thedotmack/claude-mem) and want to bring your existing observations and session summaries into Captain Memo, the migration is one command. Your claude-mem install stays intact — Captain Memo only **reads** from `~/.claude-mem/claude-mem.db`, never modifies it.

```bash
# Preview what would migrate (no writes)
captain-memo migrate-from-claude-mem --dry-run

# Run the actual migration
captain-memo migrate-from-claude-mem

# Flags:
#   --dry-run             preview only, no writes
#   --limit N             cap at N source rows (useful for testing)
#   --from-id <obs_id>    resume from a specific observation
#   --project <id>        target project id (default: $CAPTAIN_MEMO_PROJECT_ID or "default")
#   --db <path>           source DB (default: ~/.claude-mem/claude-mem.db)
```

While running, you'll see a live progress bar (`⠋ obs ████████░░░░░░░░ 5,234/13,440 (39%)  10.2/s  ETA 13m 22s`) and, on completion, a side-by-side comparison of the source claude-mem DB vs your new Captain Memo data dir — disk size, row counts, channel breakdown, observed date range.

The migration is **idempotent** (re-runs skip already-migrated rows via a progress table) and **resumable** (interrupt + resume via `--from-id`). Both claude-mem and Captain Memo can coexist running side-by-side after migration.

---

## Schema upgrades

Each SQLite database owned by the worker (`observations.db`, `queue.db`, etc.) maintains its own `schema_versions` table. Stores declare their changes as an ordered migration list; on every worker startup the runner applies any that are not yet recorded.

You never need to run manual `ALTER TABLE` commands. For installs that already have columns from an earlier release (before v0.1.7), the runner recognises the "duplicate column" error as idempotent recovery and marks the migration applied without re-running.

### Upgrading to v0.1.8 (chunking strategy change)

v0.1.8 changes the observation chunker from "1 narrative chunk + N per-fact chunks" to **1 bundled chunk per observation** (title + narrative + facts together, with a `[type]` structural prefix). This cuts vector-db size by ~80% for the observation channel without losing keyword recall (FTS5 still indexes every fact word), and lifts top-K diversity because one observation now occupies one slot instead of 3–6.

The change is opt-in: existing observations keep their old chunk shape and remain searchable until you reindex. The worker prints a one-line notice at startup whenever pre-v0.1.8 chunks are detected, and the fastest way to migrate is one command:

```bash
captain-memo upgrade
```

That handles the entire chain: starts the worker if needed, runs the batched reindex (resumable across crashes), stops the worker for VACUUM, reclaims freed pages from `meta.sqlite3` + `vector-db/embeddings.db`, and restarts the worker. Pass `--dry-run` first if you want to see what it would do without touching anything. The whole upgrade is idempotent — safe to re-run.

If you'd rather drive the steps individually:

```bash
captain-memo reindex --channel observation --force # re-chunk every observation under the
                                                   # new strategy; worker stays up.
                                                   # Batched 32/Voyage-call; resumable —
                                                   # re-run without --force to continue
                                                   # from where it left off.

systemctl --user stop captain-memo-worker          # vacuum needs an exclusive lock
captain-memo vacuum                                # reclaim freed pages from meta + vec-db
systemctl --user start captain-memo-worker
```

Optional — a **fresh** claude-mem import now lands at the smaller, structured shape (the migration delegates to the same chunker):

```bash
captain-memo migrate-from-claude-mem               # idempotent; safe to re-run
```

Note: this does **not** shrink a corpus you already imported — the migration skips rows recorded in `migration_progress`, and `reindex` covers Captain Memo's own observations, not migrated claude-mem documents.

Run `captain-memo doctor` to see which migrations have been applied per database:

```
Schema migrations:
  observations.db:      13/13 applied
    [1] add_branch      (2026-05-11T...)
    [2] add_work_tokens (2026-05-11T...)
    ...
  queue.db:             1/1 applied
    [1] add_last_error  (2026-05-11T...)
```

---

## What's inside

| Component | What it does |
|---|---|
| **Worker** (`:39888`) | Long-lived HTTP daemon. Owns the SQLite + sqlite-vec stores, file watcher, observation queue, summarizer + embedder wiring. |
| **Embedder** | Pluggable: hosted Voyage API (default), local voyage-4-nano sidecar (`:8124`), or any OpenAI-compatible `/v1/embeddings` endpoint. |
| **Summarizer** | Pluggable: Claude Max via OAuth (default, no API key), Anthropic API, `claude -p` subprocess, or any OpenAI-compatible `/v1/chat/completions`. |
| **MCP server** (stdio) | Exposes 12 tools to Claude Code (`search_all`, `search_memory`, `remember`, `search_skill`, `search_observations`, `get_full`, `reindex`, `stats`, `status`, `work_set`, `work_active`, `work_clear`). |
| **Six hooks** | `SessionStart` (corpus banner), `UserPromptSubmit` (inject memory envelope, ≤1.5 s budget), `PreToolUse` (work-board claim + overlap/git warning, advisory only), `PostToolUse` (queue tool-use events), `Stop` (drain → summarize → index), `PreCompact` (capture before context compaction). |
| **CLI** | The commands above. |

Channels indexed: `memory` (curated user memory files), `skill` (Claude Code skill bodies, section-level), `observation` (summarized session events). Observations age at search time: Tide (on by default) demotes stale hits with a bounded multiplier that never falls below a 0.30 relevance floor, so newer truth ranks above stale truth without losing history. (`CAPTAIN_MEMO_TIDE_ENABLED=0` falls back to the older flat exponential decay, 90-day half-life.)

Detailed docs: [`docs/USAGE.md`](docs/USAGE.md).

---

## Status

| Plan | Scope | State |
|---|---|---|
| 1 | Worker, MCP server, CLI, hybrid search, file watcher, ingest pipeline | Shipped |
| 2 | Hooks + observation pipeline + 4-provider summarizer + 4-provider embedder | Shipped |
| 3 — Layer A | claude-mem migration (`inspect-claude-mem`, `migrate-from-claude-mem`) | Shipped |
| 3 — Layer B | OAuth-direct summarizer (no API key needed) · recency decay · install wizard fast-path defaults | Shipped |
| 3 — Layers C-G | observation dedup + supersede (`dedup`, `supersede`) · retrieval-quality eval (`eval seed` / `eval run`) | Shipped |
| 3 — remaining | MEMORY.md transformation · `forget` · doctor enhancements | Planned |

1072 tests pass across 160 files. Typecheck clean. Bun ≥ 1.1.14, TypeScript strict.

---

## Why "Captain Memo"

The captain keeps the ship's log. Every voyage gets entered. When the ship sails again, the captain remembers what happened on the last one — the storms, the trade winds, the islands that turned out to have fresh water. That's what this plugin does for your AI coding sessions.

The metaphor extends throughout the codebase: memory files = logbook entries, observations = voyage logs, the file watcher = lookout in the crow's nest, claude-mem migration = transferring the old ship's log.

(There's a tiny in-joke in the name too. *cap**TAI**n* — the AI was always there, hiding in plain sight.)

---

## Open source, because

The people most likely to benefit are people working the way I work — alone or in small teams, on real systems, in languages other than English, with budgets that don't include a per-call billing line. The same shape of problem keeps showing up: *my AI forgets between sessions and I'm tired of re-saying the same things*. If you've felt that, this is the tool I wish I'd had a year earlier.

Apache 2.0-licensed. Run it locally, point it at any LLM you have, and tell it nothing it doesn't need to know. Captain Memo logs the voyage; you stay the captain.

> By day I work on the commercial side — [**ISPCQ**](https://ispcq.com), the multi-tenant ERP platform Captain Memo's engineering DNA came from. Different product, same approach to careful, locally-sovereign software. If you run an ISP and want a turnkey ERP with the same care put into it, that's where to look.

## Contributing

Issues + PRs welcome.

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

— Kalin
