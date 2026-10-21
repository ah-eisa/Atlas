# ATLAS — single-image build: the React SPA and the FastAPI service, one port.
#
#   docker build -t atlas .
#   docker run -p 8080:8000 -v atlas-data:/app/backend/data atlas
#
# The frontend is built first and copied into the runtime image, so the
# container serves the API and the dashboard from the same origin. That means
# no CORS configuration and no second service to coordinate.

# ---------------------------------------------------------------------------
# Stage 1 — build the frontend
# ---------------------------------------------------------------------------
FROM node:22-alpine AS frontend

WORKDIR /build

# Dependencies first, so a source-only change reuses the cached install layer.
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY frontend/ ./
# The Vite build reads the committed snapshot at the repository root and
# emits it into dist/, so the demo mode works without a backend.
COPY snapshot.json ./
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2 — runtime
# ---------------------------------------------------------------------------
FROM python:3.12-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PORTFOLIO_FRONTEND_DIST=/app/frontend/dist \
    PORTFOLIO_DB_PATH=/app/backend/data/portfolio.db \
    PORTFOLIO_CACHE_DIR=/app/backend/.cache

WORKDIR /app

COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY backend/ ./backend/
COPY --from=frontend /build/dist ./frontend/dist

# The database and the price cache live on a volume so a container restart
# does not lose positions.
RUN mkdir -p /app/backend/data /app/backend/.cache \
    && useradd --create-home --uid 10001 atlas \
    && chown -R atlas:atlas /app
USER atlas

VOLUME ["/app/backend/data", "/app/backend/.cache"]
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request,sys; \
sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/v1/health', timeout=4).status == 200 else 1)"

CMD ["python", "-m", "uvicorn", "backend.app.api:app", "--host", "0.0.0.0", "--port", "8000"]
