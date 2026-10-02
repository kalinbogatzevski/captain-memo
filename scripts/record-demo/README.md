# Re-recording the README hero GIF

`docs/demo.gif` shows the real `captain-memo connect` and `captain-memo stats`. It must never show a real home
path, a real project's memory titles or a real corpus, so it is recorded against a throwaway home and a made-up
sample corpus. This folder does that in one command.

```bash
scripts/record-demo/record.sh docs/demo.gif
```

Needs `bun`, `agg` (the asciinema GIF generator), `python3` and `curl`. Linux.

## What it does

1. Builds a scratch home (`/dev/shm/demo` by default, `DEMO_HOME` to change it; it only ever deletes a folder it
   marked itself) with one folder for each of the six tools `connect` detects, so the output reads `/dev/shm/demo/...`
   and not a person's path.
2. Seeds a sample corpus (`seed.ts`): 2,105 generic observations from four tools (claude-code, codex, gemini, agy), and
   a replayed recall history (`seed-audit.ts`: 940 recalls through the product's own audit writer and `bumpRetrieval`),
   so the Surfaced, Strengthened, Audit log and Co-retrieval lines agree with each other.
3. Starts a scratch worker on port 39990 (`DEMO_PORT`), pointed at that home. Your real worker and files are untouched.
4. Records a real interactive bash in a pty (`rec.py`) at 100 x 30: typed at a human pace, `captain-memo connect`, a
   long hold to read the result, clear, `captain-memo stats`, a long hold on the AI sources panel.
5. Spaces out the instant in-process wirings (`retime.py`) so each tool is seen being wired. Only timestamps change;
   the script asserts the output bytes are identical.
6. Renders with `agg` using the palette the page is designed around, runs a leak scan on everything printed, and tells
   you where the GIF is.

The `codex` and `gemini` CLIs are stubs that sleep 0.7 s per call, as the real ones take about that long; everything
else is the real OSS build.

## Before you publish

- Look at the frames: `convert out.gif -coalesce frame-%02d.png`. The scan only catches text; it cannot see a title
  that is a real project's. Have someone else look at them too.
- The README alt text and the two sites' captions say the recording is against a sample corpus. Keep saying so.
- The same file is copied into the memo and fleet site repos (`demo.gif`) and deployed with each repo's `deploy.sh`.
