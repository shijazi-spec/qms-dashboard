import {
  buildSectionInfographic,
  SECTION_CATALOG,
  type InfographicSection,
} from '../../utils/infographicBuilder';

const VALID_SECTIONS = new Set(SECTION_CATALOG.map(s => s.id));

async function svgToPng(svg: string): Promise<Buffer> {
  const { spawn } = await import('child_process');
  return new Promise((resolve, reject) => {
    let settled = false;
    const proc = spawn('magick', [
      '-density', '144',
      '-background', '#0f172a',
      'svg:-',
      '-resize', '1200x1500',
      '-quality', '92',
      'png:-',
    ]);
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    const finish = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(killer); fn(); } };
    const killer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      finish(() => reject(new Error('magick timed out after 15s')));
    }, 15000);

    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    proc.stderr.on('data', (d: Buffer) => errChunks.push(d));
    proc.on('error', (err) => finish(() => reject(
      err && (err as any).code === 'ENOENT'
        ? new Error('ImageMagick (`magick`) is not installed on this server')
        : err
    )));
    proc.on('close', (code) => finish(() => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`magick exited ${code}: ${Buffer.concat(errChunks).toString().slice(0, 200)}`));
    }));
    try {
      proc.stdin.on('error', (err) => finish(() => reject(err)));
      proc.stdin.write(svg);
      proc.stdin.end();
    } catch (err) {
      finish(() => reject(err as Error));
    }
  });
}

export const infographicRoutes = [
  {
    path: '/api/infographic/sections',
    method: 'GET' as const,
    createHandler: async () => {
      return async (c: any) => {
        return c.json({ sections: SECTION_CATALOG });
      };
    },
  },
  {
    path: '/api/infographic/:section',
    method: 'GET' as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        const logger = mastra?.getLogger();
        const raw = c.req.param('section') || '';
        const url = new URL(c.req.url);
        const wantPng = raw.endsWith('.png') || url.searchParams.get('format') === 'png';
        const wantDownload = url.searchParams.get('download') === '1';
        const section = raw.replace(/\.(svg|png)$/, '') as InfographicSection;

        if (!VALID_SECTIONS.has(section)) {
          return c.json({ error: 'Unknown section', valid: Array.from(VALID_SECTIONS) }, 404);
        }

        try {
          logger?.info(`🎨 [Infographic] Rendering ${section} (${wantPng ? 'png' : 'svg'})`);
          const svg = await buildSectionInfographic(section);
          const stamp = new Date().toISOString().slice(0, 10);
          const filename = `walaplus-${section}-${stamp}.${wantPng ? 'png' : 'svg'}`;

          if (wantPng) {
            const png = await svgToPng(svg);
            c.header('Content-Type', 'image/png');
            if (wantDownload) c.header('Content-Disposition', `attachment; filename="${filename}"`);
            c.header('Cache-Control', 'no-store');
            return c.body(png);
          }

          c.header('Content-Type', 'image/svg+xml; charset=utf-8');
          if (wantDownload) c.header('Content-Disposition', `attachment; filename="${filename}"`);
          c.header('Cache-Control', 'no-store');
          return c.body(svg);
        } catch (error: any) {
          console.error('[Infographic] Render failed:', error);
          return c.json({ error: 'Failed to render infographic', detail: error?.message }, 500);
        }
      };
    },
  },
];
