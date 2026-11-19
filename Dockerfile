# syntax=docker/dockerfile:1

# ---- Stage 1: build the PlayniteReader helper (C# + LiteDB) as a self-contained Linux binary
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS reader
WORKDIR /src
COPY tools/PlayniteReader/ ./
RUN dotnet publish PlayniteReader.csproj -c Release -r linux-x64 --self-contained true \
      -p:PublishSingleFile=true -o /out

# ---- Stage 2: Python dependencies in a virtualenv
FROM python:3.12-slim AS deps
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN python -m venv /venv
COPY requirements.txt /tmp/requirements.txt
RUN /venv/bin/pip install -r /tmp/requirements.txt

# ---- Stage 3: runtime (non-root)
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    PATH=/venv/bin:$PATH \
    PLAYNITE_LIBRARY=/data/playnite \
    PLAYNITE_READER=/app/reader/PlayniteReader \
    GAME_REMOTE_HOST=0.0.0.0 \
    GAME_REMOTE_PORT=8765
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --home-dir /app --shell /usr/sbin/nologin app
WORKDIR /app
COPY --from=deps /venv /venv
COPY --from=reader /out/PlayniteReader /app/reader/PlayniteReader
COPY --chown=app:app *.py ./
COPY --chown=app:app web/ ./web/
COPY --chown=app:app config/ ./config/
COPY --chown=app:app extensions_dir/ ./extensions_dir/
RUN mkdir -p /app/cache && chown app:app /app/cache /app/config
ENV PYTHONPATH=/app/extensions_dir
USER app
EXPOSE 8765
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,os; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"GAME_REMOTE_PORT\",\"8765\")}/api/health', timeout=4)"
CMD ["python", "server.py"]
