// src/services/service-manager/index.ts — ServiceManager factory.
//
// The five management commands (install/uninstall/upgrade/vacuum/doctor) call
// getServiceManager() and then only the ServiceManager interface — never the OS
// directly. Selects the Windows Scheduled-Task impl on win32, the systemd impl
// everywhere else. A macOS launchd impl can slot in here later without touching
// any caller.

import type { ServiceManager } from './types.ts';
import { createSystemdServiceManager } from './systemd.ts';
import { createWindowsScheduledTaskServiceManager } from './windows-scheduled-task.ts';

export type { ServiceManager, ServiceSpec, ServiceState, StopOptions } from './types.ts';

export function getServiceManager(): ServiceManager {
  return process.platform === 'win32'
    ? createWindowsScheduledTaskServiceManager()
    : createSystemdServiceManager();
}
