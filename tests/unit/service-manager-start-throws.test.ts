// Regression for the silent-failure audit: ServiceManager.start() must THROW when
// the supervisor command fails, so the self-heal orchestrator's `failed` branch
// fires and the OS's own error reaches hook.log — instead of resolving silently
// (the bug where `systemctl start` could fail and the heal reported success).
// Linux-only: exercises the real systemd impl against a unit that cannot exist.
import { test, expect } from 'bun:test';
import { getServiceManager } from '../../src/services/service-manager/index.ts';

test('systemd start() rejects on a non-existent unit (does not resolve silently)', async () => {
  if (process.platform !== 'linux') return; // the systemd impl is selected only on linux
  const sm = getServiceManager();
  // `systemctl start <bogus>` exits non-zero ("Unit … not found"); if systemctl is
  // absent the spawn errors. Either way start() must reject, never resolve.
  await expect(sm.start('captain-memo-NOPE-does-not-exist-xyz')).rejects.toThrow();
});
