// OS-keyring existence probe for an AI CLI's login (secret-store.ts). agy 1.3.4 can be logged in through gnome-keyring
// (item "Password for 'antigravity' on 'gemini'") and then writes NO antigravity-oauth-token, so a file-only check
// reports it as signed out until the keyring is asked.
import { describe, it, expect } from 'bun:test';
import {
  parseSearchItems, searchItemsArgv, probeSecretStore, parseCmdkeyList, cmdkeyArgv, AGY_KEYRING_ATTRS, type SecretStoreSpawn,
} from '../../src/shared/secret-store.ts';

const ITEM = '"/org/freedesktop/secrets/collection/login/3"';

describe('parseSearchItems — busctl reply to SearchItems (unlocked paths, then locked paths)', () => {
  it('an unlocked match', () => expect(parseSearchItems(`aoao 1 ${ITEM} 0\n`)).toBe('unlocked'));
  it('a match behind a locked collection', () => expect(parseSearchItems(`aoao 0 1 ${ITEM}\n`)).toBe('locked'));
  it('the service answered and holds nothing', () => expect(parseSearchItems('aoao 0 0\n')).toBe('none'));
  it('several matches still read as one state', () => expect(parseSearchItems(`aoao 2 ${ITEM} ${ITEM} 1 ${ITEM}`)).toBe('unlocked'));
  it('anything it does not understand is null, never "none"', () => {
    for (const bad of ['', 'Failed to call method', 'aoao', 'aoao 1 0', `aoao 2 ${ITEM} 0`, `aoao 1 ${ITEM} 0 junk`, 'as 1 "x"']) {
      expect(parseSearchItems(bad)).toBeNull();
    }
  });
});

describe('searchItemsArgv', () => {
  it('asks SearchItems on the SESSION bus and never auto-starts a keyring daemon', () => {
    expect(searchItemsArgv(AGY_KEYRING_ATTRS)).toEqual([
      'busctl', '--user', '--auto-start=no', '--timeout=5',
      'call', 'org.freedesktop.secrets', '/org/freedesktop/secrets', 'org.freedesktop.Secret.Service',
      'SearchItems', 'a{ss}', '2', 'service', 'gemini', 'username', 'antigravity',
    ]);
  });
});

describe('probeSecretStore', () => {
  const ok = (stdout: string): SecretStoreSpawn => async () => ({ code: 0, stdout });
  const base = { platform: 'linux' as const, which: () => '/usr/bin/busctl' };

  it('reads the reply', async () => expect(await probeSecretStore(AGY_KEYRING_ATTRS, { ...base, spawn: ok(`aoao 1 ${ITEM} 0`) })).toBe('unlocked'));
  it('is null off Linux and Windows and spawns nothing', async () => {
    let spawned = false;
    const r = await probeSecretStore(AGY_KEYRING_ATTRS, { ...base, platform: 'darwin', spawn: async () => { spawned = true; return { code: 0, stdout: '' }; } });
    expect(r).toBeNull(); expect(spawned).toBe(false);
  });
  it('is null without busctl', async () => expect(await probeSecretStore(AGY_KEYRING_ATTRS, { ...base, which: () => null, spawn: ok('aoao 0 0') })).toBeNull());
  it('is null when busctl fails (no Secret Service on the bus, timeout)', async () => {
    expect(await probeSecretStore(AGY_KEYRING_ATTRS, { ...base, spawn: async () => ({ code: 1, stdout: '' }) })).toBeNull();
    expect(await probeSecretStore(AGY_KEYRING_ATTRS, { ...base, spawn: async () => ({ code: null, stdout: '' }) })).toBeNull();
  });
  it('is null when the spawn throws', async () => expect(await probeSecretStore(AGY_KEYRING_ATTRS, { ...base, spawn: async () => { throw new Error('boom'); } })).toBeNull());
});

// ── Windows Credential Manager: agy 1.3.4, agy.exe on PATH, NO antigravity-oauth-token, and
// `cmdkey /list | Select-String antigravity` prints exactly the two lines below.
const AGY_CRED = 'Target: LegacyGeneric:target=gemini:antigravity\r\nUser: antigravity\r\n';
const CMDKEY_ALL = [
  '', 'Currently stored credentials:', '',
  '    Target: LegacyGeneric:target=git:https://git.example.com', '    Type: Generic', '    User: oauth', '',
  `    ${AGY_CRED.split('\r\n')[0]}`, '    Type: Generic', '    User: antigravity', '',
  '    Target: WindowsLive:target=virtualapp/didlogical', '    Type: Generic', '',
].join('\r\n');

describe('parseCmdkeyList — the Windows Credential Manager listing', () => {
  it("agy's own two lines: its credential is there", () => expect(parseCmdkeyList(AGY_CRED, AGY_KEYRING_ATTRS)).toBe('unlocked'));
  it('found inside a full listing with CRLF line ends', () => expect(parseCmdkeyList(CMDKEY_ALL, AGY_KEYRING_ATTRS)).toBe('unlocked'));
  it('a localized "Target" label does not matter: only the target text is read', () => {
    expect(parseCmdkeyList('    Цел: LegacyGeneric:target=gemini:antigravity\r\n', AGY_KEYRING_ATTRS)).toBe('unlocked');
    expect(parseCmdkeyList('Target: gemini:antigravity', AGY_KEYRING_ATTRS)).toBe('unlocked');
  });
  it('other credentials only: the store answered and holds no such login', () => {
    expect(parseCmdkeyList(CMDKEY_ALL.replace(/gemini:antigravity/g, 'gemini:other'), AGY_KEYRING_ATTRS)).toBe('none');
  });
  it('a longer or prefixed target is not agy\'s', () => {
    expect(parseCmdkeyList('Target: LegacyGeneric:target=gemini:antigravity-old', AGY_KEYRING_ATTRS)).toBe('none');
    expect(parseCmdkeyList('Target: LegacyGeneric:target=xgemini:antigravity', AGY_KEYRING_ATTRS)).toBe('none');
  });
  it('an empty reply is null, never "none"', () => {
    expect(parseCmdkeyList('', AGY_KEYRING_ATTRS)).toBeNull();
    expect(parseCmdkeyList('  \r\n', AGY_KEYRING_ATTRS)).toBeNull();
  });
});

describe('probeSecretStore on Windows', () => {
  const win = { platform: 'win32' as const, which: (b: string) => (b === 'cmdkey' ? 'C:\\Windows\\System32\\cmdkey.exe' : null) };
  it('asks cmdkey /list, and only that', async () => {
    let argv: string[] = [];
    await probeSecretStore(AGY_KEYRING_ATTRS, { ...win, spawn: async (a) => { argv = a; return { code: 0, stdout: AGY_CRED }; } });
    expect(argv).toEqual(cmdkeyArgv());
    expect(argv).toEqual(['cmdkey', '/list']);
  });
  it('reads the listing', async () => {
    expect(await probeSecretStore(AGY_KEYRING_ATTRS, { ...win, spawn: async () => ({ code: 0, stdout: CMDKEY_ALL }) })).toBe('unlocked');
    expect(await probeSecretStore(AGY_KEYRING_ATTRS, { ...win, spawn: async () => ({ code: 0, stdout: 'Target: WindowsLive:target=x' }) })).toBe('none');
  });
  it('is null without cmdkey, when it fails, when it times out, or when the spawn throws', async () => {
    expect(await probeSecretStore(AGY_KEYRING_ATTRS, { ...win, which: () => null, spawn: async () => ({ code: 0, stdout: AGY_CRED }) })).toBeNull();
    expect(await probeSecretStore(AGY_KEYRING_ATTRS, { ...win, spawn: async () => ({ code: 1, stdout: AGY_CRED }) })).toBeNull();
    expect(await probeSecretStore(AGY_KEYRING_ATTRS, { ...win, spawn: async () => ({ code: null, stdout: '' }) })).toBeNull();
    expect(await probeSecretStore(AGY_KEYRING_ATTRS, { ...win, spawn: async () => { throw new Error('boom'); } })).toBeNull();
  });
  it('never asks busctl on Windows, nor cmdkey on Linux', async () => {
    const asked: string[] = [];
    const spy: SecretStoreSpawn = async (a) => { asked.push(a[0]!); return { code: 0, stdout: AGY_CRED }; };
    await probeSecretStore(AGY_KEYRING_ATTRS, { platform: 'win32', which: () => 'x', spawn: spy });
    await probeSecretStore(AGY_KEYRING_ATTRS, { platform: 'linux', which: () => 'x', spawn: spy });
    expect(asked).toEqual(['cmdkey', 'busctl']);
  });
});
