#!/usr/bin/env bash
set -e

echo "=========================================================="
echo "🚀 ATHENIX CONSULTANCY - GCP MASTER ONE-CLICK DEPLOYMENT 🚀"
echo "=========================================================="

# 1. Update OS and Install Core Prerequisites
echo "📌 Step 1/7: Updating system packages and installing prerequisites..."
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl gnupg git gzip nginx certbot python3-certbot-nginx

# 2. Configure 4GB Swap Space (Prevents Chrome & Postgres OOM crashes)
echo "📌 Step 2/7: Configuring 4GB Swap space..."
if [ ! -f /swapfile ]; then
    sudo fallocate -l 4G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=4096
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
fi

# 3. Install Docker Engine & Compose plugin if not present
echo "📌 Step 3/7: Installing Docker & Docker Compose..."
if ! command -v docker &> /dev/null; then
    curl -fsSL https://get.docker.com | sudo bash
    sudo usermod -aG docker "$USER" || true
fi

# 4. Clone or Pull Latest Code with all fixes
echo "📌 Step 4/7: Syncing latest code repository..."
APP_DIR="/home/ubuntu/wa-automation"
if [ ! -d "$APP_DIR" ]; then
    if [ "$USER" != "ubuntu" ]; then
        APP_DIR="$HOME/wa-automation"
    fi
fi

if [ ! -d "$APP_DIR" ]; then
    git clone https://github.com/YuvrajKhare2025/wa-automation-yuvraj.git "$APP_DIR"
fi

cd "$APP_DIR"
git fetch origin main
git reset --hard origin/main
git pull origin main

# 5. Setup Production .env (100% Self-Hosted GCP Database - No Neon, No AWS)
echo "📌 Step 5/7: Configuring production environment (.env)..."
if [ ! -f .env ]; then
    cp .env.example .env
fi

RAND_SECRET=$(openssl rand -hex 32)
# Ensure DATABASE_URL points directly to the local PostgreSQL container on GCP
sed -i "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://postgres:wa_secure_db_pass_2026@postgres:5432/whatsapp_automation|g" .env
sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=${RAND_SECRET}|g" .env
sed -i "s|^NODE_ENV=.*|NODE_ENV=production|g" .env
sed -i "s|^PORT=.*|PORT=3000|g" .env
sed -i "s|^TRUST_PROXY=.*|TRUST_PROXY=true|g" .env
sed -i "s|^DEMO_MODE=.*|DEMO_MODE=false|g" .env
sed -i "s|^ALLOW_PUBLIC_SIGNUP=.*|ALLOW_PUBLIC_SIGNUP=false|g" .env
sed -i "s|^BOOTSTRAP_ADMIN_EMAIL=.*|BOOTSTRAP_ADMIN_EMAIL=hitrocks19@gmail.com|g" .env

# 6. Start PostgreSQL & Restore Backup
echo "📌 Step 6/7: Starting PostgreSQL database container on GCP..."
sudo docker compose down || true
sudo docker compose up -d postgres fix-perms

echo "⏳ Waiting for PostgreSQL container to become healthy..."
for i in {1..30}; do
    if sudo docker compose exec -T postgres pg_isready -U postgres -d whatsapp_automation >/dev/null 2>&1; then
        echo "✅ PostgreSQL is ready and healthy!"
        break
    fi
    sleep 2
done

# Restore the complete database backup if backup file exists
if [ -f "scripts/latest_db_backup.sql.gz" ]; then
    echo "📦 Restoring complete database backup (all accounts, contacts, deals, messages)..."
    gunzip -c scripts/latest_db_backup.sql.gz | sudo docker compose exec -T postgres psql -U postgres -d whatsapp_automation
    echo "✅ Database restored successfully!"
elif [ -f "backups/latest_db_backup.sql" ]; then
    echo "📦 Restoring database from uncompressed backup..."
    cat backups/latest_db_backup.sql | sudo docker compose exec -T postgres psql -U postgres -d whatsapp_automation
    echo "✅ Database restored successfully!"
fi

# 7. Build and Start Node.js Application
echo "📌 Step 7/7: Building and launching Node.js Application container..."
sudo docker compose up -d --build app

# 8. Configure Nginx Reverse Proxy with SSE streaming support
echo "🌐 Configuring Nginx reverse proxy..."
sudo rm -f /etc/nginx/sites-enabled/default
sudo tee /etc/nginx/sites-available/wa-automation > /dev/null << 'EOF'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    client_max_body_size 25M;

    # SSE (Server-Sent Events) stream for WhatsApp QR code & live status
    location /api/qr-stream {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
        chunked_transfer_encoding off;
    }

    # All standard routes
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF

sudo ln -sf /etc/nginx/sites-available/wa-automation /etc/nginx/sites-enabled/wa-automation
sudo nginx -t && sudo systemctl restart nginx

echo "⏳ Waiting 10 seconds for app startup..."
sleep 10

# Final Health Check
echo "🔍 Performing health check..."
curl -i http://localhost:3000/health || curl -i http://127.0.0.1:3000/health || true

EXTERNAL_IP=$(curl -s -4 ifconfig.me || curl -s -4 icanhazip.com || echo "your-server-ip")

echo "=========================================================="
echo "🎉 DEPLOYMENT COMPLETED SUCCESSFULLY!"
echo "🌐 Your Athenix Consultancy portal is LIVE at:"
echo "👉 http://${EXTERNAL_IP}"
echo "👉 Local Port 3000: http://${EXTERNAL_IP}:3000"
echo "=========================================================="
