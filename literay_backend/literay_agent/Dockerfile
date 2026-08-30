FROM python:3.11-slim

WORKDIR /app

# Only the packages upload_server.py actually needs — keep this separate
# from the ADK agent's requirements.txt (which pulls in google-adk itself,
# unnecessary for this service and slower to build).
RUN pip install --no-cache-dir \
    fastapi \
    "uvicorn[standard]" \
    python-multipart \
    google-cloud-storage \
    google-cloud-firestore \
    google-cloud-discoveryengine

COPY upload_server.py .
COPY ingest_document.py .
COPY delete_document.py .

CMD ["python", "upload_server.py"]