# Deploying WA Automation

Two stages, same app both times — the Docker image built in Stage 2 is the
exact same code you're demoing locally in Stage 1, so moving from "showing
investors" to "actually live" is copy-paste, not a rebuild.

---

## Stage 1 — Right now: free demo from your own machine

Use this for a live investor call or a link you share for a day or two.
Nothing is installed on a server; your own PC *is* the server for as long as
these scripts are running.

- **`start-demo.ps1`** — uses Cloudflare's Quick Tunnel. No account needed,
  no warning page for visitors. Recommended default.
- **`start-demo-ngrok.ps1`** — uses ngrok instead, if you'd rather use that.
  Needs a free ngrok account + authtoken (one-time, ~2 min), and shows
  first-time visitors a one-click "continue" warning page ngrok's free tier
  adds — mention that to whoever's watching so it doesn't look broken.

Either way: double-click the script, wait for the two windows to open, copy
the public `https://...` link out of the second window, share that link (not
`localhost`). Close both windows when you're done — the link dies with them.

Sign up as the admin account yourself *before* the call (first signup ever
becomes admin) so you're not doing that live on screen.

---

## Stage 2 — Going live for real customers: one small VPS

**Recommended: Hetzner Cloud, CX22 plan** (2 vCPU / 4 GB RAM / 40 GB disk,
~€4/month — verified against Hetzner's current pricing, not a stale quote).
That RAM headroom matters here specifically because every connected
WhatsApp account runs its own real headless Chromium process in the
background — this app is heavier per-tenant than a typical Node API, and
anything with less RAM starts OOM-killing Chromium the moment a handful of
real accounts connect.

### Why this over the free options (Render Free / Oracle Cloud Free)

Both were seriously considered and both have a real, disqualifying problem
for something real customers depend on:

- **Render's Free tier** — confirmed by directly deploying this app there:
  512MB RAM is enough to OOM-kill the *entire server process* (not just the
  WhatsApp session) the moment Chromium launches, wiping the database with
  it since Free has no persistent disk. Recoverable for a demo you can
  reload; not something to put a paying customer's WhatsApp connection on.
- **Oracle Cloud's Always Free tier** — genuinely tempting on paper (2 OCPU
  / 12 GB RAM, $0/month, more RAM than the paid option below). The
  disqualifier isn't capacity, it's reliability: Oracle has a long,
  continuing, well-documented pattern of Always Free accounts and instances
  being suspended or terminated without warning — not a rare edge case,
  a recurring complaint across Oracle's own community forums for years.
  Losing the server a customer's business runs on, overnight, with no
  notice, isn't a risk worth trading for the extra RAM.

Hetzner CX22 costs about the same as a coffee a month, has none of the
above failure modes, and is what the rest of this guide is built for.

### Steps

You do the account creation and payment yourself (that part isn't something
I can do for you) — from there, here's the whole path:

1. **Rent the VPS**, pick Ubuntu as the OS image.
2. **Point your domain's DNS** A record at the server's IP (any registrar;
   even a $10-15/year domain reads far more credible to customers than a
   `trycloudflare.com`/`ngrok-free.app`/`onrender.com` link).
3. **Install Docker** on the server (Docker's own official install script:
   `curl -fsSL https://get.docker.com | sh`).
4. **Copy this whole project folder** to the server (`git clone` your repo,
   or `scp`/upload it directly).
5. **Create `.env`** on the server from `.env.example` — set your real
   `GEMINI_API_KEY`, and set `TRUST_PROXY=true` (Caddy is the proxy now).
6. **Edit `Caddyfile`** — replace `yourdomain.com` with your real domain.
7. **Start it:**
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
   ```
   Caddy automatically gets you a free, auto-renewing HTTPS certificate for
   your domain — nothing else to configure. The Dockerfile installs a real
   Chromium from Debian's own apt mirror rather than letting puppeteer
   download its own during the build — smaller image, faster build, and one
   less thing that can fail depending on the server's outbound network
   policy.
8. **Set up nightly backups** — `scripts/backup-db.sh` copies the database
   and the session-signing secret out of the container's data volume. Wire
   it to cron (see the comment at the top of that file for the exact line).

From then on, shipping an update is: pull your new code, run the same
`docker compose ... up -d --build` command again. Nobody's session or
WhatsApp connection is lost — the database, session secret, and every
tenant's WhatsApp login live in named Docker volumes that survive rebuilds.

### A note on what I could and couldn't verify

I've confirmed the Dockerfile's Chromium setup end-to-end by actually
deploying this app (on Render, as a live test) and watching it successfully
launch a WhatsApp session and produce a scannable QR code in the logs — so
the Chromium/puppeteer piece is proven working, not just theoretical. What I
haven't been able to test from here is the Hetzner VPS path specifically
(this sandbox can't run a Docker daemon or rent a server) — the steps above
are the same Dockerfile and docker-compose files already proven to work,
just pointed at a different host. Do one clean `docker compose up -d --build`
on the actual VPS before pointing your domain at it, and send me the output
if anything doesn't come up cleanly — I can debug from the logs.
