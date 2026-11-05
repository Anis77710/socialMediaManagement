import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  ConfirmResult,
  InitiateResult,
  PaymentIntent,
  PaymentProvider,
} from "./types.js";

type EsewaOptions = {
  mode: "rc" | "prod";
  productCode: string;
  secretKey: string;
  timeoutMs?: number;
};

function asString(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function baseUrl(mode: "rc" | "prod"): string {
  return mode === "rc"
    ? "https://rc-epay.esewa.com.np"
    : "https://epay.esewa.com.np";
}

function sign(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("base64");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);

  return a.length === b.length && timingSafeEqual(a, b);
}

function rupees(paisa: number): string {
  return (paisa / 100).toFixed(2);
}

function mapStatus(value: string): ConfirmResult["status"] {
  switch (value.toUpperCase()) {
    case "COMPLETE":
      return "COMPLETED";
    case "PENDING":
      return "PENDING";
    case "AMBIGUOUS":
      return "AMBIGUOUS";
    case "CANCELED":
    case "CANCELLED":
      return "CANCELED";
    case "FULL_REFUND":
      return "REFUNDED";
    case "PARTIAL_REFUND":
      return "PARTIALLY_REFUNDED";
    case "NOT_FOUND":
      return "EXPIRED";
    default:
      return "PENDING";
  }
}

export function createEsewaProvider(options: EsewaOptions): PaymentProvider {
  async function lookup(intent: PaymentIntent, transactionUuid: string): Promise<ConfirmResult> {
    const total = rupees(intent.amountPaisa);
    const url = new URL("/api/epay/transaction/status/", baseUrl(options.mode));
    url.searchParams.set("product_code", options.productCode);
    url.searchParams.set("total_amount", total);
    url.searchParams.set("transaction_uuid", transactionUuid);

    const response = await fetch(url, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    const raw = (await response.json()) as Record<string, unknown>;
    const status = asString(raw.status) || "PENDING";
    const amount = typeof raw.total_amount === "number" ? raw.total_amount : Number(raw.total_amount);
    const ref = typeof raw.transaction_code === "string" ? raw.transaction_code : null;

    return {
      status: mapStatus(status),
      providerRef: transactionUuid,
      providerTxnId: ref,
      amountPaisa: Number.isFinite(amount) ? Math.round(amount * 100) : null,
      raw,
    };
  }

  return {
    id: "ESEWA",

    async initiate(intent): Promise<InitiateResult> {
      const total = rupees(intent.amountPaisa);
      const signedFields = "total_amount,transaction_uuid,product_code";
      const signature = sign(
        options.secretKey,
        `total_amount=${total},transaction_uuid=${intent.purchaseOrderId},product_code=${options.productCode}`,
      );

      return {
        type: "FORM_POST",
        action: new URL("/api/epay/main/v2/form", baseUrl(options.mode)).toString(),
        fields: {
          amount: total,
          tax_amount: "0",
          total_amount: total,
          transaction_uuid: intent.purchaseOrderId,
          product_code: options.productCode,
          product_service_charge: "0",
          product_delivery_charge: "0",
          success_url: intent.successUrl,
          failure_url: intent.failureUrl,
          signed_field_names: signedFields,
          signature,
        },
      };
    },

    async confirmReturn(query, intent): Promise<ConfirmResult> {
      const data = query.data;

      if (!data) {
        return {
          status: "FAILED",
          providerRef: null,
          providerTxnId: null,
          amountPaisa: null,
          raw: query,
          signatureValid: false,
        };
      }

      let decoded: Record<string, unknown>;

      try {
        decoded = JSON.parse(Buffer.from(data, "base64").toString("utf8")) as Record<
          string,
          unknown
        >;
      } catch {
        return {
          status: "FAILED",
          providerRef: null,
          providerTxnId: null,
          amountPaisa: null,
          raw: { data },
          signatureValid: false,
        };
      }

      const fields = asString(decoded.signed_field_names).split(",").filter(Boolean);
      const message = fields
        .map((field) => `${field}=${asString(decoded[field])}`)
        .join(",");
      const expected = sign(options.secretKey, message);
      const valid = safeEqual(expected, asString(decoded.signature));
      const transactionUuid = asString(decoded.transaction_uuid);

      if (!valid || transactionUuid !== intent.purchaseOrderId) {
        return {
          status: "AMBIGUOUS",
          providerRef: transactionUuid || null,
          providerTxnId: null,
          amountPaisa: null,
          raw: decoded,
          signatureValid: false,
        };
      }

      const result = await lookup(intent, transactionUuid);

      return { ...result, raw: { callback: decoded, status: result.raw }, signatureValid: true };
    },

    async status(intent): Promise<ConfirmResult> {
      return lookup(intent, intent.providerRef);
    },
  };
}

