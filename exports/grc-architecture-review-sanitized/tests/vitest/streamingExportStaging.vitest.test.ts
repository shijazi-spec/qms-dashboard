import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { promises as fsp } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  _resetStagedExportCacheForTests,
  deriveStreamingExportJobKey,
  runStagedExportJanitor,
  stageAndServeStreamingExport,
} from '../../src/utils/excelExport';

const CACHE_DIR = path.join(os.tmpdir(), `ExampleOrg-export-cache-test-${process.pid}`);

beforeAll(() => {
  process.env.STREAMING_EXPORT_CACHE_DIR = CACHE_DIR;
  process.env.STREAMING_EXPORT_DISABLE_JANITOR = '1';
});

afterEach(async () => {
  await _resetStagedExportCacheForTests();
});

function makeBuf(size: number, seedByte = 0): Buffer {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i++) b[i] = (i + seedByte) & 0xff;
  return b;
}

function makeStreamingResponse(
  body: Buffer,
  headers: Record<string, string> = {},
  status = 200
): Response {
  // Build a real Web ReadableStream that emits the body across multiple
  // chunks so the staging drain loop exercises its multi-iteration path
  // (a single push() would tee into one read() call).
  const CHUNK = 256;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let off = 0;
      while (off < body.byteLength) {
        const end = Math.min(off + CHUNK, body.byteLength);
        controller.enqueue(new Uint8Array(body.subarray(off, end)));
        off = end;
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="x.bin"',
      ...headers,
    },
  });
}

describe('stageAndServeStreamingExport', () => {
  it('drains a streaming Response to disk and serves the full body with Range headers', async () => {
    const buf = makeBuf(2048);
    let buildCalls = 0;
    const res = await stageAndServeStreamingExport({}, 'k1', () => {
      buildCalls++;
      return makeStreamingResponse(buf);
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-length')).toBe(String(buf.byteLength));
    expect(res.headers.get('etag')).toMatch(/^W\/"/);
    expect(res.headers.get('content-disposition')).toContain('x.bin');
    expect(res.headers.get('content-type')).toBe('application/octet-stream');

    const out = new Uint8Array(await res.arrayBuffer());
    expect(out.byteLength).toBe(buf.byteLength);
    expect(out[0]).toBe(buf[0]);
    expect(out[out.byteLength - 1]).toBe(buf[buf.byteLength - 1]);
    expect(buildCalls).toBe(1);
  });

  it('serves the cached file on a subsequent request without re-running build()', async () => {
    const buf = makeBuf(4096);
    let buildCalls = 0;
    const build = () => {
      buildCalls++;
      return makeStreamingResponse(buf);
    };

    const r1 = await stageAndServeStreamingExport({}, 'k2', build);
    await r1.arrayBuffer();
    const etag = r1.headers.get('etag')!;

    const r2 = await stageAndServeStreamingExport({}, 'k2', build);
    expect(r2.headers.get('etag')).toBe(etag);
    expect(buildCalls).toBe(1);
  });

  it('returns 206 + Content-Range for `bytes=N-M` requests against the staged file', async () => {
    const buf = makeBuf(4096);
    await stageAndServeStreamingExport({}, 'k3', () => makeStreamingResponse(buf));

    const r = await stageAndServeStreamingExport(
      { range: 'bytes=1000-1009' },
      'k3',
      () => { throw new Error('build() should not run on cache hit'); }
    );
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe(`bytes 1000-1009/${buf.byteLength}`);
    expect(r.headers.get('content-length')).toBe('10');
    const out = new Uint8Array(await r.arrayBuffer());
    expect(Array.from(out)).toEqual([1000 & 0xff, 1001 & 0xff, 1002 & 0xff, 1003 & 0xff,
      1004 & 0xff, 1005 & 0xff, 1006 & 0xff, 1007 & 0xff, 1008 & 0xff, 1009 & 0xff]);
  });

  it('honours suffix `bytes=-N` ranges for resume-tail reads', async () => {
    const buf = makeBuf(3072);
    await stageAndServeStreamingExport({}, 'k4', () => makeStreamingResponse(buf));
    const r = await stageAndServeStreamingExport(
      { range: 'bytes=-32' },
      'k4',
      () => { throw new Error('no rebuild'); }
    );
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe(`bytes ${buf.byteLength - 32}-${buf.byteLength - 1}/${buf.byteLength}`);
    const out = new Uint8Array(await r.arrayBuffer());
    expect(out.byteLength).toBe(32);
    expect(out[out.byteLength - 1]).toBe(buf[buf.byteLength - 1]);
  });

  it('returns 416 + `Content-Range: bytes */N` for unsatisfiable ranges', async () => {
    const buf = makeBuf(512);
    await stageAndServeStreamingExport({}, 'k5', () => makeStreamingResponse(buf));
    const r = await stageAndServeStreamingExport(
      { range: 'bytes=<REDACTED_PHONE>' },
      'k5',
      () => { throw new Error('no rebuild'); }
    );
    expect(r.status).toBe(416);
    expect(r.headers.get('content-range')).toBe(`bytes */${buf.byteLength}`);
  });

  it('falls back to a 200 full-body response when If-Range no longer matches', async () => {
    const buf = makeBuf(1024);
    await stageAndServeStreamingExport({}, 'k6', () => makeStreamingResponse(buf));
    const r = await stageAndServeStreamingExport(
      { range: 'bytes=100-199', 'if-range': 'W/"stale"' },
      'k6',
      () => { throw new Error('no rebuild'); }
    );
    expect(r.status).toBe(200);
    const out = new Uint8Array(await r.arrayBuffer());
    expect(out.byteLength).toBe(buf.byteLength);
  });

  it('continues serving a 206 even when If-Range matches the current ETag', async () => {
    const buf = makeBuf(800);
    const r1 = await stageAndServeStreamingExport({}, 'k7', () => makeStreamingResponse(buf));
    await r1.arrayBuffer();
    const etag = r1.headers.get('etag')!;
    const r2 = await stageAndServeStreamingExport(
      { range: 'bytes=10-19', 'if-range': etag },
      'k7',
      () => { throw new Error('no rebuild'); }
    );
    expect(r2.status).toBe(206);
    expect(r2.headers.get('content-range')).toBe(`bytes 10-19/${buf.byteLength}`);
  });

  it('expires entries past TTL on the next access (lazy GC)', async () => {
    const buf = makeBuf(256);
    let buildCalls = 0;
    const build = () => { buildCalls++; return makeStreamingResponse(buf); };

    await stageAndServeStreamingExport({}, 'k8', build, { ttlMs: 1 });
    await new Promise((r) => setTimeout(r, 10));
    await stageAndServeStreamingExport({}, 'k8', build, { ttlMs: 1 });
    expect(buildCalls).toBe(2);
  });

  it('runStagedExportJanitor reaps expired entries and unlinks their files', async () => {
    const buf = makeBuf(128);
    const r1 = await stageAndServeStreamingExport({}, 'k9', () => makeStreamingResponse(buf), { ttlMs: 1 });
    await r1.arrayBuffer();
    // Filenames carry a per-staging generation suffix, so glob the cache
    // dir for any file whose prefix matches the jobKey hash.
    const prefix = require('crypto').createHash('sha256').update('k9').digest('hex');
    const filesBefore = (await fsp.readdir(CACHE_DIR)).filter((f) => f.startsWith(prefix));
    expect(filesBefore.length).toBe(1);
    const file = path.join(CACHE_DIR, filesBefore[0]);
    expect(await fsp.stat(file).then(() => true)).toBe(true);

    await new Promise((r) => setTimeout(r, 20));
    const reaped = await runStagedExportJanitor();
    expect(reaped).toBeGreaterThanOrEqual(1);
    await expect(fsp.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('re-staging after TTL expiry while a slow reader is mid-stream does NOT corrupt the in-flight read (different on-disk generation)', async () => {
    const buf1 = makeBuf(2048, 0);
    // Stage with a tiny TTL so the next call sees a stale entry that has
    // a non-zero refCount (we hold a reader open across the second
    // stageAndServeStreamingExport call).
    const r1 = await stageAndServeStreamingExport({}, 'k_gen', () => makeStreamingResponse(buf1), { ttlMs: 5 });
    expect(r1.status).toBe(200);
    const reader = r1.body!.getReader();
    // Pull the very first chunk so we have a real in-flight read on the
    // gen-1 file but stop before the file is fully drained.
    const first = await reader.read();
    expect(first.done).toBe(false);

    // Let the TTL elapse so the next stage triggers reapStagedEntry.
    await new Promise((r) => setTimeout(r, 20));

    // Re-stage the same jobKey with a fresh body — gen-2 must land in a
    // different on-disk file or the slow reader above would observe the
    // gen-1 file truncated mid-read.
    const buf2 = makeBuf(2048, 99);
    const r2 = await stageAndServeStreamingExport({}, 'k_gen', () => makeStreamingResponse(buf2));
    expect(r2.status).toBe(200);
    const out2 = new Uint8Array(await r2.arrayBuffer());
    expect(Buffer.from(out2).equals(buf2)).toBe(true);

    // Drain the slow reader fully — the bytes it sees must come from
    // gen-1 (buf1), NOT a mix with gen-2.
    const chunks: Uint8Array[] = [first.value!];
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    expect(total).toBe(buf1.byteLength);
    const merged = Buffer.alloc(total);
    let off = 0;
    for (const c of chunks) {
      Buffer.from(c.buffer, c.byteOffset, c.byteLength).copy(merged, off);
      off += c.byteLength;
    }
    expect(merged.equals(buf1)).toBe(true);

    // And both generations occupy distinct on-disk files.
    const prefix = require('crypto').createHash('sha256').update('k_gen').digest('hex');
    const filesNow = (await fsp.readdir(CACHE_DIR)).filter((f) => f.startsWith(prefix));
    // gen-1 has been reaped on access, but its file lingers on disk
    // until the slow reader released it; we just released it above, so
    // give the unlink one tick to settle.
    await new Promise((r) => setTimeout(r, 10));
    const filesAfter = (await fsp.readdir(CACHE_DIR)).filter((f) => f.startsWith(prefix));
    expect(filesNow.length).toBeGreaterThanOrEqual(1);
    // Only the live (gen-2) file should remain.
    expect(filesAfter.length).toBe(1);
  });

  it('coalesces simultaneous in-flight stagings into a single build() call', async () => {
    const buf = makeBuf(512);
    let buildCalls = 0;
    const build = async () => {
      buildCalls++;
      // Yield so both callers attach to the same in-flight promise.
      await new Promise((r) => setTimeout(r, 5));
      return makeStreamingResponse(buf);
    };
    const [r1, r2] = await Promise.all([
      stageAndServeStreamingExport({}, 'k10', build),
      stageAndServeStreamingExport({}, 'k10', build),
    ]);
    expect(buildCalls).toBe(1);
    expect(r1.headers.get('etag')).toBe(r2.headers.get('etag'));
  });

  it('does not cache non-200 responses — they pass straight through', async () => {
    let buildCalls = 0;
    const build = () => {
      buildCalls++;
      return new Response(JSON.stringify({ error: 'nope' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const r1 = await stageAndServeStreamingExport({}, 'k11', build);
    expect(r1.status).toBe(401);
    expect(await r1.json()).toEqual({ error: 'nope' });
    const r2 = await stageAndServeStreamingExport({}, 'k11', build);
    expect(r2.status).toBe(401);
    expect(await r2.json()).toEqual({ error: 'nope' });
    expect(buildCalls).toBe(2);
  });

  it('concurrent waiters on a non-200 staging each get a fresh, readable Response (single build)', async () => {
    let buildCalls = 0;
    const build = async () => {
      buildCalls++;
      // Yield so both callers attach to the same in-flight promise
      // before build() returns.
      await new Promise((r) => setTimeout(r, 5));
      return new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const [r1, r2] = await Promise.all([
      stageAndServeStreamingExport({}, 'k11b', build),
      stageAndServeStreamingExport({}, 'k11b', build),
    ]);
    expect(buildCalls).toBe(1);
    expect(r1.status).toBe(403);
    expect(r2.status).toBe(403);
    // Both callers must be able to consume their own body — Response
    // bodies are single-shot, so a regression here would surface as an
    // "already-disturbed" error on the follower.
    expect(await r1.json()).toEqual({ error: 'forbidden' });
    expect(await r2.json()).toEqual({ error: 'forbidden' });
  });

  it('handles a 0-byte staged response without throwing', async () => {
    const r1 = await stageAndServeStreamingExport({}, 'k12', () => makeStreamingResponse(Buffer.alloc(0)));
    expect(r1.status).toBe(200);
    expect(r1.headers.get('content-length')).toBe('0');
    const out = new Uint8Array(await r1.arrayBuffer());
    expect(out.byteLength).toBe(0);
  });

  it.runIf(process.platform !== 'win32')(
    'creates the cache directory with mode 0o700 and staged files with mode 0o600',
    async () => {
      // Drain a non-empty body so we exercise the fs.open("w", 0o600) path.
      const buf = makeBuf(1024);
      const r1 = await stageAndServeStreamingExport({}, 'k_perm', () => makeStreamingResponse(buf));
      await r1.arrayBuffer();

      // Directory itself must be owner-only — no group/other bits.
      const dirStat = await fsp.stat(CACHE_DIR);
      expect(dirStat.mode & 0o777).toBe(0o700);

      // The staged file for this jobKey must be owner-read/write only.
      const prefix = require('crypto').createHash('sha256').update('k_perm').digest('hex');
      const files = (await fsp.readdir(CACHE_DIR)).filter((f) => f.startsWith(prefix));
      expect(files.length).toBe(1);
      const fileStat = await fsp.stat(path.join(CACHE_DIR, files[0]));
      expect(fileStat.mode & 0o777).toBe(0o600);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'creates a 0-byte staged file with mode 0o600 (empty-body code path)',
    async () => {
      // Build a Response with a *null* body to drive the
      // `await fsPromises.writeFile(filePath, Buffer.alloc(0), { mode: 0o600 })`
      // branch in drainResponseBodyToFile — distinct from the streaming path
      // covered above.
      const r1 = await stageAndServeStreamingExport({}, 'k_perm_empty', () =>
        new Response(null, {
          status: 200,
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': 'attachment; filename="empty.bin"',
          },
        }),
      );
      await r1.arrayBuffer();

      const prefix = require('crypto').createHash('sha256').update('k_perm_empty').digest('hex');
      const files = (await fsp.readdir(CACHE_DIR)).filter((f) => f.startsWith(prefix));
      expect(files.length).toBe(1);
      const fileStat = await fsp.stat(path.join(CACHE_DIR, files[0]));
      expect(fileStat.size).toBe(0);
      expect(fileStat.mode & 0o777).toBe(0o600);
    },
  );
});

describe('deriveStreamingExportJobKey', () => {
  it('produces a deterministic hex digest', () => {
    const a = deriveStreamingExportJobKey({ url: '/api/x?y=1', userIdentity: 'u1' });
    const b = deriveStreamingExportJobKey({ url: '/api/x?y=1', userIdentity: 'u1' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('changes when URL, identity, or extra differs', () => {
    const a = deriveStreamingExportJobKey({ url: '/api/x', userIdentity: 'u1' });
    const b = deriveStreamingExportJobKey({ url: '/api/y', userIdentity: 'u1' });
    const c = deriveStreamingExportJobKey({ url: '/api/x', userIdentity: 'u2' });
    const d = deriveStreamingExportJobKey({ url: '/api/x', userIdentity: 'u1', extra: 'v2' });
    expect(new Set([a, b, c, d]).size).toBe(4);
  });
});
