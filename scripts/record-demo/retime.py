#!/usr/bin/env python3
"""Space out the instant part of `captain-memo connect` in a recorded cast so each tool is seen being wired.

codex and gemini are wired by running their own CLIs (the demo stubs sleep, as the real ones take about a second);
agy, goose, cursor and jetbrains are wired in-process in milliseconds, so without this they flash by in ~0.1 s. Only the
TIMESTAMPS of those events change: the output bytes are identical, and the script checks that.
Usage: retime.py <in.cast> <out.cast>"""
import json, re, sys
src, dst = sys.argv[1], sys.argv[2]
lines = open(src, encoding='utf-8').read().split('\n')
head, ev = json.loads(lines[0]), [json.loads(l) for l in lines[1:] if l.strip()]
strip = lambda s: re.sub(r'\x1b\[[0-9;?]*[A-Za-z]', '', s)
def find(sub, start=0):
    for i in range(start, len(ev)):
        if sub in strip(ev[i][2]): return i
    return None
a = find('checking agy'); done = find('Done.', a or 0)
if a is None or done is None:
    open(dst, 'w', encoding='utf-8').write('\n'.join(lines)); print('burst not found: copied unchanged'); sys.exit(0)
p = done + 1                                    # the prompt that follows the result block
STEPS = [('checking agy', 0.0), ('wiring agy', 0.15), ('checking goose', 0.55), ('wiring goose', 0.70), ('checking cursor', 1.10), ('wiring cursor', 1.25),
         ('checking opencode', 1.65), ('checking vibe', 1.75), ('checking kimi', 1.85), ('checking vscode', 1.95), ('checking jetbrains', 2.05),
         ('wiring jetbrains', 2.20), ('checking claude-desktop', 2.60)]
t0, new, last = ev[a][0], {}, 0.0
for i in range(a, p + 1):
    s = strip(ev[i][2]); off = next((t for k, t in STEPS if k in s), None)
    if off is None: off = max(last + 0.0005, 3.5)   # the result block and the prompt land together after a beat
    new[i] = round(t0 + off, 6); last = max(last, off)
shift = new[p] - ev[p][0]
out = [[new[i] if a <= i <= p else (e[0] + shift if i > p else e[0]), e[1], e[2]] for i, e in enumerate(ev)]
assert all(out[i][0] <= out[i + 1][0] for i in range(len(out) - 1)), 'timestamps not monotonic'
assert ''.join(e[2] for e in ev) == ''.join(e[2] for e in out), 'output changed'
with open(dst, 'w', encoding='utf-8') as f:
    f.write(json.dumps(head) + '\n')
    for e in out: f.write(json.dumps(e, ensure_ascii=False) + '\n')
print(f'retimed {p - a + 1} events; later events shifted by +{shift:.3f}s; output bytes identical')
