ARG BASE_IMAGE=python:3.12-slim
FROM ${BASE_IMAGE}

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    GRAPHITI_TELEMETRY_ENABLED=false

WORKDIR /app

COPY pyproject.toml ./
COPY fuli_graph ./fuli_graph
RUN pip install --no-cache-dir .

EXPOSE 8787

CMD ["uvicorn", "fuli_graph.app:app", "--host", "0.0.0.0", "--port", "8787"]
