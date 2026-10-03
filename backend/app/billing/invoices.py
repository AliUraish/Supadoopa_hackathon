"""Send a one-off invoice that the customer pays on a Stripe-hosted page.

await send_invoice(email="client@example.com", lines=[InvoiceLine("Consulting", 50000)])
"""

from __future__ import annotations

from dataclasses import dataclass

from .stripe_client import get_stripe


@dataclass(frozen=True)
class InvoiceLine:
    description: str
    amount: int  # smallest currency unit
    currency: str = "usd"


async def send_invoice(
    *,
    lines: list[InvoiceLine],
    email: str | None = None,
    customer_id: str | None = None,
    days_until_due: int = 7,
    memo: str | None = None,
) -> dict:
    if not lines:
        raise ValueError("an invoice needs at least one line")
    if not (email or customer_id):
        raise ValueError("pass email or customer_id")
    stripe = get_stripe().v1

    if customer_id is None:
        found = await stripe.customers.list_async({"email": email, "limit": 1})
        customer_id = (
            found.data[0].id
            if found.data
            else (await stripe.customers.create_async({"email": email})).id
        )

    params: dict = {
        "customer": customer_id,
        "collection_method": "send_invoice",
        "days_until_due": days_until_due,
        "currency": lines[0].currency,
    }
    if memo:
        params["description"] = memo
    invoice = await stripe.invoices.create_async(params)
    for line in lines:
        await stripe.invoice_items.create_async(
            {
                "customer": customer_id,
                "invoice": invoice.id,
                "amount": line.amount,
                "currency": line.currency,
                "description": line.description,
            }
        )
    invoice = await stripe.invoices.finalize_invoice_async(invoice.id)
    invoice = await stripe.invoices.send_invoice_async(invoice.id)
    return {
        "id": invoice.id,
        "status": invoice.status,
        "amount_due": invoice.amount_due,
        "hosted_invoice_url": invoice.hosted_invoice_url,
    }
