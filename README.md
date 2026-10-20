# WhatsApp Automation & AI Assistant 🤖

A self-hosted, multi-tenant WhatsApp automation platform with its own landing page, signup/login, a per-account dashboard, and an admin panel to manage every account. Powered by **Node.js**, **Google Gemini AI**, and **whatsapp-web.js**.

Every account that signs up gets its own isolated WhatsApp connection (own QR code), its own contacts/messages/CRM/chatbot rules/settings — nothing is shared between accounts except the admin's ability to manage them.

---

## ✨ Features

- 🔐 **Accounts & admin panel** — anyone can sign up; the very first account ever created becomes the admin, who can view/suspend/delete accounts and set plan limits from `/admin`.
- 🤖 **Gemini AI Replies** — Responds to WhatsApp messages naturally on your behalf using Google Gemini.
- 📱 **Your own WhatsApp login** — each account connects its own WhatsApp number by scanning a QR code in Settings.
- 📊 **Dashboard** — messages, lead analysis, a CRM pipeline, chatbot rules, contacts, and scheduled messages, all per account.
- 📅 **Scheduled Messages** — schedule broadcasts to any contact with automatic delivery.
- 🔑 **Keyword Rules** — keyword-triggered auto-replies with exact, contains, startswith, or regex matching.
- 💾 **Persistent SQLite Database** — all data is saved locally. No external database needed.
- 🔄 **Crash-Proof** — automatic restart with exponential back-off if anything goes wrong.

---

## 🛠️ Requirements

Before running, make sure you have:

- [Node.js](https://nodejs.org/) v18 or higher — **required**
- [Git](https://git-scm.com/) — to clone the repo
- A Google account with a [Gemini API key](https://aistudio.google.com/app/apikey) — for AI replies (free, optional — the app runs fine without one, AI replies just stay off until you add it)

---

## 🚀 Quick Start

### 1. Clone the repository
```bash
git clone https://github.com/vedicagrawal12/whatsapp-automation.git
cd whatsapp-automation
```

### 2. Install dependencies
```bash
npm install
```

> ⚠️ On **Linux/Mac servers**, Chrome requires extra system packages. Run:
> ```bash
> sudo apt-get install -y ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgbm1 libgcc1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 lsb-release wget xdg-utils
> ```

### 3. Configure your environment
Copy the example config file:
```bash
# Windows (Command Prompt)
copy .env.example .env

# Mac / Linux
cp .env.example .env
```

Open `.env` and, at minimum, set your Gemini API key (everything else has a safe default and can be left as-is for a normal single-server setup):
```env
PORT=3000
GEMINI_API_KEY=your_gemini_api_key_here
```

Get a free API key at: https://aistudio.google.com/app/apikey

### 4. Start the server
```bash
npm start
```

### 5. Sign up
Navigate to **http://localhost:3000** — that's the landing page. Click **Get Started Free** (or go straight to `/signup`) and create an account.

**The very first account you create becomes the admin.** It also automatically inherits any pre-existing bot data (contacts, chat history, chatbot rules, settings) if you're upgrading from an older single-account version of this app.

### 6. Connect WhatsApp
After logging in you land on `/app` — your dashboard. Go to **Settings → WhatsApp QR** and scan it with your WhatsApp mobile app:
- Open WhatsApp → tap the three dots (⋮) → **Linked Devices** → **Link a Device** → scan the QR.

Once scanned, the bot is live and will automatically reply to incoming messages using Gemini AI (if you enabled AI replies in Settings → AI Behavior).

### 7. Manage accounts (admin only)
Log in as the admin account and go to **`/admin`** (also linked from the sidebar) to see every signed-up account, suspend or delete one, and set per-account plan/message/rule limits.

---

## 📁 Project Structure

```
whatsapp-automation/
├── .env.example            # Template for your environment config
├── .gitignore               # Ignores secrets, session data, and the database
├── package.json             # Node.js dependencies & scripts
├── launcher.js               # Crash-proof server wrapper (exponential back-off)
├── server.js                 # Express HTTP server, routing, and page serving
├── fix_db.js                 # One-off utility: reset one account's AI settings (node fix_db.js you@example.com)
├── scripts/
│   ├── create-admin.js       # Create/promote an admin account without using the signup UI
│   ├── fix-admin.js          # List accounts / promote one to admin by email
│   └── reset-accounts.js     # Wipe all accounts so the next signup becomes the new admin
├── public/                   # Frontend — plain HTML/CSS/JS, no build step
│   ├── landing.html          # Marketing landing page ("/")
│   ├── login.html            # "/login"
│   ├── signup.html           # "/signup"
│   ├── admin.html            # "/admin" — admin-only account management
│   ├── index.html            # "/app" — the main dashboard (auth required)
│   ├── css/                  # style.css (dashboard) + landing.css (landing/auth/admin)
│   └── js/                   # app.js, admin.js, auth.js, landing.js, icons.js
└── src/
    ├── auth.js               # Password hashing + signed session cookies
    ├── database.js           # SQLite database (sql.js), multi-tenant schema
    ├── ai.js                 # Google Gemini AI integration
    ├── business.js            # Business profile + product catalog helpers
    ├── chatbot.js             # Message processing & rule matching
    ├── lead-analyzer.js       # AI conversation/lead scoring
    ├── scheduler.js           # Cron-based scheduled message delivery
    ├── whatsapp-client.js      # Per-account whatsapp-web.js session management
    ├── middleware/
    │   ├── auth.js             # requireAuth / requireAdmin route guards
    │   └── rateLimit.js        # In-memory login/signup rate limiting
    └── routes/
        ├── auth.js             # /api/auth/* — signup, login, logout, session
        ├── admin.js            # /api/admin/* — account management (admin only)
        └── api.js              # /api/* — everything else (per-account, login required)
```

---

## 🔒 Security Notes

- **Never share your `.env` file.** It contains your Gemini API key.
- **Never commit `.wwebjs_auth/`** — it contains WhatsApp session tokens for every connected account.
- **Never commit `data/`** — it holds the database (account credentials, all tenant data) and the auto-generated session-signing secret (`data/.session_secret`). Anyone with that secret could forge a valid login for any account, including admin.
- The `.gitignore` is pre-configured to protect all of the above automatically.
- Signup is open to anyone who can reach the server — there's no email verification or invite gate. If you're exposing this publicly rather than running it just for yourself, keep an eye on `/admin` for accounts you don't recognize.

---

## 📄 License
MIT License. Free to use and customise for personal or business projects.
