// OS credential-store EXISTENCE probe for an AI CLI's login: the Linux Secret Service (gnome-keyring, KWallet) and the
// Windows Credential Manager.
//
// agy (Google Antigravity CLI) keeps its login in the OS keyring whenever one is reachable and in a token FILE
// otherwise (agy changelog 1.1.3, 1.1.12, 1.1.26). A check that only looks for the file reports a logged-in agy on a
// Linux desktop (gnome-keyring on the session bus, item "Password for 'antigravity' on 'gemini'", no
// antigravity-oauth-token) as signed out. A Windows machine is the same: agy.exe on PATH, no token file, and
// `cmdkey /list` showing "Target: LegacyGeneric:target=gemini:antigravity".
//
// Linux asks the Secret Service ONE question — SearchItems(attributes) — which returns item PATHS only: no secret is
// read, no unlock prompt is raised, and a locked collection is reported as locked. It never D-Bus-activates a
// service that is not already running (--auto-start=no), so asking cannot start a keyring daemon.
// Windows runs `cmdkey /list`, which prints credential NAMES and user names, never a secret, and looks for agy's target.
//
// ASYNC: the spawn is awaited by the caller (the install wizard's probeSummarizerLogins), never run from a synchronous check.
import { killTree } from './kill-tree.ts';

/** 'unlocked' / 'locked': an item with these attributes exists (readable now / behind a locked collection).
 *  'none': the service answered and holds no such item. */
export type SecretStoreState = 'unlocked' | 'locked' | 'none';

/** How agy labels its login in the keyring: the item "Password for 'antigravity' on 'gemini'" (go-keyring's label
 *  format), filed under these attributes. */
export const AGY_KEYRING_ATTRS: Readonly<Record<string, string>> = { service: 'gemini', username: 'antigravity' };

export const SECRET_STORE_PROBE_TIMEOUT_MS = 5_000;

/** busctl argv for SearchItems(a{ss}). `--auto-start=no`: never launch a keyring daemon just to ask. */
export function searchItemsArgv(attrs: Readonly<Record<string, string>>): string[] {
  const kv = Object.entries(attrs).flat();
  return [
    'busctl', '--user', '--auto-start=no', `--timeout=${Math.ceil(SECRET_STORE_PROBE_TIMEOUT_MS / 1000)}`,
    'call', 'org.freedesktop.secrets', '/org/freedesktop/secrets', 'org.freedesktop.Secret.Service',
    'SearchItems', 'a{ss}', String(Object.keys(attrs).length), ...kv,
  ];
}

/** Parse busctl's reply to SearchItems, `aoao <n> "<path>"… <m> "<path>"…` (unlocked paths, then locked paths).
 *  null = not a reply we understand (treated by the caller as "could not ask", never as "no login"). */
export function parseSearchItems(out: string): SecretStoreState | null {
  const m = /^aoao\s+(.*)$/s.exec(out.trim());
  if (!m) return null;
  const tokens = m[1]!.match(/"[^"]*"|\d+/g);
  if (!tokens || m[1]!.replace(/"[^"]*"|\d+|\s+/g, '') !== '') return null;   // anything but counts and quoted paths is not our reply
  let i = 0;
  const readArray = (): number | null => {
    const n = Number(tokens[i++]);
    if (!Number.isInteger(n) || n < 0) return null;
    for (let k = 0; k < n; k++) if (!tokens[i++]?.startsWith('"')) return null;
    return n;
  };
  const unlocked = readArray();
  const locked = unlocked === null ? null : readArray();
  if (unlocked === null || locked === null || i !== tokens.length) return null;
  return unlocked > 0 ? 'unlocked' : locked > 0 ? 'locked' : 'none';
}

export type SecretStoreSpawn = (argv: string[], timeoutMs: number) => Promise<{ code: number | null; stdout: string }>;

const spawnBounded: SecretStoreSpawn = async (argv, timeoutMs) => {
  const proc = Bun.spawn(argv, { env: { ...process.env }, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });   // env: busctl finds the session bus through XDG_RUNTIME_DIR / DBUS_SESSION_BUS_ADDRESS
  const killer = setTimeout(() => killTree(proc), timeoutMs);
  try {
    const stdout = await new Response(proc.stdout as ReadableStream).text();
    await proc.exited;
    return { code: proc.exitCode, stdout };
  } finally { clearTimeout(killer); }
};

/** The Windows Credential Manager listing: names and user names only, never a secret. */
export const cmdkeyArgv = (): string[] => ['cmdkey', '/list'];

/** Whether a `cmdkey /list` reply holds a credential for `attrs`. go-keyring writes a generic credential whose target
 *  is "<service>:<username>", which cmdkey prints as "Target: LegacyGeneric:target=gemini:antigravity" (agy 1.3.4 on
 *  Windows). The "Target:" label is localized, so only the target text itself is matched, at a line end.
 *  The Credential Manager has no locked state: a listed credential is 'unlocked'. An empty reply is null (nothing was
 *  read at all), never "none". */
export function parseCmdkeyList(out: string, attrs: Readonly<Record<string, string>>): SecretStoreState | null {
  if (!out.trim()) return null;
  const target = `${attrs.service}:${attrs.username}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s=])${target}\\s*$`, 'im').test(out) ? 'unlocked' : 'none';
}

/** Ask the OS credential store whether a login for `attrs` exists: the session bus's Secret Service on Linux, the
 *  Credential Manager on Windows. null = could not ask (another OS, no busctl / cmdkey, no service on the bus, timeout,
 *  unparseable reply): the caller then keeps the file-only verdict. */
export async function probeSecretStore(
  attrs: Readonly<Record<string, string>>,
  opts: { platform?: NodeJS.Platform; which?: (b: string) => string | null; spawn?: SecretStoreSpawn } = {},
): Promise<SecretStoreState | null> {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'linux' && platform !== 'win32') return null;
  const win = platform === 'win32';
  if (!(opts.which ?? ((b) => Bun.which(b)))(win ? 'cmdkey' : 'busctl')) return null;
  try {
    const r = await (opts.spawn ?? spawnBounded)(win ? cmdkeyArgv() : searchItemsArgv(attrs), SECRET_STORE_PROBE_TIMEOUT_MS + 1_000);
    if (r.code !== 0) return null;
    return win ? parseCmdkeyList(r.stdout, attrs) : parseSearchItems(r.stdout);
  } catch { return null; }
}
