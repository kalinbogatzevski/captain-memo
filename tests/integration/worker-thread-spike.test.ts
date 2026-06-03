import { test, expect } from 'bun:test';

// Proves the three foundations the design rests on, on whatever OS runs it:
// (1) a Bun Worker thread starts, (2) bun:sqlite opens + queries INSIDE it,
// (3) a postMessage round-trip works. If this fails, stop — the design's premise is wrong.
test('bun:sqlite opens in a Worker thread and round-trips a message', async () => {
  const src = `
    import { Database } from 'bun:sqlite';
    const db = new Database(':memory:');
    db.run('CREATE TABLE t (x INTEGER)');
    db.run('INSERT INTO t (x) VALUES (41)');
    self.onmessage = (e) => {
      const row = db.query('SELECT x+1 AS y FROM t').get();
      postMessage({ echo: e.data, y: row.y });
    };
  `;
  const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
  const w = new Worker(url);
  const reply = await new Promise<any>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('worker timeout')), 5000);
    w.onmessage = (e) => { clearTimeout(t); resolve(e.data); };
    w.onerror = (e) => { clearTimeout(t); reject(new Error(String((e as ErrorEvent).message))); };
    w.postMessage('ping');
  });
  w.terminate();
  expect(reply.echo).toBe('ping');
  expect(reply.y).toBe(42);
});
