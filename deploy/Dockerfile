# Build from the repository root:
#   docker build -f deploy/Dockerfile -t nazir-paneli:local .
#
# Pinned by digest so the image CI scans is the image that ships. This digest
# is Python 3.12.14 on Debian bookworm. To move to a newer patch release, pull
# python:3.12-slim-bookworm and replace the digest with the one
# `docker image inspect` reports.
FROM python:3.12-slim-bookworm@sha256:782412e85d0f0984994c290652577d4018aff08145c85b262bb63dc0c7522254

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY server/requirements.txt server/requirements.txt
RUN pip install --no-cache-dir -r server/requirements.txt

COPY server/ server/
COPY web/ web/

# Runs unprivileged; the Deployer K8s pod supplies LLM_* from Vault. The
# application files stay root-owned so the runtime user cannot rewrite its own
# code — it only ever needs to read them.
RUN useradd --create-home --uid 10001 app
USER app

EXPOSE 8000

# Kubernetes uses the probes in deploy/values.yaml instead; this covers a plain
# `docker run` and any scheduler that reads container health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["python", "-c", "import urllib.request as u; u.urlopen('http://127.0.0.1:8000/api/health', timeout=3).read()"]

CMD ["uvicorn", "server.app:app", "--host", "0.0.0.0", "--port", "8000"]
