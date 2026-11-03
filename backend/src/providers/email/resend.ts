import type { EmailMessage, EmailProvider } from "./types.js";

export function createResendEmailProvider(options: {
  apiKey: string;
  from: string;
  fetchImpl?: typeof fetch;
}): EmailProvider {
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async send(message: EmailMessage) {
      const response = await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: options.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          ...(message.html ? { html: message.html } : {}),
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Resend rejected email (${response.status}): ${body}`);
      }
    },
  };
}
