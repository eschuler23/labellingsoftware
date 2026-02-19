FROM node:20-alpine AS web-build
WORKDIR /app/web

COPY web/package*.json ./
RUN npm ci

COPY web/ ./
RUN npm run build

FROM python:3.12-slim AS app
WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

RUN pip install --no-cache-dir \
    fastapi \
    uvicorn \
    watchdog \
    Pillow \
    python-multipart

COPY server/ /app/server/
COPY pyproject.toml /app/pyproject.toml
COPY Readme.md /app/Readme.md
COPY --from=web-build /app/web/dist /app/web/dist

RUN mkdir -p /app/data /app/uploads

EXPOSE 8000
VOLUME ["/app/data", "/app/uploads"]

CMD ["uvicorn", "server.app:app", "--host", "0.0.0.0", "--port", "8000"]
