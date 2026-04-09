#!/bin/bash
cd "$(dirname "$0")"

echo "================================================"
echo "  WhatsApp Scheduler - Femina Adventure"
echo "================================================"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "[ERREUR] Node.js n'est pas installe."
    echo "Telechargez-le sur https://nodejs.org"
    read -p "Appuyez sur Entree pour fermer..."
    exit 1
fi

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "Installation des dependances..."
    npm install
    echo ""
fi

# Copy .env if missing
if [ ! -f ".env" ] && [ -f ".env.example" ]; then
    cp .env.example .env
    echo "Fichier .env cree depuis .env.example"
fi

echo "Demarrage du serveur..."
echo "L'interface s'ouvrira dans votre navigateur."
echo ""

# Open browser after delay
(sleep 3 && open http://localhost:3000) &

# Start server
node src/server.js
