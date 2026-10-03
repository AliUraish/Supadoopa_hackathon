"""Pay-per-call with the Machine Payments Protocol (MPP), settled through Stripe.

An unpaid request gets HTTP 402 + a `WWW-Authenticate: Payment` challenge; the
agent pays (a Stripe Shared Payment Token, e.g. via `link-cli mpp pay`) and
retries with `Authorization: Payment …`. We verify by creating a PaymentIntent,
then serve the request with a `Payment-Receipt` header.

    @app.post("/v1/summarize")
    async def summarize(receipt: Receipt = Depends(paid("0.50"))): ...
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
from functools import lru_cache

import stripe
from fastapi import FastAPI, HTTPException, Request, Response
from mpp import Receipt
from mpp.errors import VerificationFailedError
from mpp.methods.stripe import ChargeIntent
from mpp.methods.stripe import stripe as stripe_method
from mpp.server import Mpp
from mpp.server._defaults import detect_realm
from starlette.responses import Response as StarletteResponse

from .config import NotConfigured, get_settings
from .store import StoreError, get_store
from .stripe_client import get_stripe

log = logging.getLogger(__name__)

# Stripe's minimum for card payments via Shared Payment Tokens.
MIN_CARD_AMOUNT = 0.50


class PaymentChallenge(Exception):
    """Carries the 402 response pympp built; install() turns it back into a response."""

    def __init__(self, response: StarletteResponse) -> None:
        self.response = response


class StripeChargeIntent(ChargeIntent):
    """pympp 0.11's charge, fixed for current Stripe API versions.

    Upstream sends `payment_method_types`, which Stripe now rejects ("no longer
    supported"), and accepts idempotent replays of an already-used credential.
    Both are fixed in pympp 0.12, which isn't on PyPI yet.
    """

    async def _create_with_client(self, client, challenge_id, request, spt, metadata):
        try:
            intent = await client.v1.payment_intents.create_async(
                {
                    "amount": int(request.amount),
                    "currency": request.currency,
                    "confirm": True,
                    "metadata": metadata,
                    "shared_payment_granted_token": spt,
                },
                {"idempotency_key": f"mpp_{challenge_id}_{spt}"},
            )
        except stripe.StripeError as error:
            raise VerificationFailedError(error.user_message or "Stripe payment failed") from error
        response = getattr(intent, "last_response", None)
        if response is not None and response.headers.get("Idempotent-Replayed") == "true":
            raise VerificationFailedError("Payment credential was already used")
        return {"id": intent.id, "status": intent.status}


@lru_cache
def get_mpp() -> Mpp:
    settings = get_settings()
    missing = [
        name
        for name, value in (
            ("STRIPE_SECRET_KEY", settings.stripe_secret_key),
            ("STRIPE_PROFILE_ID", settings.stripe_profile_id),
        )
        if not value
    ]
    if missing:
        raise NotConfigured(*missing)
    # Same derivation as Stripe's Node example, so no extra secret is required.
    secret = (
        settings.mpp_secret_key
        or base64.b64encode(
            hmac.new(
                settings.stripe_secret_key.encode(), b"mpp-challenge-signing", hashlib.sha256
            ).digest()
        ).decode()
    )
    return Mpp.create(
        method=stripe_method(
            network_id=settings.stripe_profile_id,
            # pympp 0.11 needs an explicit recipient; 0.12's stripe facade uses the network id.
            recipient=settings.stripe_profile_id,
            payment_method_types=["card"],
            currency="usd",
            decimals=2,
            intents={"charge": StripeChargeIntent(client=get_stripe())},
        ),
        realm=settings.mpp_realm or detect_realm(),
        secret_key=secret,
    )


_local_references: set[str] = set()


def _claim_locally(reference: str) -> bool:
    if reference in _local_references:
        return False
    _local_references.add(reference)
    return True


async def _claim_reference(row: dict) -> bool:
    """A credential replayed within its 5-minute window must not unlock a second call.

    Second layer behind StripeChargeIntent's Idempotent-Replayed check. It also records
    the payment. This runs after the charge succeeded, so if the database is unavailable
    we fall back to a per-process guard rather than take money and then fail.
    """
    try:
        return await get_store().claim_mpp_payment(row)
    except NotConfigured:
        log.warning("Supabase not configured: MPP replay guard is per-process only")
    except StoreError:
        log.exception("could not record MPP payment %s; using per-process guard", row["reference"])
    return _claim_locally(row["reference"])


def paid(amount: str, *, description: str | None = None):
    """Dependency that charges `amount` USD (e.g. "0.50") per request via MPP."""
    if float(amount) < MIN_CARD_AMOUNT:
        raise ValueError(f"MPP card payments must be at least {MIN_CARD_AMOUNT:.2f} USD")

    async def dependency(request: Request, response: Response) -> Receipt:
        server = get_mpp()

        async def _verified(_request, credential, receipt):
            return credential, receipt

        # Reuse pympp's own flow: route-bound challenges and RFC 9457 402 bodies.
        result = await server.pay(amount, description=description)(_verified)(request)
        if isinstance(result, StarletteResponse):
            raise PaymentChallenge(result)

        _credential, receipt = result
        claimed = await _claim_reference(
            {
                "reference": receipt.reference,
                "amount": amount,
                "currency": "usd",
                "resource": request.url.path,
            }
        )
        if not claimed:
            raise HTTPException(409, {"error": "payment_already_used"})
        response.headers["Payment-Receipt"] = receipt.to_payment_receipt()
        return receipt

    PAID_DEPENDENCIES[dependency] = {"amount": amount, "description": description}
    return dependency


# paid() dependency -> its price, so /llms.txt can list paid endpoints for agents.
PAID_DEPENDENCIES: dict = {}


def install_mpp(app: FastAPI) -> None:
    @app.exception_handler(PaymentChallenge)
    async def _payment_challenge(_request: Request, exc: PaymentChallenge) -> StarletteResponse:
        return exc.response
