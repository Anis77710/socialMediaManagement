export type SmsPurpose = "LOGIN" | "PHONE_CHANGE" | "GOOGLE_ATTACH" | "ALERT";

export type SmsMessage = {
  to: string;
  text: string;
  purpose: SmsPurpose;
  ref: string;
};

export interface SmsProvider {
  send(message: SmsMessage): Promise<void>;
}

export interface SmsSender {
  enqueue(message: SmsMessage): Promise<void>;
  close(): Promise<void>;
}

export class SmsProviderError extends Error {
  readonly retryable: boolean;
  readonly lowCredit: boolean;

  constructor(message: string, options: { retryable: boolean; lowCredit?: boolean }) {
    super(message);
    this.name = "SmsProviderError";
    this.retryable = options.retryable;
    this.lowCredit = options.lowCredit ?? false;
  }
}

export interface SmsAlert {
  (message: string, meta?: Record<string, unknown>): void;
}

