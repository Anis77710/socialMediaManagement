import type { EmailMessage, EmailProvider } from "./types.js";

export class FakeEmailProvider implements EmailProvider {
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }

  last(): EmailMessage | undefined {
    return this.sent.at(-1);
  }

  lastTo(email: string): EmailMessage | undefined {
    return this.sent.filter((message) => message.to === email).at(-1);
  }

  clear(): void {
    this.sent.length = 0;
  }
}
