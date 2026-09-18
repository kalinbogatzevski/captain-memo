<p align="center">
  <img src="docs/logo.png" alt="Captain Memo — The Ship-Log for Your Digital World" width="320">
</p>

<h1 align="center">Captain Memo</h1>

<p align="center"><em>Your AI fleet's local memory, shared skill library, and runtime capability map.</em></p>

<p align="center">
  <a href="https://captain-memo.ispcq.com"><b>captain-memo.ispcq.com</b></a> · Built by <a href="https://github.com/kalinbogatzevski">Kalin Bogatzevski</a> · <a href="LICENSE">Apache-2.0</a> · <a href="https://github.com/kalinbogatzevski/captain-memo/issues">Issues</a>
</p>

Captain Memo is a Claude Code plugin — and a **cross-AI local intelligence layer**: one local corpus shared by every MCP-speaking coding agent on your machine (Claude Code, Codex, Gemini CLI, Antigravity, goose, Cursor, opencode, Kimi CLI). What one tool learns, the others recall; skill instructions installed for one AI become reusable **Virtual Skills**; and sanitized **Virtual Capabilities** tell the crew which runtime owns a plugin or extension that can execute a task.

> **Memory is only the beginning.** Captain Memo automatically synchronizes complete skill instructions, lists them for every connected AI, and maps runtime-specific plugins without copying commands, credentials, or executable configuration. An AI can learn a shared method locally, or discover that (for example) an image tool lives on Gemini and delegate the work there. [See how Virtual Skills & Capabilities work →](https://captain-memo.ispcq.com/skills.html)

<p align="center">
  <img src="docs/demo.gif" alt="Terminal recording: `captain-memo connect` wires six installed AI tools to one shared worker, then `captain-memo stats` shows four of them writing into the same local corpus" width="820">
</p>

<p align="center"><sub>One command wires every AI coding tool on the machine. They all read and write <b>one</b> local corpus.</sub></p>

> **Platforms — Linux, macOS and native Windows (x64).** Linux runs under `systemd --user`; **macOS runs as a per-user launchd LaunchAgent** (no root — see [macOS](#macos) below); Windows runs natively under a per-user Scheduled Task (no WSL, no admin) — see [Windows (native)](#windows-native), or the [WSL2 fallback](#wsl2-fallback). One `ServiceManager` interface, three supervisors; the CLI is identical on all three.

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
- **Cross-AI — one corpus, many tools.** Claude Code, Codex, Gemini CLI, Antigravity (`agy`, the Gemini-CLI successor), goose, Cursor, opencode, Mistral Vibe, Kimi CLI, VS Code (Copilot), and JetBrains (AI Assistant) all share the same local memory through Captain Memo's MCP server + a portable skill. `captain-memo install` (or `captain-memo connect`) auto-detects the AI tools on your machine and wires each one — no manual setup. Current Codex, Gemini, and Kimi releases also get native lifecycle hooks for automatic recall and observation capture; older or disabled hook implementations stay on the transcript reader automatically. See [docs/cross-ai-tools.md](docs/cross-ai-tools.md).
- **Auto-discovered memory — every assistant, not just Claude.** `CAPTAIN_MEMO_WATCH_MEMORY=auto` (the install default) probes the machine and indexes whichever AI memory files actually exist: `~/.claude/CLAUDE.md`, per-project Claude memories, `~/.codex/`, `~/.gemini/`, `~/.cursor/rules/`, repo-level `AGENTS.md` / `CLAUDE.md` / `.github/copilot-instructions.md`. Each doc is tagged with the `tool` it came from. Composes with your own globs (`auto,/my/notes/*.md`). Credentials and session logs are structurally unindexable — every discovery glob must end in `.md`/`.mdc`, which is enforced by a test, not a blocklist.
- **Virtual Skills — one synchronized skill repository for every AI.** Captain Memo mirrors the user-level `SKILL.md` files installed for Claude Code, Codex, Gemini, Cursor, opencode, Vibe, Kimi and more into its local SQLite corpus, preserving complete instructions, provenance, hashes and portability warnings. Discovery is **AUTO when `CAPTAIN_MEMO_WATCH_SKILLS` is missing**; set it to an explicitly empty value to opt out. Native files remain canonical and edits/deletions synchronize live. Humans can browse with `captain-memo skill list`; connected assistants use `list_skills`, `recommend_skills` and `load_skill`. Imported instructions remain advisory, and the existing backup/restore path carries the repository with the rest of Captain Memo.
- **Virtual Capabilities — the fleet knows where work can actually run.** Captain Memo auto-discovers installed Gemini/Agy extensions plus Claude and Codex plugins, then stores a sanitized descriptor in the same SQLite corpus: name, description, version, operation names, interface names, and owning runtime. It never imports command bodies, executable configuration, environment values, or credentials. Use `captain-memo capability list`, `capability recommend`, or the `list_capabilities` / `recommend_capabilities` / `get_capability` MCP tools. A result says “delegate this to Gemini on this captain,” not “pretend this plugin runs in every CLI.” Missing `CAPTAIN_MEMO_WATCH_CAPABILITIES` means **AUTO**; explicitly empty opts out.
- **Hybrid search.** Voyage embeddings (default) + SQLite FTS5 keyword index, fused by weighted cosine + BM25 scoring (RRF still available via the `legacy` rank profile), with a recency-aware re-rank on observations. Multilingual (BG/EN/etc.) — your non-English memory is searchable too. The keyword half only sees the words that can select anything: stopwords and one- or two-letter tokens are dropped before the FTS5 query, and at most the 12 longest tokens go in — on a 191K-chunk corpus that cut the keyword leg from 2 s to about half a second with the same hits. The vector half is unchanged, so an all-stopword query still answers, but a bare two-letter identifier now matches only through the vector half.
- **Six summarizer providers**, picked at install time — *three of them need no API key at all*:
  - `claude-oauth` *(default)* — direct Anthropic API using the OAuth token Claude Code already stored. No API key. ~700 ms/call. Just works on a Max plan.
  - `codex` — **`codex exec` on your ChatGPT Plus/Pro account. No API key, no Anthropic subscription needed.** The zero-key option if you don't have Claude Max. ~6–7 s/call (that's Codex booting its agent runtime, not inference — it's flat across the model ladder, so a small model saves quota, not time). Uses your account's own model by default (no slug to keep current). Runs on the background tick, so it never blocks a prompt. Requires `codex login`.
  - `agy` — **Antigravity CLI on a plain Google account.** The widest-reach zero-key option: no Claude plan, no ChatGPT plan, no API key. ~3–5 s/call (measured on `Gemini 3.5 Flash (Low)`) — the *fastest* of the three agent-CLI transports. Uses your account's own model by default. Runs under an isolated `$HOME`, so it never touches your real `agy --continue` history. Needs agy ≥ 1.1.1.
  - `anthropic` — direct Anthropic SDK with `ANTHROPIC_API_KEY` (paid)
  - `claude-code` — `claude -p` subprocess (slower; for users without OAuth file access)
  - `openai-compatible` — Ollama / LM Studio / vLLM / OpenAI / OpenRouter / DeepSeek / Groq / Together / Mistral / etc.
- **Four embedder backends**, picked at install time:
  - `voyage-hosted` *(default)* — Voyage API (`voyage-4-lite`, 1024-dim). Free signup, ~$0.30/year typical use, fast on any hardware.
  - `local-sidecar` — `voyageai/voyage-4-nano` open weights via a self-contained FastAPI sidecar (offline, private, 2048-dim, AVX2 recommended)
  - `openai-compatible` — Any `/v1/embeddings` endpoint (Ollama, OpenAI, OpenRouter, etc.)
  - `skip` — keyword-only retrieval (FTS5 only, no vectors)
- **Auto-injected context.** A `<memory-context>` envelope is added to every user prompt in Claude Code and in native-hook-capable Codex, Gemini, and Kimi releases. The model sees relevant memory, skills, and prior session observations before it answers.
- **Session observations.** Tool-use events from Claude Code and native-hook-capable Codex, Gemini, and Kimi sessions are captured immediately; transcript readers cover older CLIs plus Agy and opencode. Batched events are summarized into structured observations (type / title / facts / concepts) and indexed into the same hybrid search. Native and transcript paths deduplicate per session.
- **Work-coordination board.** Before every file-touching tool call — the edit tools, and Bash/PowerShell commands that *write* (`sed -i`, `>`/`>>`, heredocs, `tee`, `Set-Content`) — a `PreToolUse` hook publishes a transient "I'm touching these files" claim to a shared board. Any other AI tool editing overlapping files — on the same captain, and across the fleet once you're federated — is flagged instantly: by file path, by *topic* (a `work_set` claim carries 1–5 short tags for what the work is *about*, so two sessions on "billing-rounding" collide whatever files they touch), and by *meaning* (a semantic pass catches two agents working on the same thing in different files, which a plain glob match misses). Advisory only, never blocks an edit; claims are leases that auto-expire, so a crashed session never leaves a phantom claim behind.
- **Homework.** Ideas arrive while a session is busy with something else. Type `idea: …` or `todo: …` at the start of a prompt and the hook files it on this machine without spending the turn — the model sees "filed as homework #12, not for now" and says "noted". Every new session lists what is open in its start banner; a session takes an item with `todo_claim` (so no other AI on the machine starts it too) and closes it with `todo_done`. Not a memory (a memory is a fact), not a work claim (a claim is now).
- **Indefinite retention.** No 30-day cleanups. A project takes years; your memory should too.

**One machine is free, forever.** Everything above runs on your own hardware — no account, no server, no key required for the zero-key paths. Nothing is time-limited, feature-gated, or held back. If you end up running agents across *several* machines and want them to share one memory, that's [Captain Fleet](https://fleet.ispcq.com), a separate commercial relay. It is not a trial and this is not a crippled edition; a single machine is the whole product for most people, including me on most days.

---

## Requirements

**Always required:**

| Component | Minimum | Notes |
|---|---|---|
| OS | Linux (systemd), macOS, **or** Windows x64 | macOS uses a per-user launchd LaunchAgent and needs `brew install sqlite` (Apple's SQLite cannot load the vector extension); Windows uses a per-user Scheduled Task. `win32-arm64` unsupported — run x64 Bun under emulation. |
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
| **Claude Max via OAuth** | A Claude Max subscription + `claude login` already done. No API key. |
| **ChatGPT Plus/Pro via Codex CLI** | `codex` on PATH + `codex login` already done. No API key. |
| **Google account via Antigravity CLI** | `agy` ≥ 1.1.1 on PATH, logged in. No API key. |
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
- **Worker daemon** on port 39888, supervised by whatever your OS uses — `~/.config/systemd/user/captain-memo-worker.service` on Linux, `~/Library/LaunchAgents/com.captainmemo.worker.plist` on macOS, a per-user Scheduled Task on Windows
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
| Claude Max via OAuth | You have a Claude Max subscription. Free, fast (~700 ms/call), no API key — Captain Memo reads the OAuth token Claude Code already stored. |
| ChatGPT Plus/Pro via Codex CLI | You have a ChatGPT plan and `codex login` done. No API key; ~6–7 s/call, on the background tick. |
| Google account via Antigravity CLI (`agy`) | You have a Google account and `agy` ≥ 1.1.1 logged in. No API key; ~3–5 s/call. |
| Anthropic API | You want explicit per-token billing or don't have Max. |
| Claude Code subprocess | OAuth not available; falls back to spawning `claude -p` per call (slower). |
| OpenAI / Ollama / OpenRouter | You're routing to a different model fleet. |
| Skip | Events queue but don't summarize (rare; you keep raw events for later). |

There is no fixed recommendation here: the wizard checks which of Claude, Codex and agy is actually logged in on this machine and recommends the first one that is — each option says whether it is logged in here, and a headless install takes that pick. If none of the three is logged in, the interactive wizard says so and tells you to log in and restart the worker; a headless install falls back to Claude via OAuth.

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
| **Auto-detect every installed assistant's memory** *(recommended)* | Claude, Codex, Gemini, Cursor, Copilot, AGENTS.md — whatever exists on this machine (`CAPTAIN_MEMO_WATCH_MEMORY=auto`). |
| All Claude project memories | Index every project's `~/.claude/projects/*/memory/*.md`. |
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

Use the **fully-qualified id** (`captain-memo@captain-memo`). Re-running **`captain-memo install`** always works too — it refreshes Claude Code's plugin cache for you. (A `directory`-source marketplace is snapshotted at *add* time, so a bare `claude plugin marketplace add` is a no-op once it exists; the installer does `marketplace remove`→`add` to force a fresh copy of the current hooks + bundle.) To refresh by hand instead: `claude plugin marketplace remove captain-memo` then `claude plugin marketplace add <path>`. A GitHub marketplace re-fetches on its own.

After a `git pull` (or the opt-in auto-update below) you no longer have to re-run `captain-memo install` to get the new hooks into Claude Code: on the next session start the hook compares the cached plugin's version with the checkout and re-snapshots the cache if they differ. Only a `directory` marketplace pointing at this checkout qualifies — a GitHub-marketplace install already refetches on its own. `captain-memo doctor` shows `plugin cache version` if the two ever drift, and `live plugin version` names any running session that is still on the old copy.

**Auto-updates.** Install the plugin from the **GitHub marketplace** (`claude plugin marketplace add kalinbogatzevski/captain-memo`) and Claude Code re-fetches new versions on its own — **no git required**. When a newer version goes live, Captain Memo's SessionStart hook self-heals the worker to it and shows a one-time **`⚓ Captain Memo self-upgraded: vX → vY`** banner. It only ever touches the plugin + worker process — **never** your `worker.env`, config, or corpus. Opt out of the auto worker-restart with `CAPTAIN_MEMO_DISABLE_SELF_HEAL=1`. (The local-clone full install is a `directory`-source snapshot Claude Code doesn't auto-refetch, so there you upgrade with `git pull` — the cache follows on the next session start, as above — or by re-running `captain-memo install`.)

**Auto-updates for a git-clone install (opt-in).** A local `git clone` install isn't refreshed by Claude Code, so it normally stays put until you `git pull`. Set **`CAPTAIN_MEMO_AUTO_UPDATE=1`** and Captain Memo will, on session start, **fast-forward your checkout to the newest stable `vX.Y.Z` tag** on its own `origin`, run `bun install`, restart the worker, and show a **`⚓ Captain Memo auto-updated: vX → vY`** banner. Safety rails: it **only** fast-forwards (never a merge/rebase), **refuses a dirty work-tree or detached HEAD** (never clobbers local edits), ignores pre-release tags, and is throttled to one `git fetch` per 6h (`CAPTAIN_MEMO_AUTO_UPDATE_INTERVAL_MS`). Opt-in only — off by default, because auto-pulling a developer's checkout should be a choice. It never runs on a marketplace install (those already self-update above).

**While the worker is between versions, the hook waits instead of killing it.** A worker that is restarting onto a new version, or is still booting, leaves a breadcrumb at `~/.captain-memo/.worker-transition` (120 s TTL); the session-start hook reads it and waits up to 20 s (`CAPTAIN_MEMO_SESSION_START_TRANSITION_WAIT_MS`) instead of reclaiming the port and reporting "worker unreachable" — which is what used to make people restart Claude for nothing. The banner then reads `⚓ Captain Memo — updating (v0.40.2 → v0.41.0)` and says memory resumes by itself, no need to restart Claude; the Stop hook says once when memory is back. A fresh breadcrumb means wait, not kill; a stale one (a crash loop, a clock jump) ages out after 120 s and self-heal runs as before.

### macOS

Captain Memo runs on macOS as a **per-user launchd LaunchAgent** — no root, no `sudo`, nothing in `/Library`.

```bash
git clone https://github.com/kalinbogatzevski/captain-memo
cd captain-memo
bun install
brew install sqlite          # required — see below
./bin/captain-memo install
```

**`brew install sqlite` is not optional.** Apple ships `libsqlite3` built with `SQLITE_OMIT_LOAD_EXTENSION`, and Bun links against the system library — so the `vec0` vector extension cannot load and the worker exits on its first vector open. Captain Memo points Bun at the Homebrew build via `Database.setCustomSQLite()`, but the Homebrew build has to exist. The install wizard's pre-flight checks for it and tells you if it's missing.

What the install puts on your Mac:

| What | Where |
|---|---|
| LaunchAgent | `~/Library/LaunchAgents/com.captainmemo.worker.plist` |
| Worker logs | `~/.captain-memo/logs/captain-memo-worker.log` (+ `.err.log`) |
| Config | `~/.config/captain-memo/worker.env` |
| Corpus | `~/.captain-memo/` |

Managing it by hand, if you want to:

```bash
launchctl print gui/$(id -u)/com.captainmemo.worker     # full state, last exit status
launchctl kickstart -k gui/$(id -u)/com.captainmemo.worker   # restart
launchctl bootout gui/$(id -u)/com.captainmemo.worker        # stop (unload)
captain-memo doctor                                     # or just ask the CLI
```

Two macOS behaviours worth knowing:

- **launchd throttles restarts.** It refuses to relaunch a job more than once per `ThrottleInterval` (10s is its floor) and `launchctl kickstart` *blocks* while throttled — so a restart can legitimately take a few seconds. Captain Memo waits it out rather than reporting a failure.
- **Login Items names Bun, not us.** macOS attributes a background item to the code-signing identity of the program it runs, and ours is `bun` — so you may see *"software by Jarred Sumner can run in the background"*. That's Bun's author. The plist declares `AssociatedBundleIdentifiers` to re-attribute it, which takes full effect once a signed Captain Memo bundle ships.

macOS support landed in **0.27.27–0.27.29**, built and shipped from three field reports in one afternoon — thanks to the Mac users who reported them.

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
- **All six summarizers work on the native path**, including the agent CLIs (`codex`, `agy`, `claude -p`) — the wizard checks which one is logged in and recommends it. Upgrading from a release before 0.43.3? Re-run `captain-memo connect` so the Codex and Gemini hooks are rewritten in a form PowerShell runs — see [Native lifecycle capture](docs/native-lifecycle-capture.md#failure-and-upgrade-behavior).

After the wizard, **fully restart Claude Code** (run it on Windows too) for the plugin to load.

#### Upgrading on Windows

To move an existing native install to a newer release:

Takes ~2 minutes. Your memory, `worker.env`, and API keys are **not** touched — only the code updates.

```powershell
# 1. Go to your checkout. If unsure where it is, this prints the folder:
#    (Get-ScheduledTask -TaskName 'captain-memo-worker').Actions[0].WorkingDirectory
cd <your captain-memo checkout>

# 2. Pull the new version + refresh deps (and the vec0.dll native lib) on this x64 box:
git pull
bun install

# 3. Restart the worker so it loads the new code (it reads its version at process start):
Stop-ScheduledTask -TaskName 'captain-memo-worker'; Start-ScheduledTask -TaskName 'captain-memo-worker'

# 4. Run the data upgrade — re-indexes memory to the new chunk format + compacts the DB.
#    Safe to run, safe to re-run, resumes if interrupted. Don't skip it: the /stats version
#    may not fully settle until this has run.
captain-memo upgrade

# 5. Verify:
captain-memo doctor               # all green; worker healthy on :39888
captain-memo stats                # the `Summarizer` line shows which provider is live
```

The Windows CLI shim runs the TypeScript source directly (`captain-memo.cmd` → `bun "<repo>\src\cli\index.ts"`), so `git pull` makes the new CLI live **with no rebuild** — `captain-memo help` then prints the new version. Re-running `bun .\bin\captain-memo install` is an equivalent, idempotent alternative: it replaces the Scheduled Task in place (`schtasks … /F`) and re-grants permissions. **If `captain-memo` isn't on PATH, prefix every command with `bun bin\captain-memo`** from the checkout (e.g. `bun bin\captain-memo upgrade`).

**Skip all of this next time — turn on auto-upgrade** (from this version on). Set it once, then fully restart Claude Code:

```powershell
[Environment]::SetEnvironmentVariable('CAPTAIN_MEMO_AUTO_UPDATE','1','User')
```

Captain then checks for a newer release on session start (≤ once per 6 h), fast-forwards your checkout, `bun install`s, restarts the worker, and reports the upgrade — rolling back automatically if the new code fails to start. It only ever touches a **clean** checkout, so it never clobbers local edits. (Set it as a real environment variable, **not** in `worker.env` — the session-start hook that runs it reads the process environment.)

Re-running `bun .\bin\captain-memo install` also **refreshes the plugin cache** for you (it does `marketplace remove`→`add`), so the cached hooks and MCP bundle always match your checkout — there's no separate `claude plugin update` step to remember. The next session start does the same on its own whenever the cached plugin's version differs from the checkout, so after a plain `git pull` the cache follows without re-running the installer. `captain-memo doctor` should then report all green. The `/stats` version (`captain-memo stats`) updates once the worker task has restarted, since the worker reads its version at process start.

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
captain-memo uninstall           # clean removal (keeps worker.env as worker.env.bak; --purge for data too)
captain-memo uninstall --system  # for the system-mode install
```

`captain-memo restart` only says ✓ once a *new* worker process is answering — it compares the worker's start stamp before and after, so it cannot confirm the very process it was about to kill; an unconfirmed restart is reported as unconfirmed, never as success.

`uninstall` moves `worker.env` (API keys, summarizer, embedder, anything you added by hand) to `worker.env.bak` instead of deleting it, and the next `captain-memo install` restores it when the live file is missing — so a reinstall comes back with your keys pre-filled (a headless `install --yes` asks nothing). Delete the `.bak` for a clean slate. The installer also copies the file aside before every rewrite, with the same owner-only lock as the live file (0600; icacls on Windows).

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

### 22 MCP tools the model calls automatically

These fire when the model decides retrieval would help your prompt — no slash command required. List them anytime with `/mcp`:

| Tool | Purpose |
|---|---|
| `search_all` | Hybrid search across all channels |
| `search_memory` | Curated memory only (filter: type, project) |
| `remember` | Persist a durable decision / preference / fact into curated memory (create or update-in-place) |
| `search_skill` | Skill bodies only (filter: skill_id) |
| `list_skills` | List synchronized virtual skills, optionally filtered by source AI |
| `recommend_skills` | Recommend installed cross-AI skills for a task (descriptors first) |
| `load_skill` | Load one recommended skill's complete advisory instructions |
| `list_capabilities` | List sanitized installed plugin/extension capabilities and their owning runtimes |
| `recommend_capabilities` | Find a runtime-owned capability for a task |
| `get_capability` | Get one capability descriptor and delegation route |
| `search_observations` | Past session observations (filter: type, files, since) |
| `get_full` | Full content of a hit by `doc_id` |
| `reindex` | Trigger re-embed |
| `stats` | Corpus stats |
| `status` | Worker health |
| `todo_add` | Homework: park an idea or a task for later (open → claimed → done); `idea: …` / `todo: …` at the start of a prompt does the same through the hook |
| `todo_list` | Homework: what is open (default), done (kept a week), or all |
| `todo_claim` | Homework: take an item so no other session on this machine starts it too |
| `todo_done` | Homework: close an item with a one-line note |
| `work_set` | Coordination board: publish/refresh "I'm working on X — topics, files"; returns overlapping claims by topic, files or meaning |
| `work_active` | Coordination board: list live claims with their topics, which topics two sessions hold, and which claims overlap yours |
| `work_clear` | Coordination board: drop your claim early (task done) |

> **Project milestone:** the synchronized skill repository is Captain Memo's first feature built
> with Codex rather than Claude, using Captain Memo's own shared memory throughout. The prior
> architecture, decisions, conventions, and release rules were recalled from the corpus instead of
> being re-explained by the maintainer.

## CLI commands (any terminal)

```bash
captain-memo status              # is the worker reachable?
captain-memo stats               # corpus stats by channel + indexing progress
captain-memo top                 # interactive live stats (htop-style); press ? for help
captain-memo dedup               # fold near-duplicate observations (dry-run by default)
captain-memo supersede           # inspect open supersede links (list) or reverse one (undo <id>)
captain-memo consolidate         # run a consolidation pass now, skipping the idle wait (--for 30m, --backlog)
captain-memo theme               # list themes written by consolidation (theme undo <id> to reverse)
captain-memo reindex             # cheap sha-diff reindex (or --force to re-embed)
captain-memo remember            # persist a curated memory entry (--type, --name, --slug; body via --body/--file/stdin)
captain-memo forget              # delete a memory and de-index it (<doc_id|path>, --dry-run, --yes; confirms by default)
captain-memo observation list    # recent captured observations
captain-memo observation flush   # force-drain the queue
captain-memo config show         # effective config (secrets masked)
captain-memo doctor              # component health probe
captain-memo maintenance         # reclaim what nothing needs: spent queue rows, orphaned vectors, superseded plugin-cache trees (dry-run; --apply)
captain-memo install             # interactive install wizard
captain-memo connect             # wire other AI tools (Codex, Gemini, Cursor, opencode…) to this worker (--list)
captain-memo skill list          # list virtual skills (--source AGENT, --limit N, --json)
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
- `a` — the **AI-sources** chart: observations per originating tool (claude-code / codex / agy / gemini / …)
- `↑↓` / `j` `k`, `PgUp` / `PgDn`, `g` / `G` — move + page the selection
- `o` sort · `t` type filter · `/` find-by-title · `c` collapse near-duplicates
- `Tab` cycle views (in the table) · `+` / `-` refresh rate (on the dashboard)
- `⏎` open the full observation (counts as a drill) · `Esc` back · `?` help · `q` quit

Press `?` for the in-app help — including a **glossary** of every stat term
(Compression, Surfaced/Recalled, Drill-in rate, Tide, Strengthened, Dream, …).
The full, detailed version lives at
[captain-memo.ispcq.com/glossary.html](https://captain-memo.ispcq.com/glossary.html)
(and [docs/GLOSSARY.md](docs/GLOSSARY.md)).

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

**On by default** — Dreaming reads it, so leaving it off shipped a dead feature. Set `CAPTAIN_MEMO_RECALL_AUDIT=0` in your `worker.env` to disable. It records retrieved hits and boost provenance to `${CAPTAIN_MEMO_DATA_DIR:-~/.captain-memo}/recall-audit.jsonl` (one JSON line per auto-injection — the `UserPromptSubmit` hook's `/inject/context` call; explicit MCP searches are not audited). Each line records the timestamp, session and project IDs, the query, and for every returned hit: the chunk ID, channel, score, a 200-character snippet, and which of the identifier-match, rare-token, or same-branch boosts fired and with what multiplier. The active rank profile is recorded on each line too. Useful for tuning the search boosts against real prompts. The file is append-only and **bounded**: past 32 MB (`CAPTAIN_MEMO_RECALL_AUDIT_MAX_BYTES`) it is rotated to `recall-audit.jsonl.1` and a fresh file started — one generation is kept. It never leaves the machine: nothing indexes it into the searchable corpus and nothing relays it to a peer or hub.

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

The signal feeds importance / decay scoring and "Dreaming" clustering — clusters of observations you actually keep drilling into, not just clusters that happen to share vocabulary.

### Local Dreaming

The offline pass that keeps the corpus from growing forever. It groups observations by what you actually recall **together** — not just by what shares vocabulary — and folds each cluster into one higher-level theme, archiving the originals rather than deleting them. It runs on your machine, on your schedule, against your local corpus, with the model login you already have.

Co-retrieval is the point. Clustering purely on embedding similarity produces "groups that share words", which is the failure mode the design set out to avoid; two observations you keep pulling up in the same breath are much stronger evidence that they are one topic. That signal comes from the recall audit log above, which is on by default — if you set `CAPTAIN_MEMO_RECALL_AUDIT=0`, Dreaming has nothing to see for that window.

**Why "dreaming".** The name is Anthropic's. [Dreams](https://platform.claude.com/docs/en/managed-agents/dreams) shipped in Claude Managed Agents in May 2026: a pass that reads an agent's memory store alongside its past session transcripts and produces a new, reorganized store — duplicates merged, stale or contradicted entries replaced with the latest value, new insights surfaced — leaving the input store untouched. Their split is the useful one: memory captures what an agent learns *as it works*, dreaming refines that memory *between sessions*. Captain Memo runs the same idea locally against your own SQLite files, and derives the grouping from co-retrieval rather than from re-reading transcripts with a model.

```bash
captain-memo dream --dry-run              # preview the clusters, writes nothing
captain-memo dream --dry-run --since 30d  # widen the look-back (default 14d)
captain-memo dream --dry-run --json       # machine-readable report
```

**Preview only for now.** `--dry-run` is required — the write path (theme insertion + member archival) is deliberately not shipped until the dry-run output has been validated against real co-retrieval data. It never contacts the worker, never writes to the DB, and never calls the summarizer, so it is safe to run at any time. The `Dream` section in `stats` / `top` shows the inputs it would read: the audit log's size and entry count, and how many co-retrieval pairs have accumulated.

### Consolidation: what actually runs

Four passes keep the corpus from growing forever. All are reversible, none delete — folding and
theming **archive** the originals, and supersede applies a demotion you can undo.

| Pass | What it does | Scope |
|---|---|---|
| **Dedup** | Folds near-duplicates into the highest-recall survivor. Title similarity **and** an embedding confirm — both must hold. | Walks the clusters the vector index assigned at insert, so its cost tracks the corpus rather than a tuning knob. |
| **Supersede** | Demotes an older version-fact when a newer one exists. Reversible 0.5x, not an archive. | Whole corpus, hourly. |
| **Semantic fold** | Collapses same-session restatements — one event the summarizer described twice. | Same-session only: a shared session id is the one signal that says "same moment, same work" without inference. |
| **Themes** | Turns a cross-session cluster into one durable fact, with the originals archived beneath it. | Needs a summarizer; the model is asked to name the theme and declines most of what it sees. |

A theme needs **both** vector similarity and co-retrieval evidence — two observations you keep
pulling up in the same breath. Since every possible cluster edge is therefore already a
co-retrieval pair, the clusterer walks that evidence directly instead of comparing every pair in
scope: on a 135k-observation corpus that is 44,100 pairs rather than 1.46 billion.

The scheduled passes only run while you are away, so nothing competes with your work:

```bash
captain-memo consolidate --for 30m     # skip the idle gate for the next 30 minutes
captain-memo consolidate --semantic --backlog --for 30m   # one-off: include never-recalled rows
captain-memo theme list                # read what was written
captain-memo dedup --undo              # reverse a fold
```

**`--backlog` is a one-off.** Folding normally targets what actually reaches you, so an observation
that has never been recalled is skipped — on a mature corpus that is most of the collection. The
sweep drops that gate for a single run; afterwards, new duplicates only accrue as fast as new
observations do.

### Knowledge clustering (v0.30.0+)

Above 3,000 vectors the corpus is partitioned into clusters by mini-batch k-means — roughly one
centroid per 300 vectors — and a search reads only the nearest few instead of scanning everything.
On by default; `CAPTAIN_MEMO_IVF_ENABLED=0` switches it off.

The trade is recall, so it is measured rather than asserted. On a live 143,720-vector store, with an
exhaustive scan as ground truth and 50 probe vectors drawn at a fixed stride:

| clusters probed | p50 | recall@10 |
|---|---|---|
| all (exhaustive) | 1166 ms | 1.000 |
| 8 | 27.2 ms | 0.858 |
| **16** (default) | **47.5 ms** | **0.938** |
| 32 | 95.2 ms | 0.978 |

Safe to default on because it degrades to a no-op rather than to wrong answers: nothing happens
below the corpus threshold, every query **also probes the not-yet-assigned partition
unconditionally** — so a half-built or abandoned index never silently loses a result — and below
~16 clusters the probe reads the whole corpus anyway. The index builds in the background in
bounded slices, fast while there is work to assign and slow once converged.

The partition is also interesting in its own right. Measured on that store: 412 clusters, **87% of
them spanning more than one repository**, 72% mixing curated notes with captured observations, and
three distinct kinds of grouping that nothing in the method distinguishes — topical, methodological
(memories united by *how* something was learned rather than what it was about), and episodic (one
task's arc including its dead ends).

[The full analysis, with method and limits →](https://captain-memo.ispcq.com/clusters.html)

### Consolidation: folding and themes

Two passes run in the background when the machine is idle — no queued work, no live co-session, and
a stretch of quiet — and yield the moment ingest arrives.

- **Semantic folding** collapses same-session restatements: one event the summarizer described
  twice. Cosine is the *finder* here, not just a confirm, because title-overlap gating meant no
  semantically-similar pair ever reached the confirm step.
- **Themes** are the opposite case: the same standing fact learned in one session and *again* in
  another weeks later. Two separate learning events is the phenomenon, not a weak version of it. A
  model is asked to name the theme and declines most of what it sees.

Both are on by default and both are reversible (`captain-memo dedup --undo`,
`captain-memo theme undo <id>`). To watch one happen rather than wait for the idle window:

```bash
captain-memo consolidate --for 30m    # skip the idle gate for the next 30 minutes
captain-memo theme list               # read what was written
```

`consolidate` overrides **scheduling only**. Protected rows stay untouchable, project and branch
scope is still enforced, the cosine confirm and merge guard still run, and a pass already in flight
is never doubled.

### Vendor provenance (v0.16.0+)

Every captured observation is tagged with which AI tool wrote it — `claude-code`, `codex`, `cursor`, `gemini`, `agy`, `opencode`, `kimi`, `vibe`, `vscode`, `jetbrains`, or `unknown` for older/unattributed rows — surfaced in `metadata.origin_agent` on every search and `get_full` hit. Claude Code, supported Codex/Gemini/Kimi native hooks, and the cross-AI transcript readers all stamp this provenance. It never blocks capture: an unrecognized or missing signal degrades to `unknown`, never an error.

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
| **Summarizer** | Pluggable: Claude Max via OAuth (default, no API key), Codex CLI (ChatGPT plan), Antigravity CLI `agy` (Google account), Anthropic API, `claude -p` subprocess, or any OpenAI-compatible `/v1/chat/completions`. |
| **MCP server** (stdio) | Exposes 22 tools, including virtual skills plus `list_capabilities` / `recommend_capabilities` / `get_capability` for runtime-aware plugin routing. |
| **Six hooks** | `SessionStart` (corpus banner), `UserPromptSubmit` (inject memory envelope, ≤1.5 s budget), `PreToolUse` (work-board claim + overlap/git warning, advisory only), `PostToolUse` (queue tool-use events), `Stop` (drain → summarize → index), `PreCompact` (capture before context compaction). |
| **CLI** | The commands above. |

Channels indexed: `memory` (curated user memory files), `skill` (cross-AI Agent Skills, section-level plus a first-class lossless registry), `observation` (summarized session events). Observations age at search time: Tide (on by default) demotes stale hits with a bounded multiplier that never falls below a 0.30 relevance floor, so newer truth ranks above stale truth without losing history. (`CAPTAIN_MEMO_TIDE_ENABLED=0` falls back to the older flat exponential decay, 90-day half-life.)

Detailed docs: [`docs/USAGE.md`](docs/USAGE.md).

---

## Status

| Plan | Scope | State |
|---|---|---|
| 1 | Worker, MCP server, CLI, hybrid search, file watcher, ingest pipeline | Shipped |
| 2 | Hooks + observation pipeline + 4-provider summarizer + 4-provider embedder | Shipped |
| 3 — Layer A | claude-mem migration (`inspect-claude-mem`, `migrate-from-claude-mem`) | Shipped |
| 3 — Layer B | OAuth-direct summarizer (no API key needed) · recency decay · install wizard fast-path defaults | Shipped |
| 3 — Layers C-G | observation dedup + supersede (`dedup`, `supersede`) · retrieval-quality eval (`eval seed` / `eval run`) · `forget` · doctor staleness checks (`plugin cache version`, `live plugin version`) | Shipped |
| 3 — remaining | MEMORY.md transformation | Planned |

Typecheck clean. Bun ≥ 1.1.14, TypeScript strict.

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
