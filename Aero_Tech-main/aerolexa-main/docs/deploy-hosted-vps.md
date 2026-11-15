# Hosted cloud deployment — VPS runbook (Phase 1 of the GTM plan)

**Goal:** a public HTTPS URL (`https://app.yourdomain.com`) where a CA firm can
sign up, upload a file, and pay — without ever seeing the words Docker Compose.
Self-hosting remains fully supported (see `docs/deploy-postgres.md`); this
runbook is for the operator running the hosted instance that makes revenue
possible. Self-hosted Docker = $0 revenue; people who never install Docker
can't pay you.

**Time: ~45 minutes.** One VPS, one domain, one TLS certificate.

---

## 0. Prerequisites

| Thing                                      | Where to get it                                    | Cost         |
| ------------------------------------------ | -------------------------------------------------- | ------------ |
| Ubuntu 24.04 VPS, 2 vCPU / 4 GB / 40 GB    | Hetzner CX22, DigitalOcean s-2vcpu-4gb, or similar | ~$8–15/mo    |
| A domain                                   | any registrar                                      | ~$10/yr      |
| DNS A record `app.yourdomain.com` → VPS IP | your DNS provider                                  | free         |
| SMTP account (transactional email)         | Resend / Postmark / SES                            | free tier ok |
| Razorpay account (live mode)               | dashboard.razorpay.com → activate                  | KYC          |

Sizing: 4 GB comfortably serves the first ~50 active workspaces (DuckDB runs
in a worker thread; uploads are capped at `MAX_UPLOAD_BYTES`, default 100 MB).
Scale vertically to 8 GB before thinking about a second replica — see §9.

---

## 1. VPS base setup (5 min)

```bash
ssh root@YOUR_VPS_IP

# Updates + basics
apt update && apt upgrade -y
apt install -y curl git ufw

# Firewall: SSH + web only
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw yes | ufw enable

# Non-root operator user.
# The user is named `aerolexa` (lowercase) — every later `chown`, the systemd
# `User=`, and `su -` below use that same name. An uppercase `Ledgerly` here
# would not match and would leave the operator unable to read their own keys.
adduser --disabled-password --gecos "" aerolexa
mkdir -p /home/aerolexa/.ssh && cp ~/.ssh/authorized_keys /home/aerolexa/.ssh/
chown -R aerolexa:aerolexa /home/aerolexa/.ssh && chmod 700 /home/aerolexa/.ssh
chmod 600 /home/aerolexa/.ssh/authorized_keys
```

## 2. Runtime: Node 20 + PostgreSQL 16 + Caddy (10 min)

```bash
# Node 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# PostgreSQL 16
apt install -y postgresql-16
# Identifiers are deliberately lowercase: Postgres folds unquoted names to
# lowercase, so `CREATE USER Ledgerly` becomes `ledgerly` while a DATABASE_URL
# saying `/Ledgerly` fails to connect. Keep every reference lowercase.
sudo -u postgres psql -c "CREATE USER aerolexa WITH PASSWORD 'SET_A_LONG_RANDOM_PASSWORD';"
sudo -u postgres psql -c "CREATE DATABASE aerolexa OWNER aerolexa;"

# Caddy — automatic HTTPS (Let's Encrypt), zero config renewals
apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudflare.com/cloudflare-main.gpg' 2>/dev/null || true
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
```

## 3. Get the app onto the server (5 min)

The repo is **private**. An unauthenticated `git clone` returns 404 (GitHub
hides private repos behind a 404 rather than a 403, so it looks like a typo).
Authenticate first with a fine-grained PAT scoped to this one repo
(`Contents: read`) — an SSH deploy key is the better long-term option.

```bash
su - aerolexa

# GitHub → Settings → Developer settings → Personal access tokens → Fine-grained
# → scope to aerolexa4 only, permission "Contents: read". It prints once.
git clone https://<TOKEN>@github.com/vajeedaparveen21-coder/aerolexa4.git app && cd app

# Do NOT leave the token embedded in the remote URL — every later `git pull`
# would echo it into logs and shell history.
git remote set-url origin https://github.com/vajeedaparveen21-coder/aerolexa4.git
git config --global credential.helper store   # prompted once; stored in ~/.git-credentials (mode 600)

# Postgres migration set (provider switch is a repo script, not a manual edit)
npm run switch:postgres

# Install + build (build also runs the bundle-budget check)
npm ci
npm run build
```

## 4. Environment (the one file that matters) (5 min)

`/home/aerolexa/app/.env` — mode 600, never committed:

```bash
# --- Non-negotiable ---
DATABASE_URL=postgresql://aerolexa:PASSWORD@localhost:5432/aerolexa
AUTH_SECRET=$(openssl rand -hex 32)        # run the command, paste the value
NEXT_PUBLIC_APP_URL=https://app.yourdomain.com
APP_VERSION=$(git describe --tags --always)

# --- Email (a launch dependency, not an option — see deploy-postgres.md §4) ---
MAIL_TRANSPORT=smtp
SMTP_HOST=smtp.resend.com
SMTP_PORT=587
SMTP_USER=resend
SMTP_PASS=SET_YOUR_SMTP_KEY
MAIL_FROM="Ledgerly <no-reply@yourdomain.com>"

# --- Payments (live mode keys from dashboard.razorpay.com) ---
RAZORPAY_KEY_ID=rzp_live_xxxxxxxx
RAZORPAY_KEY_SECRET=xxxxxxxx
RAZORPAY_WEBHOOK_SECRET=xxxxxxxx

# --- Modules for the paid product (the hosted instance sells the toolkit) ---
LEDGERLY_PROFILE=pro
SCHEDULER_ENABLED=true
JOB_WORKER_ENABLED=true
DIGEST_ENABLED=true

# --- Storage: local disk is correct for one replica ---
LEDGERLY_STORAGE=local
DATA_DIR=/home/aerolexa/app-data

# --- Security posture ---
# TRUST_PROXY_HOPS must be the REAL number of proxies in front of Node.
# Caddy is one hop (§5), so 1. The default is 0, which trusts only the socket
# peer — behind a reverse proxy every request then shares one IP, so all
# customers collapse into a SINGLE rate-limit bucket and one abusive client
# throttles the entire userbase. Read by lib/server/rate-limit.ts.
TRUST_PROXY_HOPS=1
AUTH_COOKIE_SECURE=true

# --- Reported by /api/health ---
APP_VERSION=0.6.1            # e.g. $(git describe --tags --always); shown in health output
```

These variables are read by the code but are not listed in `.env.example`:
`TRUST_PROXY_HOPS`, `APP_VERSION`, and the three `RAZORPAY_*` keys. That gap is
why this section exists — set them here even though the example file omits them.

`mkdir -p /home/aerolexa/app-data && chown aerolexa:aerolexa /home/aerolexa/app-data`

## 5. Caddy: TLS + reverse proxy (5 min)

`/etc/caddy/Caddyfile`:

```
app.yourdomain.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3000
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "strict-origin-when-cross-origin"
    }
}
```

```bash
systemctl reload caddy
```

First request fetches and installs the Let's Encrypt certificate automatically.

## 6. systemd service (5 min)

`/etc/systemd/system/aerolexa.service`:

```ini
[Unit]
Description=Ledgerly analytics workspace
After=network.target postgresql.service
Wants=postgresql.service

[Service]
User=aerolexa
WorkingDirectory=/home/aerolexa/app
EnvironmentFile=/home/aerolexa/app/.env
ExecStartPre=/usr/bin/env npx prisma migrate deploy
ExecStart=/usr/bin/node node_modules/next/dist/bin/next start -p 3000
Restart=always
RestartSec=5
# Resource guardrails (Next.js SSR + DuckDB worker fit well under these)
MemoryMax=3g
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now aerolexa
journalctl -u aerolexa -f          # watch the boot log
```

The first boot runs `migrate deploy` against the Postgres baseline (43 tables)
before the server starts. Behind-schema restarts are impossible by design.

## 7. Verify the launch (5 min)

```bash
# 1) Readiness probe — every check true
curl -s https://app.yourdomain.com/api/health | python3 -m json.tool
#    expect: ok:true, database.ok:true, migrations.applied:true,
#            scheduler.enabled:true, jobWorker.enabled:true

# 2) Full journey by hand (or run the API suite against the live URL):
#    signup → onboarding → upload a real CSV → run an analysis → publish → pay
open https://app.yourdomain.com/signup
```

Payment sanity in Razorpay **test mode first**: put the test keys in §4, buy
Pro with the `1234 5678 9012 3456` test card, confirm the subscription row
flips `active`, then swap in live keys. Never test in live mode.

## 8. Backups + the drill (mandatory before go-live)

Nightly cron (`crontab -e -u root`):

```
15 3 * * * docker run --rm -v aerolexa_backup:/backup postgres:16 pg_dump ... || true
```

…or without Docker, plain and honest:

```
15 3 * * * sudo -u postgres pg_dump -Fc aerolexa > /var/backups/aerolexa-$(date +\%F).dump
30 3 * * * find /var/backups -name 'aerolexa-*.dump' -mtime +14 -delete
```

Then **prove it works** (the repo ships the drill):

```bash
npm run drill:backup   # disposable containers: migrate → seed 10k rows →
                       # pg_dump -Fc → pg_restore → verify counts + checksum
```

A backup that has never been restored is a hope, not a backup. The drill
exits non-zero on any mismatch. Also copy dumps off-box (`rclone` to any
object store) — a backup on the same disk as the database is not a backup.

## 9. Operations cheat-sheet

| Task                            | Command                                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Deploy a new commit             | `su - aerolexa && cd app && git pull && npm ci && npm run build && sudo systemctl restart aerolexa`       |
| Credential prompt on `git pull` | The PAT is stored via `credential.helper store` (§3). If it prompts, the token expired or was never saved |
| Watch logs                      | `journalctl -u aerolexa -f`                                                                               |
| Watch Postgres                  | `sudo -u postgres psql aerolexa -c 'SELECT 1'`                                                            |
| Status page (public)            | `/api/health` (booleans + latency only, no auth, no data)                                                 |
| Restore a dump                  | `sudo -u postgres pg_restore -d aerolexa --clean --if-exists < dump`                                      |

Vertical scale first: stop app → resize VPS to 8 GB → start. The app is a
single systemd process; no load balancer needed until ~100 active workspaces.

**Adding a second replica later** requires: `LEDGERLY_STORAGE=s3` (shared
artifact store), Postgres moved off-box, and `TRUST_PROXY_HOPS` updated to
your real proxy count. Until then, don't.

## 10. Go-live checklist

- [ ] `curl /api/health` → every check `true`
- [ ] Real email received (signup verification, password reset)
- [ ] Razorpay **test** checkout completes → subscription `active` in DB
- [ ] Razorpay webhook secret set; a test webhook is accepted (idempotent ledger row)
- [ ] `npm run drill:backup` PASS row in `docs/quality-baseline.md`
- [ ] Off-box backup copy verified (restore once from the remote copy)
- [ ] `ufw` active; only 22/80/443 open
- [ ] `AUTH_COOKIE_SECURE=true` and HTTPS padlock green
- [ ] Templates gallery renders at `/templates`; a template page renders from `/templates/gst-recon-summary`
- [ ] `/sitemap.xml` and `/robots.txt` respond (search indexing live)
- [ ] Growth funnel visible at `/growth` after your first signup
- [ ] OWASP ZAP baseline run against the live URL (`.github/workflows/zap-scan.yml`) before announcing

## 11. What NOT to do

- Don't put SQLite in production for the hosted instance — Postgres is the
  blessed path (RLS, migration contract, backup drill all assume it).
- Don't set `SQL_PROTOTYPE_FALLBACK=true` — the explicit `ENGINE_UNAVAILABLE`
  error is the honest behavior; the degraded parser is for emergencies only.
- Don't run the app as root, don't commit `.env`, don't skip the backup drill.
- Don't announce to your first 10 firms until every box above is ticked.
