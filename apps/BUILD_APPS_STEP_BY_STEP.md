# Building the installers — step by step for beginners

You do **not** need to be a programmer. There are two ways: **Way 1 (easiest, builds all four in the cloud)** and
**Way 2 (build on your own computer)**.

------------------------------------------------------------------
## WAY 1 — GitHub builds everything for you (recommended)
You need: a free GitHub account (https://github.com). No software to install.
1. Sign in to GitHub → top right **+** → **New repository** → name it `sabiha-erp` → choose **Private** → **Create**.
2. Unzip the package on your computer. Open the unzipped `wa` folder. On the new repository page click
   **uploading an existing file** and drag **everything inside `wa`** (the folders `apps`, `toybox-server`, `.github`
   and the files) into the page → **Commit changes**.
   *(If the `.github` folder is hidden, turn on "Show hidden files" first. It must be uploaded — it holds the build recipe.)*
3. *(Recommended)* **Settings → Secrets and variables → Actions → Variables → New repository variable**:
   Name `SERVER_URL`, value `https://erp.yourcompany.com` (your live server). The mobile app then opens with the address filled in.
4. Click the **Actions** tab → **Build apps** → **Run workflow** → **Run workflow**. Wait 10–20 minutes.
5. Open the finished run (green tick). Under **Artifacts** download:
   * `SABIHA-ERP-Windows-installer` → contains **SABIHA ERP Setup x.y.z.exe**
   * `SABIHA-ERP-macOS-dmg` → contains the **.dmg** (Mac app)
   * `SABIHA-Sales-Android-apk` → contains **app-debug.apk**
   * `SABIHA-Sales-iOS-unsigned-archive` → iPhone build (needs signing, see "iPhone" below)

------------------------------------------------------------------
## WAY 2 — On your own computer

### Windows desktop app → `.exe` (on a Windows PC)
1. Install **Node.js 20 LTS** from https://nodejs.org.
2. Unzip the package. Open the folder `wa\apps\desktop`.
3. Click the folder's address bar, type `cmd`, press Enter. A black window opens in that folder.
4. Type these, pressing Enter after each (the second takes a few minutes):
   ```
   npm install
   npm run dist:win
   ```
5. When it finishes, open the new folder **`dist`**. The installer is **`SABIHA ERP Setup 5.5.0.exe`**. Double-click it to
   install; copy it to other office PCs the same way.
6. First time Windows shows "Windows protected your PC": click **More info → Run anyway** (normal for unsigned apps;
   a code-signing certificate removes it).
7. Start **SABIHA ERP** → type your server address (e.g. `https://erp.yourcompany.com`) → **Connect** → sign in.

### Mac desktop app → `.dmg` / `.app` (on a Mac)
1. Install Node.js 20 LTS. Open **Terminal** (Spotlight → "Terminal").
2. `cd` to the folder: type `cd ` (with a space), drag the folder `wa/apps/desktop` into the Terminal window, press Enter.
3. Run: `npm install` then `npm run dist:mac`.
4. In **`dist`** you get `SABIHA ERP-5.5.0-arm64.dmg` (Apple-chip Macs) and `…-x64.dmg` (Intel Macs). Open the .dmg and
   drag **SABIHA ERP.app** into **Applications**.
5. First launch: right-click the app → **Open** → **Open** (needed because it is not notarised by Apple).

### Android app → `.apk` (Windows, Mac or Linux)
1. Install **Node.js 20 LTS**, then **Android Studio** from https://developer.android.com/studio (it brings Java and the Android tools).
2. Open `wa/apps/mobile/www/config.js` in Notepad and set `defaultServer: 'https://erp.yourcompany.com'`. Save.
3. In a terminal inside `wa/apps/mobile` run: `npm install` then `npx cap sync android`.
4. Run `npx cap open android` — Android Studio opens the project. Wait until the bottom bar finishes "Gradle sync".
5. Menu **Build → Build Bundle(s) / APK(s) → Build APK(s)**. When done click **locate**: the file is
   `app-debug.apk`. Copy it to any phone (WhatsApp, USB, Drive) and tap it; allow **install unknown apps** when asked.
6. For the **Play Store** use **Build → Generate Signed Bundle / APK** (it guides you to create a keystore — keep that file safe forever).

### iPhone / iPad app (needs a Mac and an Apple Developer account, USD 99/year)
*(The iPhone file is an **.ipa** that contains the **.app**. Apple only allows building it with Xcode on a Mac.)*
1. On the Mac install **Node.js 20 LTS** and **Xcode** (free, App Store).
2. Set the server address in `wa/apps/mobile/www/config.js` as in the Android steps.
3. In Terminal inside `wa/apps/mobile`: `npm install` then `npx cap sync ios` then `npx cap open ios`.
4. In Xcode click the blue **App** project → **Signing & Capabilities** → choose your **Team** (your Apple ID) and keep
   "Automatically manage signing".
5. Plug in the iPhone, choose it at the top, press ▶ **Run** to install on that phone. To distribute: **Product →
   Archive → Distribute App** → *TestFlight* (testing) or *App Store*.
6. **No Apple account? Free alternative:** on the iPhone open your server address in **Safari → Share → Add to Home Screen**.
   The office web app installs like an app and works offline.

------------------------------------------------------------------
## After installing
* **First sign-in needs internet**; after that both apps work offline and sync automatically when the network returns.
* The desktop app updates its screens from your server automatically — you only rebuild the installer to change the app shell.
* Problems? The status badge (bottom-left on desktop, top-right on mobile) shows what is waiting to sync.
