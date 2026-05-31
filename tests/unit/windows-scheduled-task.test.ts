// tests/unit/windows-scheduled-task.test.ts — pure tests for the Task Scheduler
// XML builder. No spawning, no Windows required → runs on Linux CI.
//
// The actual `schtasks /Create … /XML` call can only run on Windows (it shells
// out to the Windows Task Scheduler), but buildTaskXml is a pure string builder,
// so the XML contract is fully testable here.
import { test, expect, describe } from 'bun:test';
import { buildTaskXml, toTaskXmlBuffer } from '../../src/services/service-manager/windows-scheduled-task.ts';
import type { ServiceSpec } from '../../src/services/service-manager/types.ts';

function sampleSpec(overrides: Partial<ServiceSpec> = {}): ServiceSpec {
  return {
    name: 'captain-memo-worker',
    description: 'Captain Memo worker',
    exec: ['C:\\Users\\me\\.bun\\bin\\bun.exe', 'src/worker/index.ts'],
    workingDir: 'C:\\Users\\me\\captain-memo',
    envFile: 'C:\\Users\\me\\AppData\\Roaming\\captain-memo\\worker.env',
    autostart: true,
    restartOnFailure: true,
    logDir: 'C:\\Users\\me\\.captain-memo\\logs',
    ...overrides,
  };
}

// Count occurrences of a substring (used to assert balanced root element).
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('buildTaskXml', () => {
  test('emits a well-formed Task Scheduler 1.2 document with a single balanced root', () => {
    const xml = buildTaskXml(sampleSpec());

    // XML prolog + 1.2 schema namespace.
    expect(xml).toContain('<?xml version="1.0"');
    expect(xml).toContain(
      '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    );
    // Exactly one <Task ...> open and one </Task> close → balanced root element.
    expect(count(xml, '<Task ')).toBe(1);
    expect(count(xml, '</Task>')).toBe(1);
    // The document ends on the closing root tag.
    expect(xml.trimEnd().endsWith('</Task>')).toBe(true);
  });

  test('encodes the exec path as the Exec Command', () => {
    const xml = buildTaskXml(sampleSpec());
    expect(xml).toContain('<Command>C:\\Users\\me\\.bun\\bin\\bun.exe</Command>');
  });

  test('passes the script path as Arguments and sets WorkingDirectory', () => {
    const xml = buildTaskXml(sampleSpec());
    expect(xml).toContain('<Arguments>src/worker/index.ts</Arguments>');
    expect(xml).toContain('<WorkingDirectory>C:\\Users\\me\\captain-memo</WorkingDirectory>');
  });

  test('registers a LogonTrigger (autostart at logon, no admin)', () => {
    const xml = buildTaskXml(sampleSpec());
    expect(xml).toContain('<LogonTrigger>');
    expect(xml).toContain('</LogonTrigger>');
  });

  test('runs per-user, non-elevated (InteractiveToken + LeastPrivilege)', () => {
    const xml = buildTaskXml(sampleSpec());
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>');
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>');
  });

  test('encodes restart-on-failure settings (RestartCount 3 @ PT1M, IgnoreNew, PT0S)', () => {
    const xml = buildTaskXml(sampleSpec());
    expect(xml).toContain('<RestartOnFailure>');
    expect(xml).toContain('<Count>3</Count>');
    expect(xml).toContain('<Interval>PT1M</Interval>');
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
  });

  test('omits RestartOnFailure when restartOnFailure is false', () => {
    const xml = buildTaskXml(sampleSpec({ restartOnFailure: false }));
    expect(xml).not.toContain('<RestartOnFailure>');
    expect(xml).not.toContain('<Count>3</Count>');
    // Trigger + principal + action are still there.
    expect(xml).toContain('<LogonTrigger>');
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>');
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
  });

  test('quotes multi-token arguments so a path with spaces survives', () => {
    const xml = buildTaskXml(
      sampleSpec({ exec: ['C:\\bun.exe', 'C:\\Program Files\\cm\\worker.ts', '--port', '39888'] }),
    );
    // The space-containing token is double-quoted; flag tokens stay bare. The
    // quoting `"` is an XML metacharacter, so it lands escaped as &quot; — Task
    // Scheduler un-escapes it back to `"` when it parses the document.
    expect(xml).toContain(
      '<Arguments>&quot;C:\\Program Files\\cm\\worker.ts&quot; --port 39888</Arguments>',
    );
  });

  test('emits no <Arguments> when there are no script args', () => {
    const xml = buildTaskXml(sampleSpec({ exec: ['C:\\bun.exe'] }));
    expect(xml).not.toContain('<Arguments>');
    expect(xml).toContain('<Command>C:\\bun.exe</Command>');
  });

  test('XML-escapes & < > " \' in interpolated values', () => {
    const xml = buildTaskXml(
      sampleSpec({
        name: 'cm & <evil> "task" \'x\'',
        description: 'desc & <b> "q" \'a\'',
        workingDir: 'C:\\a & b\\<c>',
        exec: ['C:\\bun & co.exe', '--flag=<v>"x"\''],
      }),
    );
    // Raw metacharacters never appear inside the escaped substitutions.
    expect(xml).toContain('<URI>\\cm &amp; &lt;evil&gt; &quot;task&quot; &apos;x&apos;</URI>');
    expect(xml).toContain('<Description>desc &amp; &lt;b&gt; &quot;q&quot; &apos;a&apos;</Description>');
    expect(xml).toContain('<Command>C:\\bun &amp; co.exe</Command>');
    expect(xml).toContain('<WorkingDirectory>C:\\a &amp; b\\&lt;c&gt;</WorkingDirectory>');
    // The argument value is double-quoted (it has no space, so the quoting comes
    // from the escaped metacharacters only) and fully escaped.
    expect(xml).toContain('<Arguments>--flag=&lt;v&gt;&quot;x&quot;&apos;</Arguments>');
    // No unescaped stray markup leaked into the document body beyond the real tags.
    // Every '<evil>' / '<c>' / '<v>' must have been neutralized.
    expect(xml).not.toContain('<evil>');
    expect(xml).not.toContain('<c>');
    expect(xml).not.toContain('<v>');
  });

  test('scopes the task to the current user via <UserId> in Principal AND LogonTrigger (BUG-2 fix)', () => {
    const prevDom = process.env.USERDOMAIN;
    const prevUser = process.env.USERNAME;
    process.env.USERDOMAIN = 'TESTDOM';
    process.env.USERNAME = 'testuser';
    try {
      const xml = buildTaskXml(sampleSpec());
      // Without <UserId>, schtasks /Create can't bind the task to the logged-on
      // user and demands an elevated token (the v0.2.3 "Access is denied" bug).
      expect(count(xml, '<UserId>TESTDOM\\testuser</UserId>')).toBe(2); // Principal + LogonTrigger
    } finally {
      if (prevDom === undefined) delete process.env.USERDOMAIN; else process.env.USERDOMAIN = prevDom;
      if (prevUser === undefined) delete process.env.USERNAME; else process.env.USERNAME = prevUser;
    }
  });

  test('declares UTF-16 (the encoding schtasks /Create /XML requires)', () => {
    const xml = buildTaskXml(sampleSpec());
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-16"?>');
    expect(xml).not.toContain('UTF-8');
  });

  test('toTaskXmlBuffer encodes UTF-16 LE with a BOM (schtasks rejects UTF-8)', () => {
    const buf = toTaskXmlBuffer(buildTaskXml(sampleSpec()));
    expect(buf[0]).toBe(0xff);  // UTF-16 LE BOM = FF FE
    expect(buf[1]).toBe(0xfe);
    expect(buf.toString('utf16le').replace(/^﻿/, '')).toContain('<Task version="1.2"');
  });

  test('emits a periodic watchdog TimeTrigger from watchdogIntervalSec', () => {
    const xml = buildTaskXml(sampleSpec({ watchdogIntervalSec: 300 }));
    expect(xml).toContain('<TimeTrigger>');
    expect(xml).toContain('<Repetition>');
    expect(xml).toContain('<Interval>PT5M</Interval>');
    // Repeat indefinitely — no duration cap.
    expect(xml).toContain('<StopAtDurationEnd>false</StopAtDurationEnd>');
    // A StartBoundary is required for a TimeTrigger to be valid.
    expect(xml).toContain('<StartBoundary>');
    // The LogonTrigger still co-exists (autostart at logon).
    expect(xml).toContain('<LogonTrigger>');
  });

  test('defaults the watchdog to PT5M when watchdogIntervalSec is omitted', () => {
    const xml = buildTaskXml(sampleSpec()); // sampleSpec has no watchdogIntervalSec
    expect(xml).toContain('<TimeTrigger>');
    expect(xml).toContain('<Interval>PT5M</Interval>');
  });

  test('renders a sub-minute watchdog interval as PT{n}S', () => {
    const xml = buildTaskXml(sampleSpec({ watchdogIntervalSec: 90 }));
    expect(xml).toContain('<Interval>PT1M30S</Interval>');
  });
});
