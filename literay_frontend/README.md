# Literay Frontend

Node/Express web app: Google sign-in, chat UI, document upload, quiz panel,
and progress tracking. Talks to the two backend services (ADK agent +
upload service) over plain HTTP.

## Requires

- The **ADK agent** running (locally via `adk web`/`adk api_server`, or
  deployed) — see `literay_backend/README.md`
- The **upload service** running — same README, step 4/8
- A **Google OAuth 2.0 Web Client ID** (Console → APIs & Services →
  Credentials → Create Credentials → OAuth client ID → Web application).
  Add every origin you'll open this app from — `http://localhost:3000` for
  local dev, and the Cloud Run URL once deployed — under **Authorized
  JavaScript origins**.

## 1. Install

```bash
cd literay_frontend
npm install
```

## 2. Configure environment

Create `.env` in this folder:

```
BACKEND_URL=http://localhost:8000
UPLOAD_SERVICE_URL=http://localhost:8001
GOOGLE_CLIENT_ID=<your-oauth-client-id>.apps.googleusercontent.com
SESSION_SECRET=<a long random string — see below>
AGENT_APP_NAME=literay_agent
NODE_ENV=development
```

Generate `SESSION_SECRET`:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Never use the placeholder default — sessions are signed with this key.

## 3. Run

```bash
npm start
```
Opens on `http://localhost:3000`.

## Data storage

All persistent data lives in **Firestore** (no local files, no in-memory
store — required for Cloud Run, where each instance has its own ephemeral
filesystem and multiple instances don't share state):

| Collection | What |
|---|---|
| `documents` | Shared with the backend — written by the upload service during ingest, read here to list a user's documents |
| `frontend_users` | Cached Google profile per user |
| `frontend_sessions` | Saved chat conversations |
| `frontend_quiz_results` | Answered quiz questions, used to compute the Progress view |

## Deploy to Cloud Run

```bash
gcloud run deploy literay-frontend --source . --project=<PROJECT_ID> --region=<REGION> \
  --allow-unauthenticated \
  --set-env-vars="BACKEND_URL=<AGENT_SERVICE_URL>,UPLOAD_SERVICE_URL=<UPLOAD_SERVICE_URL>,GOOGLE_CLIENT_ID=<...>,SESSION_SECRET=<...>,NODE_ENV=production,AGENT_APP_NAME=literay_agent"
```

**Quote the whole `--set-env-vars` value.** Unquoted, some shells (notably
PowerShell) can silently lose the commas between vars and merge everything
into a single value — check afterward with:
```bash
gcloud run services describe literay-frontend --project=<PROJECT_ID> --region=<REGION> \
  --format="value(spec.template.spec.containers[0].env)"
```
You should see 6 separate entries, not one long merged string.

**After deploying:**
1. Add the new Cloud Run URL to the OAuth client's Authorized JavaScript origins (Console → Credentials).
2. Update the agent's CORS to allow this URL:
   ```bash
   adk deploy cloud_run --project=<PROJECT_ID> --region=<REGION> --allow_origins=<THIS_FRONTEND_URL> literay_agent
   ```

## Known gotchas already solved (don't re-debug these)

- Cloud Run requires listening on `$PORT` — already handled (`const port = Number(process.env.PORT) || 3000`).
- `.env` files never ship to the deployed container and are never committed — see `.gitignore`.
- `app.set('trust proxy', 1)` is required for secure cookies to work correctly behind Cloud Run's HTTPS proxy.
