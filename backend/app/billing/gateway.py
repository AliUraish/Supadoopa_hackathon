"""MPP charging for other services, e.g. the Doorway MCP gateway (Node).

The gateway hosts the paid URL and runs the tool; this backend only checks payment,
so Stripe keys and the tested MPP code live in one place. Per agent request:

    POST /mpp/charge  {amount, resource, authorization: <agent's Authorization header>}
    402 → relay status, WWW-Authenticate and body to the agent verbatim (it pays, retries)
    200 → run the tool, return its result with `Payment-Receipt: <receipt>`
"""

from __future__ import annotations

import hmac

from fastapi import APIRouter, Header, HTTPException
from mpp import Challenge
from mpp.errors import PaymentError
from mpp.server.decorator import make_challenge_response
from pydantic import BaseModel, Field, field_validator

from .config import NotConfigured, get_settings
from .mpp import MIN_CARD_AMOUNT, _claim_reference, get_mpp

router = APIRouter(tags=["mpp"])


class ChargeIn(BaseModel):
    amount: str = "0.50"  # USD
    # What is being paid for, e.g. "clinic/book_appointment". Bound into the challenge,
    # so a credential paid for one resource can't be spent on another.
    resource: str = Field(min_length=1, max_length=200)
    description: str | None = Field(None, max_length=500)
    authorization: str | None = None  # the agent's Authorization header, verbatim

    @field_validator("amount")
    @classmethod
    def _at_least_card_minimum(cls, value: str) -> str:
        if float(value) < MIN_CARD_AMOUNT:
            raise ValueError(f"must be at least {MIN_CARD_AMOUNT:.2f} (Stripe card minimum)")
        return value


@router.post("/mpp/charge", include_in_schema=False)
async def charge(body: ChargeIn, x_gateway_key: str | None = Header(None)):
    secret = get_settings().mpp_gateway_secret
    if not secret:
        raise NotConfigured("MPP_GATEWAY_SECRET")
    if not hmac.compare_digest(x_gateway_key or "", secret):
        raise HTTPException(401, "Invalid gateway key")

    server = get_mpp()
    try:
        result = await server.charge(
            authorization=body.authorization,
            amount=body.amount,
            description=body.description,
            extra={"resource": body.resource},
        )
    except PaymentError as error:
        if isinstance(error.retry_challenge, Challenge):
            return make_challenge_response(error.retry_challenge, server.realm, error)
        raise HTTPException(502, {"error": "payment_outcome_unknown"}) from error
    if isinstance(result, Challenge):
        return make_challenge_response(result, server.realm)

    credential, receipt = result
    if not await _claim_reference(
        {
            "reference": receipt.reference,
            "amount": body.amount,
            "currency": "usd",
            "resource": body.resource,
        }
    ):
        raise HTTPException(409, {"error": "payment_already_used"})
    return {
        "status": "paid",
        "reference": receipt.reference,
        "receipt": receipt.to_payment_receipt(),
        "payer": credential.source,
    }
