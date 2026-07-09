// captain-memo gateway — pair/list/revoke a second device (phone, tablet, another machine)
// against THIS captain's existing corpus. No hub, no separate process, no peer
// concept — a paired device is an authenticated client of the same single worker. See
// docs/superpowers/specs/2026-07-05-local-device-pairing-design.md.
//
//   captain-memo gateway pair --label <name>   mint a token, print the connector URL + token
//   captain-memo gateway list                  show paired devices
//   captain-memo gateway revoke <device-id>    remove a device; its token stops working at once
//
// The worker itself serves the authenticated HTTP-MCP listener (see src/worker/index.ts) —
// this command only manages the token store. Restart the worker after pairing/revoking so it
// picks up the change (no hot-reload for v1).

import { pairNewDevice, loadGatewayConfig, revokeDevice } from '../../shared/gateway-tokens.ts';
import { DEFAULT_WORKER_PORT } from '../../shared/paths.ts';

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const HELP = `Usage: captain-memo gateway <pair|list|revoke>

  gateway pair --label <name>   pair a new device; prints a one-time token + connector URL
  gateway list                  show paired devices
  gateway revoke <device-id>    remove a device (its token stops working immediately)

Restart the worker (\`captain-memo restart\`) after pairing or revoking so it takes effect.`;

export async function gatewayCommand(args: string[]): Promise<number> {
  const sub = args[0];

  if (!sub || args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return sub ? 0 : 2;
  }

  if (sub === 'pair') {
    const label = flag(args, 'label');
    if (!label) {
      console.error('usage: captain-memo gateway pair --label <name>');
      return 2;
    }
    const { device, token } = pairNewDevice(label);
    // Mirror the worker's own formula (src/worker/index.ts) so the printed port always
    // matches the port it actually binds — even when CAPTAIN_MEMO_WORKER_PORT is customized.
    const workerPort = process.env.CAPTAIN_MEMO_WORKER_PORT
      ? Number(process.env.CAPTAIN_MEMO_WORKER_PORT)
      : DEFAULT_WORKER_PORT;
    const port = process.env.CAPTAIN_MEMO_GATEWAY_PORT
      ? Number(process.env.CAPTAIN_MEMO_GATEWAY_PORT)
      : workerPort + 1;
    console.log(`Paired device "${label}" (${device.id}).`);
    console.log(`\nConnector URL: http://<your-host-or-reverse-proxy>:${port}`);
    console.log(`Token (shown once, save it now): ${token}`);
    console.log(`\nRestart the worker (\`captain-memo restart\`) so this pairing takes effect.`);
    return 0;
  }

  if (sub === 'list') {
    const cfg = loadGatewayConfig();
    if (cfg.devices.length === 0) {
      console.log('No devices paired. Run `captain-memo gateway pair --label <name>` to add one.');
      return 0;
    }
    console.log(`${cfg.devices.length} paired device(s):\n`);
    for (const d of cfg.devices) {
      const since = new Date(d.created_at_epoch * 1000).toISOString().slice(0, 10);
      console.log(`  ${d.id}  ${d.label}  (paired ${since})`);
    }
    return 0;
  }

  if (sub === 'revoke') {
    const id = args[1];
    if (!id) {
      console.error('usage: captain-memo gateway revoke <device-id>');
      return 2;
    }
    const removed = revokeDevice(id);
    console.log(removed ? `Revoked ${id}.` : `No paired device ${id} found.`);
    return removed ? 0 : 1;
  }

  console.error(`Unknown gateway subcommand: ${sub}`);
  console.error(HELP);
  return 2;
}
