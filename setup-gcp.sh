#!/bin/bash
# ===========================================
# WhatsApp Scheduler — Setup script for GCP VM
# Run this ONCE on a fresh e2-micro VM (Debian/Ubuntu)
# ===========================================

set -e

echo "=========================================="
echo "  WhatsApp Scheduler — GCP Setup"
echo "=========================================="

# 1. Update system
echo "[1/5] Updating system..."
sudo apt-get update -y
sudo apt-get upgrade -y

# 2. Install Docker
echo "[2/5] Installing Docker..."
sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update -y
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker $USER

# 3. Clone repo
echo "[3/5] Cloning repository..."
cd ~
if [ -d "WhatsApp-Scheduler" ]; then
  cd WhatsApp-Scheduler && git pull
else
  git clone https://github.com/kevintrousselier/WhatsApp-Scheduler.git
  cd WhatsApp-Scheduler
fi

# 4. Create data directories
echo "[4/5] Creating data directories..."
mkdir -p data/uploads data/whatsapp-sessions

# 5. Build and run
echo "[5/5] Building and starting container..."
sudo docker compose up -d --build

echo ""
echo "=========================================="
echo "  DONE! WhatsApp Scheduler is running."
echo "=========================================="
echo ""
echo "  Access: http://$(curl -s ifconfig.me):3000"
echo ""
echo "  Useful commands:"
echo "    sudo docker compose logs -f    # View logs"
echo "    sudo docker compose restart    # Restart"
echo "    sudo docker compose down       # Stop"
echo "    sudo docker compose up -d      # Start"
echo ""
