export type PushMessage = {
  title: string;
  body: string;
  data?: Record<string, string>;
};

export type PushResult = {
  sent: number;
  invalidTokens: string[];
};

export interface PushProvider {
  send(tokens: string[], message: PushMessage): Promise<PushResult>;
}
