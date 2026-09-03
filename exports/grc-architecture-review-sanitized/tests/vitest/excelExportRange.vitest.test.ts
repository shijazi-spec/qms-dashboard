import { describe, it, expect } from 'vitest';
import { bufferResponseWithRange } from '../../src/utils/excelExport';

const MIME = 'application/octet-stream';

function makeBuffer(size: number): Buffer {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i++) b[i] = i & 0xff;
  return b;
}

function readHeaderBag(name: string): Headers {
  const h = new Headers();
  void name;
  return h;
}

describe('bufferResponseWithRange', () => {
  const buf = makeBuffer(4096);

  it('returns 200 + full body when no Range header is provided', async () => {
    const res = bufferResponseWithRange(buf, MIME, 'demo.bin', new Headers());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String(buf.byteLength));
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('etag')).toMatch(/^W\/"/);
    expect(res.headers.get('content-disposition')).toContain('demo.bin');
    const out = new Uint8Array(await res.arrayBuffer());
    expect(out.byteLength).toBe(buf.byteLength);
    expect(out[0]).toBe(buf[0]);
    expect(out[out.byteLength - 1]).toBe(buf[buf.byteLength - 1]);
  });

  it('emits 206 + Content-Range for `bytes=N-` open-ended ranges', async () => {
    const headers = new Headers({ Range: 'bytes=1000-' });
    const res = bufferResponseWithRange(buf, MIME, 'demo.bin', headers);
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 1000-4095/${buf.byteLength}`);
    expect(res.headers.get('content-length')).toBe(String(buf.byteLength - 1000));
    const out = new Uint8Array(await res.arrayBuffer());
    expect(out.byteLength).toBe(buf.byteLength - 1000);
    expect(out[0]).toBe(buf[1000]);
    expect(out[out.byteLength - 1]).toBe(buf[buf.byteLength - 1]);
  });

  it('emits 206 for closed `bytes=N-M` ranges, clamping M to total-1', async () => {
    const headers = new Headers({ Range: 'bytes=10-19' });
    const res = bufferResponseWithRange(buf, MIME, 'demo.bin', headers);
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 10-19/${buf.byteLength}`);
    expect(res.headers.get('content-length')).toBe('10');
    const out = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(out)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });

  it('emits 206 for suffix `bytes=-N` ranges (last N bytes)', async () => {
    const headers = new Headers({ Range: 'bytes=-16' });
    const res = bufferResponseWithRange(buf, MIME, 'demo.bin', headers);
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 4080-4095/${buf.byteLength}`);
    expect(res.headers.get('content-length')).toBe('16');
    const out = new Uint8Array(await res.arrayBuffer());
    expect(out.byteLength).toBe(16);
    expect(out[0]).toBe(buf[4080]);
  });

  it('returns 416 with `Content-Range: bytes */total` for unsatisfiable ranges', async () => {
    const headers = new Headers({ Range: 'bytes=10000-' });
    const res = bufferResponseWithRange(buf, MIME, 'demo.bin', headers);
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe(`bytes */${buf.byteLength}`);
    const out = new Uint8Array(await res.arrayBuffer());
    expect(out.byteLength).toBe(0);
  });

  it('falls back to 200 (full body) on a malformed Range header — RFC 7233 §3.1', async () => {
    const headers = new Headers({ Range: 'kilobytes=1-2' });
    const res = bufferResponseWithRange(buf, MIME, 'demo.bin', headers);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String(buf.byteLength));
  });

  it('returns 200 (full body) when If-Range no longer matches the validator', async () => {
    // First request to discover the etag the helper would emit.
    const probe = bufferResponseWithRange(buf, MIME, 'demo.bin', new Headers());
    const etag = probe.headers.get('etag') || '';
    expect(etag).not.toBe('');

    const headers = new Headers({ Range: 'bytes=100-', 'If-Range': etag + 'STALE' });
    const res = bufferResponseWithRange(buf, MIME, 'demo.bin', headers);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String(buf.byteLength));
  });

  it('honours If-Range when the validator still matches → 206', async () => {
    const probe = bufferResponseWithRange(buf, MIME, 'demo.bin', new Headers());
    const etag = probe.headers.get('etag') || '';
    const headers = new Headers({ Range: 'bytes=100-', 'If-Range': etag });
    const res = bufferResponseWithRange(buf, MIME, 'demo.bin', headers);
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 100-4095/${buf.byteLength}`);
  });

  it('produces stable weak etags — identical buffers → identical etags', () => {
    const a = bufferResponseWithRange(buf, MIME, 'demo.bin', new Headers());
    const b = bufferResponseWithRange(makeBuffer(4096), MIME, 'demo.bin', new Headers());
    expect(a.headers.get('etag')).toBe(b.headers.get('etag'));
  });

  it('produces different etags for buffers with different content/size', () => {
    const a = bufferResponseWithRange(buf, MIME, 'demo.bin', new Headers());
    const altered = makeBuffer(4096);
    altered[0] = 0xff; // perturb the first byte (in head sample)
    const b = bufferResponseWithRange(altered, MIME, 'demo.bin', new Headers());
    expect(a.headers.get('etag')).not.toBe(b.headers.get('etag'));

    const c = bufferResponseWithRange(makeBuffer(8192), MIME, 'demo.bin', new Headers());
    expect(a.headers.get('etag')).not.toBe(c.headers.get('etag'));
  });

  it('accepts a plain object with lowercase header keys (Hono shim)', async () => {
    const headers = { range: 'bytes=0-3' };
    const res = bufferResponseWithRange(buf, MIME, 'demo.bin', headers);
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 0-3/${buf.byteLength}`);
    const out = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(out)).toEqual([0, 1, 2, 3]);
  });

  it('lets extraHeaders override Content-Disposition (e.g. inline file viewer)', () => {
    const res = bufferResponseWithRange(buf, MIME, 'demo.bin', new Headers(), {
      extraHeaders: { 'Content-Disposition': 'inline; filename="demo.bin"' },
    });
    expect(res.headers.get('content-disposition')).toBe('inline; filename="demo.bin"');
  });

  // Suppress unused helper warning — kept around for future header-shim tests.
  void readHeaderBag;
});
