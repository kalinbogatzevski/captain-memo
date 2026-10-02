#!/usr/bin/env python3
# Records a real interactive bash in a pty into an asciicast v2 file: the typed commands are echoed by the pty and the
# output is whatever the real commands print, with real timing. Usage: rec.py <out.cast> <cols> <rows>
import os, pty, sys, time, json, select, struct, fcntl, termios, random, codecs, re
out, cols, rows = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
rnd = random.Random(269)
PROMPT = '❯'
env = {k: os.environ[k] for k in ('HOME', 'PATH', 'XDG_CONFIG_HOME', 'CAPTAIN_MEMO_CONFIG_DIR', 'CAPTAIN_MEMO_DATA_DIR', 'CAPTAIN_MEMO_WORKER_PORT',
       'CAPTAIN_MEMO_EMBEDDER_ENDPOINT', 'CAPTAIN_MEMO_DISABLE_SELF_HEAL') if k in os.environ}
env.update(TERM='xterm-256color', LANG='C.UTF-8', LC_ALL='C.UTF-8', HISTFILE='/dev/null', PROMPT_COMMAND='', INPUTRC=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'inputrc'),
           PS1='\\[\\e[38;5;179m\\]' + PROMPT + '\\[\\e[0m\\] ')
pid, fd = pty.fork()
if pid == 0:
    os.chdir(env['HOME']); os.execvpe('bash', ['bash', '--norc', '--noprofile', '-i'], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
t0 = time.time(); events = []; dec = codecs.getincrementaldecoder('utf-8')('replace'); seen = ''
ANSI = re.compile(r'\x1b\[[0-9;?]*[A-Za-z]')
def at_prompt(): return ANSI.sub('', seen).rstrip().endswith(PROMPT)
def pump(wait):  # collect output for `wait` seconds
    global seen
    end = time.time() + wait
    while True:
        left = end - time.time()
        if left <= 0: return
        r, _, _ = select.select([fd], [], [], left)
        if r:
            try: data = os.read(fd, 65536)
            except OSError: return
            if not data: return
            s = dec.decode(data)
            if s: events.append([round(time.time() - t0, 6), 'o', s]); seen += s
def until_prompt(timeout, after=0):  # wait until the prompt is the last thing on screen
    end = time.time() + timeout
    while time.time() < end and not at_prompt(): pump(0.05)
    pump(after)
def type_cmd(text):  # a person's pace: 100-170 ms a key, a little longer after a space or a dash
    for ch in text:
        os.write(fd, ch.encode()); pump(rnd.uniform(0.10, 0.17) + (rnd.uniform(0.10, 0.22) if ch in ' -' else 0))
until_prompt(10, 1.8)
type_cmd('captain-memo connect'); pump(0.9); os.write(fd, b'\r')
seen = ''; end = time.time() + 40
while time.time() < end:
    pump(0.05)
    if 'Done.' in seen and at_prompt(): break
pump(7.0)
seen = ''; os.write(fd, b'\x0c'); pump(0.2); until_prompt(5, 1.8)
type_cmd('captain-memo stats'); pump(0.9); os.write(fd, b'\r')
seen = ''; end = time.time() + 40
while time.time() < end:
    pump(0.05)
    if len(seen) > 400 and at_prompt(): break
pump(9.0)   # the stats screen stays up; `exit` is never recorded
header = {'version': 2, 'width': cols, 'height': rows, 'timestamp': int(t0), 'env': {'TERM': 'xterm-256color', 'SHELL': '/bin/bash'}}
with open(out, 'w', encoding='utf-8') as f:
    f.write(json.dumps(header) + '\n')
    for e in events: f.write(json.dumps(e, ensure_ascii=False) + '\n')
print('events', len(events), 'duration', events[-1][0] if events else 0)
os.kill(pid, 9)
