import type { SmsMessage, SmsProvider } from "./types.js";

export class FakeSmsProvider implements SmsProvider {
  readonly messages: SmsMessage[] = [];
  failNext = false;

  async send(message: SmsMessage): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("Fake SMS failure");
    }

    this.messages.push(message);
  }

  lastCode(): string | null {
    const last = this.messages.at(-1);
    const match = last?.text.match(/Redflie code: (\d{6})/);

    return match?.[1] ?? null;
  }
}
