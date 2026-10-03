#!/bin/bash
echo "============================================================"
echo "  SABIHA ERP - Apply Update Patch"
echo "============================================================"
echo
echo "This applies a small update WITHOUT touching your data,"
echo "your login secret, or your installed dependencies (unless"
echo "the patch specifically needs a new one)."
echo

read -p "Enter the patch zip filename (e.g. patch-3.1.0.zip): " PATCHFILE

if [ ! -f "$PATCHFILE" ]; then
    echo
    echo "[ERROR] Could not find \"$PATCHFILE\" in this folder."
    echo "Place the patch zip directly inside this toybox-server"
    echo "folder, next to start.sh, then try again."
    exit 1
fi

echo
echo "Step 1 of 3: Backing up your current app files..."
echo "  (Your data, backups, and login secret are NOT included in"
echo "   this backup because they are never touched by a patch.)"
TS=$(date +%Y%m%d-%H%M%S)
DEST="patches/backup-$TS"
mkdir -p "$DEST"
for item in *; do
    case "$item" in
        data|backups|node_modules|patches|.env|dist) continue ;;
    esac
    cp -r "$item" "$DEST/" 2>/dev/null
done
echo "  Backup saved to $DEST"

echo
echo "Step 2 of 3: Applying patch files..."
unzip -o "$PATCHFILE" -d . > /dev/null
if [ $? -ne 0 ]; then
    echo
    echo "[ERROR] Failed to extract the patch."
    echo "Your previous files are safe in $DEST. Nothing else was changed."
    exit 1
fi

echo
echo "Step 3 of 3: Checking dependencies (only downloads what changed)..."
npm install

echo
echo "============================================================"
echo "  Patch applied successfully!"
echo
echo "  - Your database and settings were NOT touched."
echo "  - A safety backup of your previous app files is saved in"
echo "    the patches folder, in case you ever need to roll back."
echo "  - Start the app as usual with ./start.sh and check the"
echo "    version number shown in the sidebar to confirm it updated."
echo "============================================================"
