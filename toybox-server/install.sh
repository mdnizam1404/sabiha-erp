#!/bin/bash
echo "============================================================"
echo "  SABIHA ERP - Multi-Company First Time Setup"
echo "  Package by SABIHA IT SOLUTION PVT. LTD."
echo "============================================================"
echo

if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js was not found on this computer."
    echo
    echo "Please install Node.js first:"
    echo "  1. Go to https://nodejs.org"
    echo "  2. Download the 'LTS' version for your operating system"
    echo "  3. Run the installer"
    echo "  4. Run this install.sh file again"
    echo
    exit 1
fi

echo "Node.js found: $(node -v)"
echo
echo "Installing SABIHA ERP dependencies - this may take a few minutes..."
echo "(This step needs an internet connection. It only has to run once.)"
echo

npm install

if [ $? -ne 0 ]; then
    echo
    echo "[ERROR] Installation failed. Please check the messages above."
    exit 1
fi

echo
echo "============================================================"
echo "  Installation complete!"
echo "  Run ./start.sh any time to launch SABIHA ERP."
echo "============================================================"
