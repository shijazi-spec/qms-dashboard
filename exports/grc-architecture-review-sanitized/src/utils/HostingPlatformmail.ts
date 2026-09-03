import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { z } from "zod";

export const zSmtpMessage = z.object({
  subject: z.string().describe("Email subject"),
  text: z.string().optional().describe("Plain text body"),
  html: z.string().optional().describe("HTML body"),
  attachments: z
    .array(
      z.object({
        filename: z.string().describe("File name"),
        content: z.string().describe("Base64 encoded content"),
        contentType: z.string().optional().describe("MIME type"),
        encoding: z
          .enum(["base64", "7bit", "quoted-printable", "binary"])
          .default("base64"),
      })
    )
    .optional()
    .describe("Email attachments"),
});

export type SmtpMessage = z.infer<typeof zSmtpMessage>;

async function getAuthToken(): Promise<{ authToken: string; hostname: string }> {
  const hostname = process.env.HostingPlatform_CONNECTORS_HOSTNAME;
  if (!hostname) {
    throw new Error("HostingPlatform_CONNECTORS_HOSTNAME environment variable is not set");
  }
  
  const { stdout } = await promisify(execFile)(
    "HostingPlatform",
    ["identity", "create", "--audience", `<REDACTED_URL>`],
    { encoding: "utf8" }
  );

  const HostingPlatformToken = stdout.trim();
  if (!HostingPlatformToken) {
    throw new Error("HostingPlatform Identity Token not found for repl/depl");
  }

  return { authToken: `<REDACTED_SECRET>`, hostname };
}

export async function sendEmail(message: SmtpMessage): Promise<{
  accepted: string[];
  rejected: string[];
  pending?: string[];
  messageId: string;
  response: string;
}> {
  const { hostname, authToken } = await getAuthToken();

  const response = await fetch(`<REDACTED_URL>`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "HostingPlatform-Authentication": authToken,
    },
    body: JSON.stringify({
      subject: message.subject,
      text: message.text,
      html: message.html,
      attachments: message.attachments,
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || "Failed to send email");
  }

  return await response.json();
}
