import { test, expect } from 'bun:test';
import { workerErrorReason } from '../../../src/cli/client.ts';

test('workerErrorReason — the worker\'s own reason, not its raw JSON body', () => {
  expect(workerErrorReason(new Error('/homework/claim → 404: {"error":"not_found","detail":"no open homework #9"}'))).toBe('no open homework #9');
  expect(workerErrorReason(new Error('/x → 400: {"error":"invalid_request"}'))).toBe('invalid_request');
  expect(workerErrorReason(new Error('/x → 502: bad gateway'))).toBe('/x → 502: bad gateway');
  expect(workerErrorReason(new Error('Unable to connect. Is the computer able to access the url?'))).toBe('Unable to connect. Is the computer able to access the url?');
  expect(workerErrorReason(new Error('/x → 500: {not json'))).toBe('/x → 500: {not json');
});
