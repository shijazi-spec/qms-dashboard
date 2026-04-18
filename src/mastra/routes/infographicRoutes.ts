import {
  buildSectionInfographic,
  SECTION_CATALOG,
  type InfographicSection,
} from '../../utils/infographicBuilder';

const VALID_SECTIONS = new Set(SECTION_CATALOG.map(s => s.id));

function sectionMeta(id: string) {
  return SECTION_CATALOG.find(s => s.id === id);
}

function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

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
    path: '/api/infographic/:section/share/slack',
    method: 'POST' as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        const logger = mastra?.getLogger();
        const section = c.req.param('section') as InfographicSection;
        if (!VALID_SECTIONS.has(section)) {
          return c.json({ error: 'Unknown section' }, 404);
        }
        let body: any = {};
        try { body = await c.req.json(); } catch {}
        const channelOverride: string | undefined = body?.channel?.trim() || undefined;
        const comment: string | undefined = body?.comment?.trim() || undefined;

        try {
          const channel = channelOverride
            || process.env.SLACK_CHANNEL_ID
            || process.env.SLACK_QMS_CHANNEL;
          if (!channel) return c.json({ error: 'No Slack channel configured. Provide a channel ID or set SLACK_CHANNEL_ID.' }, 400);
          const token = process.env.SLACK_BOT_TOKEN || process.env.SLACK_API_TOKEN;
          if (!token) return c.json({ error: 'Slack is not configured (missing SLACK_BOT_TOKEN).' }, 400);

          const meta = sectionMeta(section)!;
          const stamp = new Date().toISOString().slice(0, 10);
          const filename = `walaplus-${section}-${stamp}.png`;

          logger?.info(`📤 [Infographic] Sharing ${section} to Slack channel ${channel}`);
          const svg = await buildSectionInfographic(section);
          const png = await svgToPng(svg);

          const { WebClient } = await import('@slack/web-api');
          const client = new WebClient(token);
          const headerText = `📊 *${meta.title}* — ${meta.subtitle}`;
          const userComment = comment || 'Generated from live WalaPlus data.';

          try {
            const result: any = await client.files.uploadV2({
              channel_id: channel,
              file: png,
              filename,
              title: `${meta.title} — WalaPlus`,
              initial_comment: `${headerText}\n${userComment}`,
            });
            return c.json({
              success: true,
              mode: 'file',
              channel,
              filename,
              file_id: result?.files?.[0]?.id || result?.file?.id || null,
            });
          } catch (uploadErr: any) {
            const slackError = uploadErr?.data?.error || uploadErr?.message || '';
            // Graceful fallback: if the bot lacks files:write, post a rich text
            // message instead so the channel is still notified.
            if (slackError === 'missing_scope' || slackError === 'not_allowed_token_type') {
              console.warn(`[Infographic] files.uploadV2 lacks scope (${slackError}); falling back to chat.postMessage`);
              const blocks = [
                { type: 'header', text: { type: 'plain_text', text: meta.title } },
                { type: 'section', text: { type: 'mrkdwn', text: `*${meta.subtitle}*\n${userComment}` } },
                {
                  type: 'context',
                  elements: [
                    { type: 'mrkdwn', text: `📎 _A PNG attachment couldn't be uploaded — Slack bot is missing the *files:write* scope. Open the WalaPlus dashboard to view or download._` },
                  ],
                },
                { type: 'divider' },
                { type: 'context', elements: [{ type: 'mrkdwn', text: `🕒 Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · WalaPlus QMS` }] },
              ];
              await client.chat.postMessage({
                channel,
                text: `${meta.title} — ${meta.subtitle}`,
                blocks,
              });
              return c.json({
                success: true,
                mode: 'message',
                channel,
                note: 'Posted as a chat message because the Slack bot lacks files:write scope. Add files:write in OAuth & Permissions and reinstall the app to enable PNG attachments.',
              });
            }
            throw uploadErr;
          }
        } catch (error: any) {
          console.error('[Infographic] Slack share failed:', error?.data || error);
          return c.json({
            error: 'Failed to share to Slack',
            detail: error?.data?.error || error?.message || 'unknown',
          }, 500);
        }
      };
    },
  },
  {
    path: '/api/infographic/:section/share/email',
    method: 'POST' as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        const logger = mastra?.getLogger();
        const section = c.req.param('section') as InfographicSection;
        if (!VALID_SECTIONS.has(section)) {
          return c.json({ error: 'Unknown section' }, 404);
        }
        let body: any = {};
        try { body = await c.req.json(); } catch {}
        const toRaw = body?.to;
        const recipients: string[] = (Array.isArray(toRaw) ? toRaw : String(toRaw || '').split(/[,;\s]+/))
          .map((s: string) => s.trim())
          .filter(Boolean);
        const invalid = recipients.filter(r => !isEmail(r));
        if (recipients.length === 0) return c.json({ error: 'At least one recipient email is required' }, 400);
        if (invalid.length) return c.json({ error: `Invalid email(s): ${invalid.join(', ')}` }, 400);
        if (recipients.length > 20) return c.json({ error: 'Maximum 20 recipients per send' }, 400);

        const subject: string | undefined = body?.subject?.trim() || undefined;
        const message: string | undefined = body?.message?.trim() || undefined;

        try {
          if (!process.env.RESEND_API_KEY) {
            return c.json({ error: 'Email is not configured (missing RESEND_API_KEY).' }, 400);
          }
          const meta = sectionMeta(section)!;
          const stamp = new Date().toISOString().slice(0, 10);
          const filename = `walaplus-${section}-${stamp}.png`;

          logger?.info(`📧 [Infographic] Emailing ${section} to ${recipients.length} recipient(s)`);
          const svg = await buildSectionInfographic(section);
          const png = await svgToPng(svg);

          const { sendResendEmail } = await import('../../utils/resendMail');
          const subjectFinal = subject || `${meta.title} — WalaPlus snapshot (${stamp})`;
          const intro = message ? `<p>${escapeHtml(message)}</p>` : '';
          const html = `
            <div style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:0 auto;padding:24px;color:#1e293b">
              <h2 style="margin:0 0 8px;color:#0f172a">${escapeHtml(meta.title)}</h2>
              <p style="margin:0 0 16px;color:#64748b">${escapeHtml(meta.subtitle)}</p>
              ${intro}
              <p style="margin:16px 0 8px">The infographic is attached as <strong>${escapeHtml(filename)}</strong>.</p>
              <p style="margin:0;color:#64748b;font-size:12px">Generated from live WalaPlus production data on ${stamp}.</p>
              <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0">
              <p style="margin:0;color:#94a3b8;font-size:11px">WalaPlus Enterprise GRC &amp; Quality Platform</p>
            </div>`;

          // Resend supports attachments — sendResendEmail wraps emails.send,
          // but we need the lower-level call for attachments.
          const { Resend } = await import('resend');
          const resend = new Resend(process.env.RESEND_API_KEY);
          const fromEmail = process.env.RESEND_FROM_EMAIL || 'WalaPlus QMS <onboarding@resend.dev>';
          const { data, error } = await resend.emails.send({
            from: fromEmail,
            to: recipients,
            subject: subjectFinal,
            html,
            attachments: [{ filename, content: png }],
          } as any);

          if (error) {
            console.error('[Infographic] Email failed:', error);
            return c.json({ error: 'Failed to send email', detail: (error as any)?.message || error }, 500);
          }
          return c.json({ success: true, id: data?.id, recipients, filename });
        } catch (error: any) {
          console.error('[Infographic] Email share failed:', error);
          return c.json({ error: 'Failed to send email', detail: error?.message || 'unknown' }, 500);
        }
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
