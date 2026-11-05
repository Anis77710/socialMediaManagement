import type {
  ConfirmResult,
  InitiateResult,
  PaymentIntent,
  PaymentProvider,
} from "./types.js";

export type FakePaymentScript = {
  initiate?: InitiateResult;
  returnResult?: ConfirmResult;
  statusResult?: ConfirmResult;
};

export function createFakePaymentProvider(id: "ESEWA" | "KHALTI"): PaymentProvider & {
  setScript(script: FakePaymentScript): void;
  intents: PaymentIntent[];
} {
  let script: FakePaymentScript = {};
  const intents: PaymentIntent[] = [];

  function success(intent: PaymentIntent): ConfirmResult {
    return {
      status: "COMPLETED",
      providerRef: `fake-${intent.purchaseOrderId}`,
      providerTxnId: `fake-txn-${intent.paymentId}`,
      amountPaisa: intent.amountPaisa,
      raw: { simulated: true },
      signatureValid: true,
    };
  }

  return {
    id,
    intents,
    setScript(next) {
      script = next;
    },
    async initiate(intent) {
      intents.push(intent);

      return (
        script.initiate ?? {
          type: "REDIRECT",
          url: `https://payments.example.test/${id.toLowerCase()}?order=${intent.purchaseOrderId}`,
        }
      );
    },
    async confirmReturn(_query, intent) {
      return script.returnResult ?? success(intent);
    },
    async status(intent) {
      return script.statusResult ?? success(intent);
    },
  };
}
