import type { ConfirmResult, InitiateResult, PaymentProvider } from "./types.js";

function asString(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

type KhaltiOptions = {
  mode: "sandbox" | "prod";
  secretKey: string;
  websiteUrl: string;
  timeoutMs?: number;
};

function baseUrl(mode: "sandbox" | "prod"): string {
  return mode === "sandbox" ? "https://dev.khalti.com" : "https://khalti.com";
}

function mapStatus(value: string): ConfirmResult["status"] {
  switch (value.toLowerCase()) {
    case "completed":
      return "COMPLETED";
    case "pending":
    case "initiated":
      return "PENDING";
    case "expired":
      return "EXPIRED";
    case "refunded":
      return "REFUNDED";
    case "user canceled":
    case "user cancelled":
      return "CANCELED";
    default:
      return "PENDING";
  }
}

export function createKhaltiProvider(options: KhaltiOptions): PaymentProvider {
  async function lookup(pidx: string): Promise<ConfirmResult> {
    const response = await fetch(new URL("/api/v2/epayment/lookup/", baseUrl(options.mode)), {
      method: "POST",
      headers: {
        Authorization: `key ${options.secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ pidx }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    const raw = (await response.json()) as Record<string, unknown>;
    const amount = typeof raw.total_amount === "number" ? raw.total_amount : Number(raw.total_amount);

    return {
      status: mapStatus(asString(raw.status) || "Pending"),
      providerRef: pidx,
      providerTxnId: typeof raw.transaction_id === "string" ? raw.transaction_id : null,
      amountPaisa: Number.isFinite(amount) ? amount : null,
      raw,
    };
  }

  return {
    id: "KHALTI",

    async initiate(intent): Promise<InitiateResult> {
      const response = await fetch(new URL("/api/v2/epayment/initiate/", baseUrl(options.mode)), {
        method: "POST",
        headers: {
          Authorization: `key ${options.secretKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          return_url: intent.returnUrl,
          website_url: options.websiteUrl,
          amount: intent.amountPaisa,
          purchase_order_id: intent.purchaseOrderId,
          purchase_order_name: intent.planName,
          ...(intent.customer
            ? {
                customer_info: {
                  ...(intent.customer.name ? { name: intent.customer.name } : {}),
                  ...(intent.customer.email ? { email: intent.customer.email } : {}),
                  ...(intent.customer.phone ? { phone: intent.customer.phone } : {}),
                },
              }
            : {}),
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
      const raw = (await response.json()) as Record<string, unknown>;

      if (!response.ok || typeof raw.payment_url !== "string") {
        throw new Error(`Khalti initiate failed: ${JSON.stringify(raw)}`);
      }

      return { type: "REDIRECT", url: raw.payment_url };
    },

    async confirmReturn(query, intent): Promise<ConfirmResult> {
      const pidx = query.pidx;

      if (!pidx) {
        return {
          status: "FAILED",
          providerRef: null,
          providerTxnId: null,
          amountPaisa: null,
          raw: query,
        };
      }

      const result = await lookup(pidx);

      if (
        result.amountPaisa !== null &&
        result.amountPaisa !== intent.amountPaisa
      ) {
        return { ...result, status: "AMBIGUOUS" };
      }

      return result;
    },

    async status(intent): Promise<ConfirmResult> {
      return lookup(intent.providerRef);
    },
  };
}
