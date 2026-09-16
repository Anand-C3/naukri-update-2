/**
 * Naukri Profile Refresh — toggles a trailing "." on the resume headline
 * so the profile counts as "updated" every run.
 *
 * Hourly:  Windows Task Scheduler runs:  node naukri-profile-refresh.js   (off-screen Chrome)
 * Debug:   node naukri-profile-refresh.js login                           (visible Chrome window)
 *
 * Login is automatic: if the Naukri session is gone, it signs in with the
 * Google account below. State lives in the headline itself — trailing dots
 * cycle each run: "" → "." → ".." → "" → ...
 *
 * Also re-uploads the resume PDF whenever the "Uploaded on" date shown on
 * the profile is not today's date.
 */
let chromium;
try {
  const { addExtra } = require("playwright-extra");
  chromium = addExtra(require("playwright-core").chromium);
  chromium.use(require("puppeteer-extra-plugin-stealth")());
} catch (e) {
  ({ chromium } = require("playwright-core"));
}
const path = require("path");
const fs = require("fs");
const { CREDS, naukriProfileUrl, resumePath } = require("./config");
const { nextHeadline, uploadedToday } = require("./naukri-helpers");
const {
  minimizeBrowserWindows,
  hideBrowserWindows,
  SHOW_FLAG,
} = require("./window-utils");

const PROFILE_URL = naukriProfileUrl;
const LOGIN_URL = `https://www.naukri.com/nlogin/login?URL=${PROFILE_URL}`;

const PROFILE_DIR = path.join(__dirname, ".naukri-chrome-profile");
const LOG_FILE = path.join(__dirname, "naukri-refresh.log");
const ERROR_SHOT = path.join(__dirname, "naukri-refresh-error.png");
const RESUME_PATH = resumePath; // set RESUME_FILE in .env to change which PDF is uploaded
const LOGIN_MODE = process.argv[2] === "login";
const SKIP_CV = process.env.SKIP_CV_UPLOAD === "true" || process.argv.includes("--skip-cv");
// Re-upload the CV even when the profile already shows today's date — needed when
// you swap in a different PDF, since the date check alone would skip it.
const FORCE_CV = process.argv.includes("--force-cv");
// Hidden by default so an hourly run never flashes a window; --minimize keeps it in
// the taskbar, --show leaves it on screen. `node show-windows.js refresh` brings it back.
const SHOW_WINDOW = process.argv.includes("--show");
const MINIMIZE_ONLY = process.argv.includes("--minimize");

const log = (msg) => {
  const line = `[${new Date().toLocaleString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + "\n");
};

const onProfile = (url) => url.pathname && url.pathname.startsWith("/mnjuser");

async function gotoWithRetry(page, url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      return;
    } catch (err) {
      if (i === retries - 1) throw err;
      log(`Navigation retry ${i + 1}/${retries} after error: ${err.message}`);
      await page.waitForTimeout(3000);
    }
  }
}

async function loginNaukri(ctx, page) {
  log("Session expired/unauthorized — logging in to Naukri...");
  await page.goto(LOGIN_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  const usernameInput = page
    .locator('#usernameField, input[placeholder*="Email"], input[type="text"]')
    .first();
  const passwordInput = page.locator('#passwordField, input[type="password"]').first();
  const loginBtn = page
    .locator('button[type="submit"]:has-text("Login"), button.loginButton, [class*="loginButton"]')
    .first();

  const userEmail = process.env.NAUKRI_EMAIL || CREDS.email;
  const userPassword = process.env.NAUKRI_PASSWORD || CREDS.password;

  if (userPassword && (await usernameInput.isVisible({ timeout: 5000 }).catch(() => false))) {
    log("Attempting direct email/password login...");
    await usernameInput.fill(userEmail);
    await passwordInput.fill(userPassword);
    await loginBtn.click();

    await page.waitForTimeout(5000);
    if (onProfile(new URL(page.url())) || /\/mnjuser\//.test(page.url())) {
      log("Direct login OK, session active.");
      return page;
    }
  }

  return await googleLogin(ctx, page);
}

async function googleLogin(ctx, page) {
  log("Signing in with Google...");
  if (!page.url().includes("nlogin")) {
    await page.goto(LOGIN_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
  }

  // Naukri's "Sign in with Google" is a plain div.socialbtn.google
  const googleBtn = page
    .locator('.socialbtn.google, [class*="socialbtn"][class*="google"]')
    .first();
  await googleBtn.waitFor({ timeout: 20000 });
  await googleBtn.click();

  // The Google sign-in may open a popup OR replace the current tab — find it either way
  let g = null;
  for (let i = 0; i < 30 && !g; i++) {
    await page.waitForTimeout(1000);
    g = ctx.pages().find((p) => /accounts\.google\./.test(p.url())) || null;
  }
  if (!g) throw new Error("Google sign-in page never appeared");
  await g.waitForLoadState("domcontentloaded");

  // Account already known to this Chrome profile → click it, else full email+password
  const knownAccount = g.locator(`[data-email="${CREDS.email}"]`).first();
  if (await knownAccount.isVisible().catch(() => false)) {
    await knownAccount.click();
  } else {
    const emailBox = g
      .locator(
        'input#identifierId, input[type="email"], input[name="identifier"]',
      )
      .first();
    await emailBox.waitFor({ state: "visible", timeout: 60000 });
    await emailBox.fill(CREDS.email);
    await g.locator('#identifierNext, button:has-text("Next")').first().click();
    const passBox = g
      .locator('input[type="password"], input[name="Passwd"]')
      .first();
    await passBox.waitFor({ state: "visible", timeout: 60000 });
    await passBox.fill(CREDS.password);
    await g.locator('#passwordNext, button:has-text("Next")').first().click();
  }

  // Wait until any tab lands back on the logged-in naukri profile
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    // consent screen ("Continue") sometimes follows the password step
    if (!g.isClosed()) {
      await g
        .locator('button:has-text("Continue")')
        .first()
        .click({ timeout: 500 })
        .catch(() => {});
    }
    const done = ctx.pages().find((p) => {
      try {
        return onProfile(new URL(p.url()));
      } catch {
        return false;
      }
    });
    if (done) {
      log("Google login OK, session saved.");
      return done;
    }
    if (g.isClosed() || /naukri\.com/.test(g.url())) {
      // auth finished but landed elsewhere — go to the profile directly
      await page
        .goto(PROFILE_URL, { waitUntil: "domcontentloaded", timeout: 60000 })
        .catch(() => {});
      if (onProfile(new URL(page.url()))) {
        log("Google login OK, session saved.");
        return page;
      }
    }
    await page.waitForTimeout(2000);
  }
  throw new Error(
    "Google login did not complete — likely a 2-step verification prompt. " +
      'Run "node naukri-profile-refresh.js login" and approve it once manually.',
  );
}

(async () => {
  if (process.env.NAUKRI_SESSION_B64) {
    try {
      const zlib = require("zlib");
      const raw = process.env.NAUKRI_SESSION_B64.trim().replace(/^["']|["']$/g, "").replace(/\s+/g, "");
      log(`NAUKRI_SESSION_B64 received (length: ${raw.length}). Decoding...`);
      const buf = Buffer.from(raw, "base64");
      let jsonStr = null;
      const decoders = [
        () => zlib.gunzipSync(buf).toString("utf8"),
        () => zlib.inflateSync(buf).toString("utf8"),
        () => zlib.unzipSync(buf).toString("utf8"),
        () => buf.toString("utf8"),
      ];

      for (const decodeFn of decoders) {
        try {
          const candidate = decodeFn();
          JSON.parse(candidate); // strictly validate JSON
          jsonStr = candidate;
          break;
        } catch {}
      }

      if (jsonStr) {
        fs.writeFileSync(path.join(__dirname, "storageState.json"), jsonStr, "utf8");
        log("Successfully loaded and validated storageState.json from NAUKRI_SESSION_B64.");
      } else {
        log("Error: Could not decode NAUKRI_SESSION_B64 into valid JSON.");
      }
    } catch (e) {
      log(`Warning: Failed to decode NAUKRI_SESSION_B64: ${e.message}`);
    }
  } else {
    log("Note: NAUKRI_SESSION_B64 environment variable is empty or not set.");
  }

  const isCI = !!process.env.CI || process.platform !== "win32";
  const launchOptions = {
    headless: isCI,
    viewport: { width: 1280, height: 850 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
    args: [
      "--disable-http2",
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      isCI || SHOW_WINDOW || MINIMIZE_ONLY || LOGIN_MODE
        ? "--window-position=0,0"
        : "--window-position=-32000,-32000",
    ],
  };
  if (!isCI) {
    launchOptions.channel = "chrome";
  }
  const storagePath = path.join(__dirname, "storageState.json");
  let ctx, browser;

  if (isCI) {
    browser = await chromium.launch(launchOptions);
    ctx = await browser.newContext({
      viewport: { width: 1280, height: 850 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
      storageState: fs.existsSync(storagePath) ? storagePath : undefined,
    });
  } else {
    ctx = await chromium.launchPersistentContext(PROFILE_DIR, launchOptions);
  }

  if (fs.existsSync(storagePath)) {
    try {
      const stateObj = JSON.parse(fs.readFileSync(storagePath, "utf8"));
      if (stateObj.cookies && stateObj.cookies.length) {
        await ctx.addCookies(stateObj.cookies);
      }
    } catch (e) {
      log(`Warning: Failed adding explicit cookies: ${e.message}`);
    }
  }

  let hideTimer = null;
  if (!LOGIN_MODE && !SHOW_WINDOW && !isCI) {
    const stow = MINIMIZE_ONLY ? minimizeBrowserWindows : hideBrowserWindows;
    const sweep = () => {
      if (fs.existsSync(SHOW_FLAG)) return;
      stow(PROFILE_DIR).catch(() => {});
    };
    setTimeout(sweep, 1200);
    hideTimer = setInterval(sweep, 3000);
    hideTimer.unref?.();
    ctx.once("close", () => clearInterval(hideTimer));
  }
  let page = ctx.pages()[0] || (await ctx.newPage());

  try {
    const defaultCycles = isCI ? 50 : 1;
    const CYCLES = parseInt(process.env.REFRESH_CYCLES || (process.argv.includes("--loop") ? "50" : defaultCycles), 10);
    const DELAY_MINS = parseInt(process.env.REFRESH_INTERVAL_MINUTES || "15", 10);
    const DELAY_MS = DELAY_MINS * 60 * 1000; // minutes between updates

    let consecutiveErrors = 0;

    for (let cycle = 1; cycle <= CYCLES; cycle++) {
      try {
        log(`--- Refresh Cycle ${cycle} of ${CYCLES} ---`);
        log(`Navigating to ${PROFILE_URL}...`);
        await gotoWithRetry(page, PROFILE_URL);
        await page.waitForTimeout(3000);
        log(`Current URL: ${page.url()} | Title: ${await page.title()}`);

        // Dismiss any promotional drawer / popup
        await page.locator('.crossIcon, button:has-text("Later"), [class*="close-icon"], .drawer-close').first().click({ timeout: 2000 }).catch(() => {});

        if (!onProfile(new URL(page.url()))) {
          log(`Redirected to ${page.url()} — attempting login...`);
          page = await loginNaukri(ctx, page);
          log(`Post-login URL: ${page.url()}`);
        }
        // login may land on /mnjuser/homepage — make sure we're on the profile itself
        if (!/\/mnjuser\/profile/.test(page.url())) {
          await gotoWithRetry(page, PROFILE_URL);
          await page.locator('.crossIcon, button:has-text("Later"), [class*="close-icon"], .drawer-close').first().click({ timeout: 2000 }).catch(() => {});
        }

        // Resume headline widget → pencil icon → textarea → save
        const editIcon = page.locator(
          '#lazyResumeHead span.edit.icon, [data-ga-track*="resumeHeadline"] .edit, .widgetHead .edit, .widgetHead a.edit, a:has-text("Edit headline"), [class*="resumeHead"] [class*="edit"]',
        );
        await editIcon.first().waitFor({ timeout: 30000 });
        await editIcon.first().click();

        const textarea = page.locator("#resumeHeadlineTxt");
        await textarea.waitFor({ timeout: 15000 });
        const current = (await textarea.inputValue()).trimEnd();
        const dots = current.length - current.replace(/\.+$/, "").length;
        const updated = nextHeadline(current);

        await textarea.fill(updated);
        await page
          .getByRole("button", { name: /^save$/i })
          .first()
          .click();
        await textarea.waitFor({ state: "hidden", timeout: 15000 });

        // modal closing isn't proof the save stuck — reload from the server and re-read
        await gotoWithRetry(page, PROFILE_URL);
        await editIcon.first().waitFor({ timeout: 30000 });
        await editIcon.first().click();
        await textarea.waitFor({ timeout: 15000 });
        const saved = (await textarea.inputValue()).trimEnd();
        if (saved !== updated) {
          throw new Error(
            `save did not stick — server headline is "${saved.slice(0, 60)}", expected "${updated.slice(0, 60)}"`,
          );
        }

        const dotMsg = dots >= 2 ? "dots cleared" : `dot ${dots + 1} added`;

        // ---- resume re-upload: only on the first cycle if needed ----
        let cvMsg = SKIP_CV ? "cv upload skipped (headline-only mode)" : "cv up-to-date";
        if (cycle === 1 && !SKIP_CV) {
          const pageText = async () => {
            await page
              .getByText(/Uploaded on/i)
              .first()
              .waitFor({ timeout: 30000 })
              .catch(() => {});
            return page
              .locator("body")
              .innerText({ timeout: 30000 })
              .catch(() => "");
          };
          if (FORCE_CV || !uploadedToday(await pageText())) {
            if (!fs.existsSync(RESUME_PATH)) {
              log(`Note: Account-specific resume file not found at ${RESUME_PATH} — skipping CV upload, headline refreshed.`);
            } else {
              await page
                .locator('#attachCV, input[type="file"]')
                .first()
                .setInputFiles(RESUME_PATH);
              await page.waitForTimeout(10000);
              await page.goto(PROFILE_URL, {
                waitUntil: "domcontentloaded",
                timeout: 60000,
              });
              const after = await pageText();
              const base = path.basename(RESUME_PATH);
              const stem = path.basename(RESUME_PATH, path.extname(RESUME_PATH));
              const nameRe = new RegExp(
                `${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(-\\d+)?\\${path.extname(RESUME_PATH)}`,
                "i",
              );
              const ok = FORCE_CV ? nameRe.test(after) : uploadedToday(after);
              if (!ok) {
                const shown = (/Uploaded on[^\n]*/i.exec(after) || [
                  '(no "Uploaded on" text found)',
                ])[0];
                throw new Error(
                  `cv upload did not stick — profile shows "${shown.slice(0, 80)}"`,
                );
              }
              cvMsg = `cv re-uploaded (verified: ${base})`;
            }
          }
        }

        consecutiveErrors = 0;
        log(
          `OK [Cycle ${cycle}/${CYCLES}]: headline ${dotMsg} (verified), ${cvMsg} → "${updated.slice(0, 60)}"`,
        );
      } catch (cycleErr) {
        consecutiveErrors++;
        log(`Cycle ${cycle} warning: ${cycleErr.message.split("\n")[0]}`);
        const pages = ctx.pages();
        for (let i = 0; i < pages.length; i++) {
          await pages[i]
            .screenshot({ path: ERROR_SHOT.replace(".png", `-${cycle}-${i}.png`) })
            .catch(() => {});
        }
        if (consecutiveErrors >= 5) {
          log("ERROR: 5 consecutive failures occurred, ending run.");
          process.exitCode = 1;
          break;
        }
      }

      if (cycle < CYCLES) {
        log(`Waiting ${DELAY_MINS} minutes before next refresh cycle...`);
        await page.waitForTimeout(DELAY_MS);
      }
    }
  } catch (err) {
    process.exitCode = 1;
    log(`ERROR: ${err.message.split("\n")[0]}`);
  } finally {
    await ctx.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    process.exit(process.exitCode || 0);
  }
})();
