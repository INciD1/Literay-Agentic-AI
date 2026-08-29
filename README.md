# Literay-Agentic-AI
# Connecting the frontend to the backend

The browser calls the local Express server at `/api/v1/chat`. Express
forwards that request to the ADK/Cloud Run backend's `/run` endpoint, so the
backend URL is not exposed in browser code and CORS is not required.

From `literay_frontend`, install dependencies and start the proxy:

```powershell
npm install
$env:BACKEND_URL = "https://YOUR_CLOUD_RUN_SERVICE_URL"
npm start
```

Open <http://localhost:3000>. The backend receives:

```json
{
  "session_id": "session_2026-08-23_04",
  "user_id": "uid_8841a2",
  "message": "Explain this lease"
}
```

The backend response should be JSON containing the answer in `message`,
`text`, `response`, `output`, `data.message`, or `data.text`.
