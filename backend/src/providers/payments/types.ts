import type { PayProvider, PayStatus } from "../../generated/prisma/client.js";

export type PaymentIntent = {
  paymentId: string;
  purchaseOrderId: string;
  amountPaisa: number;
  taxPaisa: number;
  planName: string;
  returnUrl: string;
  successUrl: string;
  failureUrl: string;
  customer?: { name?: string; email?: string; phone?: string };
};

export type InitiateResult =
  | { type: "FORM_POST"; action: string; fields: Record<string, string> }
  | { type: "REDIRECT"; url: string }
  | { type: "BANK"; instructions: string };

export type ConfirmResult = {
  status: PayStatus;
  providerRef: string | null;
  providerTxnId: string | null;
  amountPaisa: number | null;
  raw: Record<string, unknown>;
  signatureValid?: boolean;
};

export interface PaymentProvider {
  id: Extract<PayProvider, "ESEWA" | "KHALTI">;
  initiate(intent: PaymentIntent): Promise<InitiateResult>;
  confirmReturn(query: Record<string, string>, intent: PaymentIntent): Promise<ConfirmResult>;
  status(intent: PaymentIntent & { providerRef: string }): Promise<ConfirmResult>;
}
