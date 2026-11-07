import type { EmailMessage, EmailProvider } from "./types.js";

type Logger = {
  info(object: Record<string, unknown>, message: string): void;
};

export function createConsoleEmailProvider(logger: Logger): EmailProvider {
  return {
    async send(message: EmailMessage) {
      logger.info(
        { to: message.to, subject: message.subject, text: message.text },
        "email_sent_console",
      );
    },
  };
}
