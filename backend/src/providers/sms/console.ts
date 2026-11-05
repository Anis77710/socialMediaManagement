import { maskPhone } from "../../lib/phone.js";
import type { SmsProvider } from "./types.js";

type Log = {
  info(object: Record<string, unknown>, message: string): void;
};

export function createConsoleSmsProvider(log: Log): SmsProvider {
  return {
    async send(message) {
      log.info(
        { to: maskPhone(message.to), purpose: message.purpose, ref: message.ref },
        "SMS (console provider, text not logged)",
      );
    },
  };
}
