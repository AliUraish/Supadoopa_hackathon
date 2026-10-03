// Per-call payments through the billing backend (backend/), which speaks Stripe's Machine
// Payments Protocol. Doorway holds no Stripe keys: it forwards the agent's Authorization
// header to POST /mpp/charge and relays a 402 challenge back verbatim.
// Reads (GET tools) stay free; actions cost DOORWAY_PRICE (the $0.50 card minimum).

const PRICE = process.env.DOORWAY_PRICE ?? "0.50";

export const paymentsEnabled =
  process.env.DOORWAY_PAYMENTS === "mpp" && Boolean(process.env.BILLING_API_URL && process.env.MPP_GATEWAY_SECRET);

export const isPaid = (spec) => paymentsEnabled && spec.request.method !== "GET";
export const price = PRICE;

export async function charge(siteId, toolName, authorization) {
  const base = process.env.BILLING_API_URL.replace(/\/+$/, "");
  return fetch(`${base}/mpp/charge`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-gateway-key": process.env.MPP_GATEWAY_SECRET },
    body: JSON.stringify({
      amount: PRICE,
      resource: `${siteId}/${toolName}`, // the challenge is bound to this, so a payment can't run another tool
      description: `Doorway: ${siteId}.${toolName}`,
      authorization: authorization ?? null,
    }),
    signal: AbortSignal.timeout(20000),
  });
}

// What a paid MCP tool returns instead of running: Stripe's MCP pattern, since JSON-RPC
// can't carry an HTTP 402.
export function paymentInstructions(publicUrl, siteId, spec, args) {
  return {
    payment_required: true,
    price: `${PRICE} USD per call`,
    paymentLink: `${publicUrl}/run/${siteId}/${spec.name}`,
    method: "POST",
    body: { arguments: args },
    instructions:
      `This action costs $${PRICE}. POST the body to paymentLink. If it answers HTTP 402, pay the challenge with Stripe Link ` +
      `(for example: link-cli mpp pay <paymentLink> --test), which retries with your payment credential and returns the tool's result.`,
  };
}
