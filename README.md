# AI LeadGen

A multi-tenant SaaS for discovering businesses, scoring them as sales leads with evidence, and running human-approved outreach. It also runs a compliant lead marketplace.

```
web/       React 19 + TypeScript + Vite + Tailwind 4   (dashboard)
server/    Node 22 + Express + TypeScript + Mongoose    (API, job queue, compliance)
analyzer/  Python + FastAPI                             (website analysis)
deploy/    Nginx site, PM2 process file
n8n        5 workflows on n8n.dealpost.co.in            (automation)
```

## How it fits together

```
Browser ──► Nginx ──► /api ──► Express API ──► MongoDB
                                  │  ▲
                 Mongo job queue  │  │  callbacks (X-LeadGen-Key)
                                  ▼  │
                               n8n workflows ──► Google Places API
                                  │            ──► Analyzer (FastAPI)
                                  │            ──► Claude
                                  └──────────────► Gmail (only after human approval)
```

1. **Discovery.** A user starts a search. The API queues a job, and the worker calls **Workflow 1**. n8n pages through Google Places Text Search and posts the results back. The API de-duplicates by place_id, website domain, phone, and name+city. It charges 1 credit per *new* lead only.
2. **Analysis and scoring.** **Workflow 2** calls the analyzer. The analyzer respects robots.txt, reads at most 3 same-domain pages, blocks internal addresses, and returns only emails literally published on the site. Claude then scores the lead 0–100 with evidence, opportunities, and services from the seller's own list. The API re-validates the score: it drops invented services and falls back to a transparent rule-based score if the AI output is invalid.
3. **Email drafts.** **Workflow 3** has Claude write a short email from the evidence. It is stored as *pending approval*.
4. **Approval and sending.** A person edits and approves the draft in **Outreach**. **Workflow 4** asks the API for a final pre-send check: approval, suppression list, and country rules. The API renders the footer (sender identity, postal address, unsubscribe link). Gmail sends the message and the result is reported back.
5. **Marketplace.** **Workflow 5** has Claude review new listings so that no personal data leaks into public previews. It also runs a daily job that expires listings and purges Google Places content older than 30 days.

`AUTOMATION_MODE=direct` runs the same five steps inside the API process without n8n, using the same pipeline code. Use it for local development or as a fallback.

## Built-in rules (not optional)

- **No fabricated data.** Contacts come only from the Google listing, the business's own website (with the page URL stored), manual entry with a source, or recorded consent. The AI never produces contacts.
- **Human approval.** Emails can only reach Gmail through `POST /api/emails/:id/approve` by a signed-in user. API keys cannot approve. Workflow 4 re-checks approval before sending.
- **Compliance per country** (`server/src/config/compliance.ts`). It covers India (DPDP), US (CAN-SPAM), UK (PECR), Germany (UWG, so cold email is blocked), Canada (CASL), Australia, UAE, Singapore, and EU defaults. A postal address is required, a footer with unsubscribe is always added, and both one-click `List-Unsubscribe` and a confirmation page are supported. These are conservative defaults, not legal advice. Have them reviewed.
- **Suppression.** Unsubscribes are permanent per organisation. Platform admins can add global suppressions.
- **Google Places terms.** Only place_id is kept long-term. Address, rating, reviews and location are purged after `PLACES_CACHE_DAYS`. Places content is never resold on the marketplace.
- **Marketplace.** Leads must be analysed, carry a website-published or consented contact, and cannot be resold after purchase. Previews contain no contact data.

## Credits

| Action | Credits |
|---|---|
| New lead saved from a search (duplicates free) | 1 |
| Website analysis + AI score | 2 |
| AI email draft | 1 |
| Sending, exporting | 0 |

Plans live in `server/src/config/plans.ts`: Free 50, Starter 1,000, Growth 4,000, Agency 12,000 credits per month. Razorpay checkout works once keys are set. Credits are granted only by the signature-verified webhook.

## Local development

```bash
# MongoDB on 27017, then:
cd server && cp .env.example .env    # set JWT_SECRET, ENCRYPTION_KEY, AUTOMATION_MODE=direct
npm install && npm run dev            # API + worker on :4000
cd ../analyzer && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --port 8000
cd ../web && npm install && npm run dev   # http://localhost:5173 (proxies /api)
```

Tests:

```bash
cd server && npx vitest run         # 20 integration tests (needs MongoDB on 27017)
cd analyzer && .venv/bin/pip install -r requirements-dev.txt && .venv/bin/pytest -q
```

## Production deployment (Ubuntu VPS, Nginx, PM2, Certbot)

Replace `leadgen.example.com` with the subdomain you choose. Point its DNS A record to the server.

```bash
# 1. Code
sudo mkdir -p /var/www && cd /var/www && git clone <your-repo> ai-leadgen && cd ai-leadgen

# 2. MongoDB 7 (if not already installed), bound to 127.0.0.1 with auth enabled

# 3. API
cd server && npm ci && npm run build
cp .env.example .env && nano .env        # fill every value; see table below

# 4. Analyzer
cd ../analyzer && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env && nano .env        # ANALYZER_TOKEN = same as server .env

# 5. Frontend
cd ../web && npm ci && npm run build      # outputs web/dist

# 6. Processes
cd .. && pm2 start deploy/ecosystem.config.cjs && pm2 save && pm2 startup

# 7. Nginx + TLS
sudo cp deploy/nginx-leadgen.conf /etc/nginx/sites-available/leadgen   # edit domain + path
sudo ln -s /etc/nginx/sites-available/leadgen /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d leadgen.example.com

# 8. Smoke test
curl https://leadgen.example.com/api/health      # {"ok":true,"db":true,"mode":"n8n"}
```

Firewall: only 22/80/443 need to be open (`ufw allow 'Nginx Full'`). Ports 4000, 8000 and 27017 stay on localhost.

### Environment variables (server/.env)

| Variable | What it is |
|---|---|
| `MONGODB_URI` | MongoDB connection string |
| `APP_URL`, `API_URL`, `CORS_ORIGINS` | Your public domain (same domain for all three when served by one Nginx site) |
| `JWT_SECRET`, `ENCRYPTION_KEY` | Random 48+ character strings (`openssl rand -base64 48`) |
| `PLATFORM_ADMIN_EMAILS` | Emails that get the admin dashboard |
| `AUTOMATION_MODE` | `n8n` in production, `direct` without n8n |
| `N8N_BASE_URL` | `https://n8n.dealpost.co.in` |
| `N8N_WEBHOOK_SECRET` | Shared secret; must equal the n8n "LeadGen Webhook Auth" credential value |
| `ANALYZER_URL` / `ANALYZER_PUBLIC_URL` / `ANALYZER_TOKEN` | Local analyzer URL, the URL n8n uses to reach it, and its bearer token |
| `ANTHROPIC_API_KEY`, `GOOGLE_PLACES_API_KEY`, `SMTP_URL` | Needed only in direct mode |
| `RAZORPAY_*` | Optional, for online payments |

## n8n setup (n8n.dealpost.co.in)

| Workflow | Webhook path |
|---|---|
| AI LeadGen 1 - Business Lead Discovery | `/webhook/leadgen-discovery` |
| AI LeadGen 2 - Website Analysis and Lead Scoring | `/webhook/leadgen-analysis` |
| AI LeadGen 3 - Personalized Email Generation | `/webhook/leadgen-email-generate` |
| AI LeadGen 4 - Email Approval and Sending | `/webhook/leadgen-email-send` |
| AI LeadGen 5 - Lead Marketplace Processing | `/webhook/leadgen-marketplace` + daily 3am schedule |

Create these credentials in n8n and select them on the nodes that show a warning:

1. **LeadGen Webhook Auth** (Header Auth): Name `X-LeadGen-Key`, Value = `N8N_WEBHOOK_SECRET`. Used by every webhook trigger and every call back to the API.
2. **Google Places API Key** (Header Auth): Name `X-Goog-Api-Key`, Value = a Google Cloud key with *Places API (New)* enabled and restricted to that API.
3. **LeadGen Analyzer Token** (Header Auth): Name `Authorization`, Value = `Bearer <ANALYZER_TOKEN>`.
4. **Gmail (outreach sender)** (Gmail OAuth2): sign in with the mailbox that sends outreach. It should match the sender email in Settings.
5. The **Anthropic account** credential already exists and is wired into workflows 2, 3 and 5.

In Workflow 5, set **LeadGen Settings → backendUrl** to `https://<your-domain>/api/integrations/n8n`. Then publish the five workflows.

Known limitation: the n8n Gmail node cannot set custom headers, so mail sent through Workflow 4 has the unsubscribe link in the body but no `List-Unsubscribe` header. Gmail and Yahoo require that header for bulk senders (5,000+ messages per day). If you reach that volume, switch Workflow 4 to an SMTP or ESP node that supports headers, or use direct mode, which sends both.

## API

Dashboard routes use `Authorization: Bearer <jwt>`. Integrations use `X-API-Key: lg_…` on Growth and Agency plans, with scopes `leads:read`, `leads:write` and `search:write`.

```
POST /api/auth/register | /login          GET /api/auth/me
POST /api/searches  GET /api/searches[/:id]  POST /api/searches/:id/cancel
GET  /api/leads?q&status&minScore&country&city&category&hasEmail&hasWebsite&sort&page
GET  /api/leads/export (xlsx)  GET /api/leads/stats  GET|PATCH|DELETE /api/leads/:id
POST /api/leads/analyze  POST /api/leads/bulk  POST /api/leads/:id/contacts
POST /api/emails/generate  GET /api/emails  PATCH /api/emails/:id
POST /api/emails/:id/approve | /reject | /mark-replied
GET|POST /api/campaigns   GET /api/billing/plans|balance|transactions  POST /api/billing/checkout
GET  /api/marketplace/listings  POST /api/marketplace/listings/:id/purchase
GET|POST /api/marketplace/my-listings   GET /api/marketplace/eligibility/:leadId
GET|PATCH /api/org  /api/org/members  /api/org/api-keys  /api/org/suppressions
GET  /api/admin/overview|organizations|jobs|listings|audit   (platform admins)
POST /api/integrations/n8n/...   (n8n callbacks, X-LeadGen-Key)
GET|POST /u/:token (unsubscribe)   GET /t/o/:id.gif (open pixel)
```
