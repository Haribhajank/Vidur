import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-bookmentor-signature";
export const TIMESTAMP_HEADER = "x-bookmentor-timestamp";
const MAX_SKEW_SECONDS = 300;

/** HMAC-SHA256 over `${timestamp}.${body}`; identical scheme is implemented in backend_ml/main.py. */
export function signPayload(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function buildSignedHeaders(secret: string, body: string): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    "content-type": "application/json",
    [TIMESTAMP_HEADER]: String(timestamp),
    [SIGNATURE_HEADER]: signPayload(secret, timestamp, body),
  };
}

export function verifySignature(
  secret: string,
  body: string,
  timestampHeader: string | null,
  signatureHeader: string | null,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  if (timestampHeader === null || signatureHeader === null) return false;
  if (!/^\d{1,12}$/.test(timestampHeader) || !/^[0-9a-f]{64}$/.test(signatureHeader)) return false;
  const timestamp = Number(timestampHeader);
  if (Math.abs(nowSeconds - timestamp) > MAX_SKEW_SECONDS) return false;
  const expected = Buffer.from(signPayload(secret, timestamp, body), "hex");
  const provided = Buffer.from(signatureHeader, "hex");
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

export function safeEqualStrings(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
