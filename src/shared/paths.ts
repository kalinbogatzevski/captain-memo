import { homedir } from 'os';
import { join } from 'path';

export const DATA_DIR = process.env.AELITA_MCP_DATA_DIR ?? join(homedir(), '.aelita-mcp');

export const META_DB_PATH = join(DATA_DIR, 'meta.sqlite3');
export const QUEUE_DB_PATH = join(DATA_DIR, 'queue.db');
export const PENDING_EMBED_DB_PATH = join(DATA_DIR, 'pending_embed.db');
export const VECTOR_DB_DIR = join(DATA_DIR, 'vector-db');
export const LOGS_DIR = join(DATA_DIR, 'logs');
export const ARCHIVE_DIR = join(DATA_DIR, 'archive');
export const CONFIG_PATH = join(DATA_DIR, 'config.json');

export const DEFAULT_WORKER_PORT = 39888;
export const DEFAULT_VOYAGE_ENDPOINT = 'http://localhost:8124/v1/embeddings';
