import type { Env } from "../../config/env.js";
import { createEsewaProvider } from "./esewa.js";
import { createFakePaymentProvider } from "./fake.js";
import { createKhaltiProvider } from "./khalti.js";
import type { PaymentProvider } from "./types.js";

export type PaymentProviders = {
  esewa: PaymentProvider;
  khalti: PaymentProvider;
  bankTransfer: true;
};

export function createPaymentProvidersFromEnv(env: Env): PaymentProviders {
  if (env.PAYMENT_DRIVER === "live" && env.ESEWA_SECRET_KEY && env.KHALTI_SECRET_KEY) {
    return {
      esewa: createEsewaProvider({
        mode: env.ESEWA_MODE,
        productCode: env.ESEWA_PRODUCT_CODE,
        secretKey: env.ESEWA_SECRET_KEY,
      }),
      khalti: createKhaltiProvider({
        mode: env.KHALTI_MODE,
        secretKey: env.KHALTI_SECRET_KEY,
        websiteUrl: env.KHALTI_WEBSITE_URL,
      }),
      bankTransfer: true,
    };
  }

  return {
    esewa: createFakePaymentProvider("ESEWA"),
    khalti: createFakePaymentProvider("KHALTI"),
    bankTransfer: true,
  };
}

export type {
  PaymentProvider,
  PaymentIntent,
  InitiateResult,
  ConfirmResult,
} from "./types.js";
export { createFakePaymentProvider } from "./fake.js";
