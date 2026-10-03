# InvoiceLite

Simple invoicing and receipt generation for freelancers and small businesses.
Create invoices with multiple line items, automatic discount/tax math, multiple
currencies, professional PDF output, receipts for paid invoices, and public
shareable links.

Built as a deliberately small, single-developer MVP: one codebase, server
rendering, SQLite storage, zero native dependencies.

## Stack

| Layer      | Choice                                                    |
|------------|-----------------------------------------------------------|
| Backend    | Node.js (≥ 22.5) + Express (server-rendered)              |
| Database   | SQLite via the built-in `node:sqlite` module              |
| Views      | EJS templates + vanilla JS + one CSS file (responsive)    |
| PDF        | pdfkit (pure JS, no headless browser needed)              |
| Auth       | Session cookie (opaque token, DB-backed) + bcrypt hashes  |

No build step, no bundler, no native modules — `npm install` and `npm start`.

## Quick start

On Windows, the easy way: **double-click `Start InvoiceLite.bat`** in this
folder. It starts the server (minimized console window — closing that window
stops the app), opens your browser at http://localhost:4173, and if the app
is already running it just opens it.

From a terminal instead:

```bash
npm install
cp .env.example .env        # optional but recommended
npm start                   # http://localhost:3000
```

Run the tests:

```bash
npm test
```

The suite covers the money math (minor-unit parsing, discount/tax rounding),
invoice numbering, status transitions, PDF content, and a full HTTP end-to-end
flow: register → business setup → customer → invoice → PDF → share → mark
paid → receipt → dashboard totals.

## Configuration (environment variables)

| Variable         | Default            | Purpose                                                    |
|------------------|--------------------|------------------------------------------------------------|
| `PORT`           | `3000`             | HTTP port                                                  |
| `BASE_URL`       | `http://localhost:$PORT` | Public origin used to build share links — set this in production |
| `DB_PATH`        | `./data/invoicelite.db` | SQLite database file (created automatically)          |
| `UPLOAD_DIR`     | `./uploads`        | Business logo storage                                      |
| `SESSION_SECRET` | random (dev)       | **Required in production** — sessions are DB-backed tokens; generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `NODE_ENV`       | `development`      | `production` enables secure cookies + strict config checks |

## Database schema

All money is stored as **integer minor units** (cents), consistent with each
currency's decimal digits (JPY: 0, USD: 2, BHD: 3). No floats are ever stored.

```
users        id, email (unique), password_hash, name, created_at
sessions     token (PK), user_id → users, csrf_token, flash, expires_at
businesses   id, user_id (unique → users), name, email, phone, address,
             tax_id, logo_path, default_currency, invoice_prefix,
             invoice_seq (numbering counter), default_tax_rate,
             payment_details, created_at
customers    id, user_id → users, name, email, phone, address, notes, created_at
invoices     id, user_id → users, customer_id → customers, number (unique per user),
             status ('draft'|'sent'|'paid'), issue_date, due_date, currency,
             discount_type ('none'|'fixed'|'percent'), discount_value_minor,
             discount_percent, tax_rate,
             subtotal_minor, discount_minor, tax_minor, total_minor,
             notes, share_token (unique), paid_at, created_at, updated_at
invoice_items id, invoice_id → invoices (cascade), position, description,
             quantity, unit_price_minor, amount_minor
```

Design notes:

- **Statuses:** `Overdue` is derived, not stored — any `sent` invoice past its
  due date displays (and filters) as overdue. No cron job needed.
- **Numbering:** `invoice_prefix + zero-padded invoice_seq` (e.g. `INV-0001`),
  allocated inside the same transaction that inserts the invoice, so numbers
  are gap-free per business even under concurrent creates. Numbers are
  assigned at creation time (including drafts) and never change.
- **Paid invoices are immutable** — they cannot be edited or deleted, since
  receipts have been issued for them. You can undo the payment instead.

## Feature map

- Registration/login (bcrypt, httpOnly cookies, CSRF protection on all forms)
- Business profile: identity, tax ID, default currency, numbering prefix,
  default tax rate, payment instructions, logo upload (PNG/JPG/WEBP ≤ 2 MB)
- Customer CRUD (deletion blocked while invoices reference the customer)
- Invoices: multiple line items, per-invoice currency, percentage or fixed
  discount, tax rate, notes; live totals in the form, authoritative totals
  computed server-side in integer minor units
- Status flow: draft → sent → paid (with undo), overdue derived from due date
- PDF invoices (A4, logo, multi-page safe) and PDF receipts for paid invoices
- Public share links (`/share/<token>`) with read-only page + PDF + receipt,
  revocable via "Reset link"
- Dashboard: total invoiced / paid / outstanding / overdue per currency,
  recent invoices
- Mobile-responsive UI

## Project layout

```
server.js            entry point (listening + daily session pruning)
src/
  app.js             express app factory (no listen — tests reuse it)
  config.js          env-var handling
  db.js              sqlite schema + transaction helper
  money.js           minor-unit parsing, formatting, totals math
  validators.js      form validation helpers
  auth.js            sessions, CSRF, auth guards
  invoice-service.js numbering, create/update/status logic
  pdf.js             invoice + receipt PDF rendering (pdfkit)
  routes/            auth-routes, business, customers, invoices, dashboard, public
views/               EJS templates
public/              styles.css, js/app.js, js/invoice-form.js
test/                node:test unit + e2e suites
data/, uploads/      created at runtime (gitignored)
```

## Deployment

### The 30-second version

InvoiceLite is a single Node process writing to a local SQLite file. To deploy
you need: (1) a machine/VPS with Node ≥ 22.5, (2) persistent disk for
`data/` and `uploads/`, (3) HTTPS in front.

```bash
git clone <your-repo> && cd invoicelite
npm install --omit=dev
NODE_ENV=production \
PORT=3000 \
BASE_URL=https://invoices.example.com \
SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
node server.js
```

Put a reverse proxy (Caddy, nginx) or a load balancer in front for TLS, and
restart it under a supervisor (`systemd`, `pm2`). Example systemd unit:

```ini
[Service]
WorkingDirectory=/srv/invoicelite
ExecStart=/usr/bin/node server.js
Environment=NODE_ENV=production
EnvironmentFile=/srv/invoicelite/.env
Restart=always
User=invoice
[Install]
WantedBy=multi-user.target
```

### Docker

```bash
docker build -t invoicelite .
docker run -d -p 3000:3000 \
  -v invoicelite_data:/app/data \
  -v invoicelite_uploads:/app/uploads \
  -e NODE_ENV=production \
  -e BASE_URL=https://invoices.example.com \
  -e SESSION_SECRET=change-me \
  invoicelite
```

### PaaS (Render / Railway / Fly.io)

The app works on any platform that offers **persistent disk**, which SQLite
needs. Generic recipe:

1. Deploy with the included `Dockerfile`.
2. Attach a persistent volume mounted at `/app/data` (and `/app/uploads`, or
   point both `DB_PATH` and `UPLOAD_DIR` at the same volume).
3. Set `NODE_ENV=production`, `BASE_URL=https://<your-domain>`, and a strong
   random `SESSION_SECRET`.
4. Add a health check on `/healthz`.

Backups are then just file copies — e.g. `sqlite3 data/invoicelite.db
".backup '/backups/il-$(date +%F).db'"` in a nightly cron. If you later
outgrow single-box SQLite, the SQL is plain and portable to Postgres via
`better-sqlite3` → `pg` swap in `src/db.js`.

## Scope limits (intentional)

No email sending, no payment processing, no recurring invoices, no multi-user
teams, no partial payments, no exchange-rate conversion (dashboard aggregates
per currency rather than converting). See the README "next steps" in the
delivery notes for the highest-value extensions.
