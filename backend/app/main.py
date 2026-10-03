from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import billing
from app.billing import Receipt, User
from app.billing.config import get_settings
from app.doorway.api import install as doorway_install

app = FastAPI(title="Supabase Hackathon API", version="0.1.0")

_settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=sorted(
        {
            "http://localhost:3000",
            "https://supabase-hackathon-phi.vercel.app",
            _settings.public_app_url,
            *(
                o.strip().rstrip("/")
                for o in (_settings.cors_origins or "").split(",")
                if o.strip()
            ),
        }
    ),
    # Vercel preview deployments of the frontend project.
    allow_origin_regex=(
        r"https://supabase-hackathon-[a-z0-9-]+-aliuraishmirani-4593s-projects\.vercel\.app"
        r"|http://(localhost|127\.0\.0\.1):\d+"  # any local dev port
    ),
    allow_methods=["*"],
    allow_headers=["Authorization", "Content-Type"],
    expose_headers=["Payment-Receipt", "WWW-Authenticate"],
)

billing.install(app)
doorway_install(app)


@app.get("/health")
async def health() -> dict:
    return {"ok": True, "billing": billing.status()}


# --- Examples: copy these patterns into real features --------------------------------


@app.get("/examples/pro", tags=["examples"])
async def pro_only(user: User = Depends(billing.require_plan("pro"))) -> dict:
    return {"message": f"Hi {user.email or user.id}, you're on Pro."}


@app.post("/examples/paid-call", tags=["examples"])
async def paid_call(
    receipt: Receipt = Depends(billing.paid("0.50", description="Example call")),
) -> dict:
    return {"result": "paid content", "payment": receipt.reference}


@app.get("/examples/credits", tags=["examples"])
async def credits_only(user: User = Depends(billing.require_purchase("credits_100"))) -> dict:
    return {"message": "Thanks for buying credits."}
