# Building the installers (Windows, macOS, Android, iOS)

Two apps use the same server:

| App | For | Platforms | Folder |
|---|---|---|---|
| **SABIHA ERP Desktop** | office users — managers, production manager, accounts | Windows `.exe`, macOS `.dmg` | `apps/desktop` |
| **SABIHA Sales** | salespeople in the field | Android `.apk`, iPhone/iPad | `apps/mobile` |

An installer for each system can only be built on that system (Apple apps need a Mac, Windows
installers a Windows PC). The easiest way is the free **GitHub Actions** workflow that builds all four
in the cloud:

1. Create a private repository on github.com and upload this whole folder (the one that contains
   `apps/`, `toybox-server/` and `.github/`).
2. *(Optional)* **Settings → Secrets and variables → Actions → Variables → New variable**:
   `SERVER_URL` = `https://erp.yourcompany.com` — the mobile app then opens with your address filled in.
3. **Actions → Build apps → Run workflow**. After ~10–15 minutes, download from the run page:
   `SABIHA-ERP-Windows-installer`, `SABIHA-ERP-macOS-dmg`, `SABIHA-Sales-Android-apk`,
   `SABIHA-Sales-iOS-unsigned-archive`.

## Building by hand
**Windows / macOS desktop** (Node.js 20+):
```
cd apps/desktop
npm install
npm run dist:win        # on Windows  → dist/SABIHA ERP Setup x.y.z.exe
npm run dist:mac        # on a Mac    → dist/SABIHA ERP-x.y.z-arm64.dmg and -x64.dmg
```
**Android** (Node 20, Android Studio or JDK 17 + Android SDK):
```
cd apps/mobile
# optional: put your server address in www/config.js
npm install
npx cap sync android
cd android && ./gradlew assembleDebug      # → app/build/outputs/apk/debug/app-debug.apk
```
For the Play Store build a signed release bundle in Android Studio (*Build → Generate Signed Bundle*).
**iPhone / iPad** (a Mac with Xcode):
```
cd apps/mobile && npm install && npx cap sync ios && npx cap open ios
```
Then in Xcode choose your Apple team under *Signing & Capabilities*, and *Product → Archive* to
install on a device, send to TestFlight or the App Store.

## What you need for each store / to avoid warnings
* **iOS** — an Apple Developer account (USD 99/year). Without it the app can only be installed on your own
  devices for 7 days at a time. *Free alternative:* open your server's web address in Safari →
  Share → **Add to Home Screen** — the office web app installs and works offline as a PWA.
* **Android** — the `.apk` can be copied to phones and installed directly (allow "unknown sources").
  A Google Play account (USD 25 once) is needed to publish on the Play Store.
* **Windows** — an unsigned installer shows a blue "Windows protected your PC" screen the first time
  (More info → Run anyway). A code-signing certificate removes it.
* **macOS** — an unsigned app is blocked at first launch: right-click the app → Open. Apple notarisation
  (needs the Apple Developer account) removes the warning.

## Before you build
* The server must be reachable over **HTTPS** (iPhones refuse plain http). See `toybox-server/HOSTING_VPS.md`.
* Release a server update first if you changed it — the apps always talk to whatever version the server runs.
* The desktop app downloads its screens from your server, so **updating the server updates every desktop
  app automatically**; you only rebuild the installer to change the app shell itself.
