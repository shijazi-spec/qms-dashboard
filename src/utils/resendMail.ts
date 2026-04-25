import { Resend } from 'resend';

const RESEND_API_KEY = process.env.RESEND_API_KEY;
// Use Resend's testing domain if no custom from email is set
// This allows emails to work immediately without domain verification
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'WalaPlus QMS <onboarding@resend.dev>';

/**
 * Returns true when the Resend email helper is fully configured and
 * ready to send. Centralised so callers (e.g. the post-restore sweep
 * alert dispatcher in `redactHistoricalLogs.ts`) can silently skip
 * their email channel when this returns false — exactly the same
 * unconfigured-helper gate `getResendClient()` applies internally —
 * without each caller having to re-implement the `length >= 20`
 * sentinel-key check.
 */
export function isResendConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const apiKey = env.RESEND_API_KEY;
  return typeof apiKey === "string" && apiKey.length >= 20;
}

// Create new Resend instance each time to pick up env changes
function getResendClient() {
  if (!isResendConfigured()) return null;
  return new Resend(process.env.RESEND_API_KEY!);
}

export interface ResendEmailOptions {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
}

export async function sendResendEmail(options: ResendEmailOptions): Promise<{
  success: boolean;
  id?: string;
  error?: string;
}> {
  const resend = getResendClient();
  const currentApiKey = process.env.RESEND_API_KEY;
  
  if (!resend) {
    console.warn(`⚠️ [ResendMail] Email service not configured - email will not be sent`);
    return {
      success: false,
      error: 'Email service is not configured. Please contact your administrator.'
    };
  }

  try {
    const recipients = Array.isArray(options.to) ? options.to : [options.to];
    const fromEmail = process.env.RESEND_FROM_EMAIL || 'WalaPlus QMS <onboarding@resend.dev>';
    
    console.log(`📧 [ResendMail] Sending email to: ${recipients.join(', ')}`);
    console.log(`📧 [ResendMail] From: ${fromEmail}`);
    console.log(`📧 [ResendMail] Subject: ${options.subject}`);
    console.log(`📧 [ResendMail] API Key length: ${currentApiKey?.length}`);

    const emailPayload: any = {
      from: fromEmail,
      to: recipients,
      subject: options.subject,
    };
    
    if (options.html) emailPayload.html = options.html;
    if (options.text) emailPayload.text = options.text;
    if (options.cc) emailPayload.cc = options.cc;
    if (options.bcc) emailPayload.bcc = options.bcc;
    if (options.replyTo) emailPayload.replyTo = options.replyTo;

    const { data, error } = await resend.emails.send(emailPayload);

    if (error) {
      console.error('❌ [ResendMail] Failed to send email:', error);
      return {
        success: false,
        error: error.message
      };
    }

    console.log(`✅ [ResendMail] Email sent successfully. ID: ${data?.id}`);
    return {
      success: true,
      id: data?.id
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('❌ [ResendMail] Exception sending email:', errorMessage);
    return {
      success: false,
      error: errorMessage
    };
  }
}

export const QUALITY_REPORT_RECIPIENTS = [
  'a.amashah@walaplus.com',
  's.hijazi@walaplus.com'
];
