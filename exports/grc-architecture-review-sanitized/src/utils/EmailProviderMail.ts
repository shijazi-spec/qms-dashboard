import { EmailProvider } from "EmailProvider";

import { logger } from "./logger";
const EmailProvider_API_KEY = process.env.EmailProvider_API_KEY;
// Use EmailProvider's testing domain if no custom from email is set
// This allows emails to work immediately without domain verification
const FROM_EMAIL =
  process.env.EmailProvider_FROM_EMAIL || "ExampleOrg QMS <user@example.invalid>";

/**
 * Returns true when the EmailProvider email helper is fully configured and
 * ready to send. Centralised so callers (e.g. the post-restore sweep
 * alert dispatcher in `redactHistoricalLogs.ts`) can silently skip
 * their email channel when this returns false — exactly the same
 * unconfigured-helper gate `getEmailProviderClient()` applies internally —
 * without each caller having to re-implement the `length >= 20`
 * sentinel-key check.
 */
export function isEmailProviderConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const apiKey = env.EmailProvider_API_KEY;
  return typeof apiKey === "string" && apiKey.length >= 20;
}

// Create new EmailProvider instance each time to pick up env changes
function getEmailProviderClient() {
  if (!isEmailProviderConfigured()) return null;
  return new EmailProvider(process.env.EmailProvider_API_KEY!);
}

export interface EmailProviderEmailOptions {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
}

export async function sendEmailProviderEmail(options: EmailProviderEmailOptions): Promise<{
  success: boolean;
  id?: string;
  error?: string;
}> {
  const EmailProvider = getEmailProviderClient();
  const currentApiKey = process.env.EmailProvider_API_KEY;

  if (!EmailProvider) {
    logger.warn(
      `⚠️ [EmailProviderMail] Email service not configured - email will not be sent`,
    );
    return {
      success: false,
      error:
        "Email service is not configured. Please contact your administrator.",
    };
  }

  try {
    const recipients = Array.isArray(options.to) ? options.to : [options.to];
    const fromEmail =
      process.env.EmailProvider_FROM_EMAIL || "ExampleOrg QMS <user@example.invalid>";

    logger.info(`📧 [EmailProviderMail] Sending email to: ${recipients.join(", ")}`);
    logger.info(`📧 [EmailProviderMail] From: ${fromEmail}`);
    logger.info(`📧 [EmailProviderMail] Subject: ${options.subject}`);
    logger.info(`📧 [EmailProviderMail] API Key length: ${currentApiKey?.length}`);

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

    const { data, error } = await EmailProvider.emails.send(emailPayload);

    if (error) {
      logger.error("❌ [EmailProviderMail] Failed to send email:", error);
      return {
        success: false,
        error: error.message,
      };
    }

    logger.info(`✅ [EmailProviderMail] Email sent successfully. ID: ${data?.id}`);
    return {
      success: true,
      id: data?.id,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("❌ [EmailProviderMail] Exception sending email:", errorMessage);
    return {
      success: false,
      error: errorMessage,
    };
  }
}

export const QUALITY_REPORT_RECIPIENTS = [
  "user@example.invalid",
  "user@example.invalid",
];
