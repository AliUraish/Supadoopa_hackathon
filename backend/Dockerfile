# Doorway sandbox workers on Supabase Compute (runtime = "dockerfile", exposure = private).
# Each instance runs N sandboxes that claim discover/verify/heal/optimize/race jobs from the
# shared queue in Supabase. Compute injects SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
FROM mcr.microsoft.com/playwright/python:v1.63.0-noble

COPY --from=ghcr.io/astral-sh/uv:0.11.7 /uv /bin/uv

ENV PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/srv/.venv \
    DOORWAY_EXPLORER=heuristic

WORKDIR /srv
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --python /usr/bin/python3

COPY app ./app

# Sandboxes per instance; Chromium comes from the base image (PLAYWRIGHT_BROWSERS_PATH).
CMD ["sh", "-c", "exec /srv/.venv/bin/python -m app.doorway.sandbox --count ${DOORWAY_SANDBOXES:-2}"]
