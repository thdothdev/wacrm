import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyEvolutionWebhookSignature, verifyMetaWebhookSignature, verifyUazapiWebhookSignature } from "./webhook-signature";

const SECRET = process.env.META_APP_SECRET!;

function signedHeader(body: string, secret: string = SECRET): string {
  const hex = crypto.createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${hex}`;
}

describe("verifyMetaWebhookSignature", () => {
  it("accepts a request signed with the correct secret", () => {
    const body = JSON.stringify({ object: "whatsapp_business_account" });
    expect(verifyMetaWebhookSignature(body, signedHeader(body))).toBe(true);
  });

  it("rejects a signature computed with a different secret", () => {
    const body = "{}";
    expect(verifyMetaWebhookSignature(body, signedHeader(body, "wrong"))).toBe(
      false,
    );
  });

  it("rejects when the body has been tampered with after signing", () => {
    const original = '{"entry":[]}';
    const header = signedHeader(original);
    const tampered = '{"entry":[{"id":"injected"}]}';
    expect(verifyMetaWebhookSignature(tampered, header)).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifyMetaWebhookSignature("anything", null)).toBe(false);
  });

  it("rejects a header without the sha256= prefix", () => {
    const body = "{}";
    const hex = crypto
      .createHmac("sha256", SECRET)
      .update(body)
      .digest("hex");
    expect(verifyMetaWebhookSignature(body, hex)).toBe(false);
    expect(verifyMetaWebhookSignature(body, `sha512=${hex}`)).toBe(false);
  });

  it("rejects a header of the wrong length without throwing", () => {
    // timingSafeEqual would throw on length mismatch — the guard inside
    // the verifier should catch this and return false instead.
    expect(verifyMetaWebhookSignature("{}", "sha256=tooshort")).toBe(false);
  });

  describe("fail-closed when secret is missing", () => {
    const originalSecret = process.env.META_APP_SECRET;
    beforeEach(() => {
      delete process.env.META_APP_SECRET;
    });
    afterEach(() => {
      process.env.META_APP_SECRET = originalSecret;
    });

    it("rejects even a correctly-formed signature when no secret is configured", () => {
      const body = "{}";
      // Use the original secret to produce the header so we can verify
      // the rejection is solely due to missing config.
      const header = signedHeader(body, originalSecret!);
      expect(verifyMetaWebhookSignature(body, header)).toBe(false);
    });
  });
});

describe("verifyUazapiWebhookSignature", () => {
  const originalToken = process.env.UAZAPI_WEBHOOK_TOKEN;

  beforeEach(() => {
    process.env.UAZAPI_WEBHOOK_TOKEN = "secret-url-token";
  });

  afterEach(() => {
    process.env.UAZAPI_WEBHOOK_TOKEN = originalToken;
  });

  it("accepts the UAZAPI token from the webhook URL", () => {
    expect(verifyUazapiWebhookSignature(null, "secret-url-token")).toBe(true);
  });

  it("keeps accepting bearer tokens for API-created webhooks", () => {
    expect(verifyUazapiWebhookSignature("Bearer secret-url-token")).toBe(true);
  });

  it("rejects a wrong UAZAPI token", () => {
    expect(verifyUazapiWebhookSignature(null, "wrong")).toBe(false);
  });
});

describe("verifyEvolutionWebhookSignature", () => {
  it("accepts only the per-instance webhook token", () => {
    expect(verifyEvolutionWebhookSignature("instance-secret", "instance-secret")).toBe(true);
    expect(verifyEvolutionWebhookSignature("wrong", "instance-secret")).toBe(false);
    expect(verifyEvolutionWebhookSignature(null, "instance-secret")).toBe(false);
  });
});