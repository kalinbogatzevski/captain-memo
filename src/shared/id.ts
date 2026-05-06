import { customAlphabet } from 'nanoid';
import type { ChannelType } from './types.ts';

const shortId = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-', 8);

export function newChunkId(channel: ChannelType, source: string): string {
  return `${channel}:${source}:${shortId()}`;
}

export interface ParsedDocId {
  channel: ChannelType;
  source: string;
  shortId: string;
}

export function parseDocId(id: string): ParsedDocId | null {
  const parts = id.split(':');
  if (parts.length < 3) return null;
  const [channel, shortIdPart] = [parts[0], parts[parts.length - 1]];
  const source = parts.slice(1, -1).join(':');
  if (!channel || !source || !shortIdPart) return null;
  if (!['memory', 'skill', 'observation', 'remote'].includes(channel)) return null;
  return { channel: channel as ChannelType, source, shortId: shortIdPart };
}
