#!/bin/bash
echo "============================================================"
echo "  Starting SABIHA ERP..."
echo "  Package by SABIHA IT SOLUTION PVT. LTD."
echo "============================================================"
echo

if [ ! -d "node_modules" ]; then
    echo "It looks like this is the first time running SABIHA ERP."
    echo "Please run ./install.sh first, then try ./start.sh again."
    exit 1
fi

echo "Do not close this terminal while you are using SABIHA ERP."
echo "Opening your browser in a few seconds..."
echo

( sleep 3
  if command -v open &> /dev/null; then open http://localhost:3000
  elif command -v xdg-open &> /dev/null; then xdg-open http://localhost:3000
  fi
) &

npm start
