# Contributing to Captain Memo

Thanks for taking the time to look — Captain Memo is a small open-source project and every issue, pull request, or even a clear bug report is genuinely appreciated.

## Project license

Captain Memo is licensed under [Apache License 2.0](LICENSE). By contributing, you agree that your contribution will be released under the same license. Apache 2.0 includes an explicit patent grant — see the [LICENSE](LICENSE) file for the full text and the [NOTICE](NOTICE) file for third-party attributions.

## Developer Certificate of Origin (DCO)

We use the **Developer Certificate of Origin** (a lightweight alternative to a full Contributor License Agreement) to keep the contribution chain legally clean. Every commit must be signed off by you with a `Signed-off-by:` line at the end of the commit message.

The easiest way is to add `-s` to every `git commit`:

```bash
git commit -s -m "fix: handle empty channel filter in /search/all"
```

This automatically appends:

```
Signed-off-by: Your Name <your.email@example.com>
```

By signing off, you certify that:

> 1. The contribution was created in whole or in part by you and you have the right to submit it under the project's license; or
> 2. The contribution is based upon previous work that, to the best of your knowledge, is covered under an appropriate open source license and you have the right to submit that work with modifications, under the same license; or
> 3. The contribution was provided directly to you by some other person who certified (1), (2), or (3) and you have not modified it; and
> 4. You understand and agree that this project and the contribution are public and that a record of the contribution (including all personal information you submit with it, including the sign-off) is maintained indefinitely and may be redistributed consistent with this project or the open source license(s) involved.

(Full text: <https://developercertificate.org>.)

PRs without a `Signed-off-by:` line on every commit will be asked to fix this before merge — usually `git commit --amend -s` (single commit) or `git rebase --signoff <base>` (multiple commits).

## How to contribute

### Bug reports

Open an [issue](https://github.com/kalinbogatzevski/captain-memo/issues) with:
- Captain Memo version (`captain-memo doctor` shows it)
- Bun version (`bun --version`)
- OS / distro
- What you did, what you expected, what happened
- Relevant excerpts from `~/.captain-memo/logs/` (worker.log, hook.log)

### Feature ideas

Open an issue first — even a one-line "would it be reasonable to add X?" is fine. This avoids you spending hours on a PR that turns out to conflict with planned direction.

### Pull requests

1. Fork the repo and branch from `master`.
2. Make focused commits — small, reviewable units beat one huge change.
3. Sign off every commit (`git commit -s`).
4. Run `bun test` (or `bun test <pattern>` for a subset) and make sure everything passes.
5. If you touch the worker or hooks, restart the worker locally (`systemctl --user restart captain-memo-worker`) and verify a fresh `claude` session still works end-to-end.
6. Open the PR against `master`. Describe what changed and why; link any related issue.

### Commit message style

Loose conventional-commits: `<type>(<scope>): <short summary>` — for example:
- `fix(hooks): SessionStart banner — JSON envelope + cleaner layout`
- `feat(stats): expose data dir disk usage`
- `docs(readme): add v0.2.0 macOS install path`

Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`. The body should explain the *why* — the code itself shows the *what*.

## Development setup

See the **Install** section in [README.md](README.md) for the full setup. For development you usually want:

```bash
git clone https://github.com/kalinbogatzevski/captain-memo
cd captain-memo
bun install
bun test                                    # full test suite
bun src/cli/index.ts doctor                 # check your local install
```

The worker and hooks are pure Bun + TypeScript, no build step required — `bun src/...` runs source directly.

## Code of conduct

Be kind. Disagree about the code, not about each other. We don't have the bandwidth for a formal CoC enforcement process, but harassment, slurs, or hostile behavior in issues / PRs / discussions will result in a block.

## Questions

Open a [discussion](https://github.com/kalinbogatzevski/captain-memo/discussions) (preferred for general questions) or an [issue](https://github.com/kalinbogatzevski/captain-memo/issues) (for bugs and concrete feature requests).
