import fs from "node:fs";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import patchright from "patchright";

import { loadConfig } from "./config.js";
import {
  blacklistProxy,
  getNextWorkingProxy,
  getProxyByDescription,
  markProxyFree,
  recordProxyFailure,
} from "./proxy-manager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const config = loadConfig();

const contexts = new Map();

export const timeout = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const randomDelay = (minSeconds, maxSeconds) => {
  if (config.skipNavigationDelays) {
    return Promise.resolve();
  }

  const delayMs =
    Math.floor(Math.random() * (maxSeconds - minSeconds + 1) + minSeconds) *
    1000;
  return timeout(delayMs);
};

export function watchPageUnavailable(page) {
  return createPageUnavailableWatcher(page).promise;
}

export function createPageUnavailableWatcher(page) {
  const cleanupFns = [];
  let isSettled = false;
  let isDisposed = false;
  let resolvePromise = () => {};

  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });

  const cleanup = () => {
    while (cleanupFns.length > 0) {
      cleanupFns.pop()();
    }
  };

  const finish = (result) => {
    if (isSettled || isDisposed) {
      return;
    }

    isSettled = true;
    cleanup();
    resolvePromise(result);
  };

  const addOnce = (eventTarget, eventName, result) => {
    const listener = () => finish(result);
    eventTarget.once(eventName, listener);
    cleanupFns.push(() => {
      if (typeof eventTarget.off === "function") {
        eventTarget.off(eventName, listener);
      } else if (typeof eventTarget.removeListener === "function") {
        eventTarget.removeListener(eventName, listener);
      }
    });
  };

  try {
    addOnce(page.context(), "close", { type: "context-close" });
    addOnce(page, "close", { type: "page-close" });
    addOnce(page, "crash", { type: "page-crash" });

    if (page.isClosed()) {
      finish({ type: "page-close" });
    }
  } catch (error) {
    finish({
      type: "page-watch-error",
      error: error?.message || String(error),
    });
  }

  return {
    promise,
    dispose() {
      if (isSettled || isDisposed) {
        return;
      }

      isDisposed = true;
      cleanup();
    },
  };
}

export async function initBrowser(
  contextName,
  {
    exitOnClose = false,
    ignoreHTTPSErrors = false,
    withProxy = false,
    debugMode = false,
    configureForScraping = false,
    proxyUrl = null,
    proxyContext = "default",
    userDataDir = null,
    quiet = false,
  } = {},
) {
  const actualContextName = contextName || `browser-${Date.now()}`;

  if (contexts.has(actualContextName)) {
    throw new Error(`Context "${actualContextName}" already exists`);
  }

  const launchOptions = {
    // userAgent:
    //   "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0",
    ignoreHTTPSErrors,
    headless: config.headless,
    acceptDownloads: true,
    javaScriptEnabled: true,
    ignoreDefaultArgs: ["--enable-automation", "--auto-open-devtools-for-tabs"],
    args: [
      `--load-extension=${config.extensionPath}`,
      `--disable-extensions-except=${config.extensionPath}`,
      "--start-maximized",
      "--disable-features=GlobalShortcutsPortal",
      "--lang=el-GR",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-session-crashed-bubble",
      "--disable-infobars",
    ],
    targetFilter: (target) => Boolean(target.url()),
    viewport: null,
    devtools: false,
  };

  let selectedProxy = null;
  if (!debugMode && withProxy) {
    if (config.spawnBrowserWithProxy) {
      selectedProxy = getProxyByDescription(config.spawnBrowserWithProxy);
      if (!selectedProxy && !quiet) {
        console.warn(
          `[browser] configured proxy "${config.spawnBrowserWithProxy}" not found; falling back to automatic selection`,
        );
      }
    }

    selectedProxy = selectedProxy || proxyUrl || getNextWorkingProxy();
    if (selectedProxy) {
      const proxyServer =
        typeof selectedProxy === "string"
          ? selectedProxy
          : `socks5://127.0.0.1:${selectedProxy.port}`;
      launchOptions.proxy = { server: proxyServer };
      if (!quiet) {
        console.log(
          `[browser] ${actualContextName}: using proxy ${proxyServer}`,
        );
      }
    }
  }

  const dataDirName = userDataDir || actualContextName;
  const browserDataPath = path.join(config.browserDataRoot, dataDirName);
  const configMarkerPath = path.join(browserDataPath, ".configured");

  if (!fs.existsSync(path.join(config.extensionPath, "manifest.json"))) {
    throw new Error(
      `uBlock Origin Lite extension missing at ${config.extensionPath}; run npm run install:ublock-lite`,
    );
  }

  await cleanupBrowserResources(browserDataPath, quiet);
  await fsPromises.mkdir(browserDataPath, { recursive: true });

  let context;
  try {
    context = await patchright.chromium.launchPersistentContext(
      browserDataPath,
      launchOptions,
    );
  } catch (error) {
    releaseTrackedProxy({ proxy: getTrackedProxy(selectedProxy) });
    throw error;
  }
  contexts.set(actualContextName, {
    context,
    proxy: getTrackedProxy(selectedProxy),
    proxyContext,
  });

  if (exitOnClose) {
    detectClosedContext(context).catch(() => {});
  }

  const page = context.pages()[0] || (await context.newPage());
  const connectivityResult = await checkConnectivityWithRetry(
    page,
    actualContextName,
    true,
    3,
  );

  if (!connectivityResult.success) {
    markBrowserProxyFailure(actualContextName, {
      severity: "critical",
      proxyContext,
    });
    await safeCloseContext(actualContextName, context);
    const error = new Error(
      `No internet connectivity - ${
        connectivityResult.error || "all connectivity checks failed"
      }`,
    );
    error.code = "NO_CONNECTIVITY";
    error.details = connectivityResult;
    throw error;
  }

  if (configureForScraping && !fs.existsSync(configMarkerPath)) {
    await fsPromises
      .writeFile(configMarkerPath, new Date().toISOString())
      .catch(() => {});
    await configureBrowserForScraping(page, true);
  }

  return page;
}

export async function closeBrowser(contextName, skipBrowserClose = false) {
  const entry = contexts.get(contextName);
  if (!entry) {
    return;
  }

  const context = entry.context || entry;

  if (skipBrowserClose) {
    releaseTrackedProxy(entry);
    contexts.delete(contextName);
    return;
  }

  try {
    for (const page of context.pages()) {
      try {
        if (!page.isClosed()) {
          await Promise.race([
            page.close(),
            timeout(2_000).then(() => {
              throw new Error("page close timeout");
            }),
          ]);
        }
      } catch {
        // ignore page close failures
      }
    }

    await Promise.race([
      context.close(),
      timeout(5_000).then(() => {
        throw new Error("context close timeout");
      }),
    ]);
  } catch {
    // ignore close failures
  } finally {
    releaseTrackedProxy(entry);
    contexts.delete(contextName);
  }
}

export function markBrowserProxyFailure(
  contextName,
  { severity = "high", blacklistMs = null, proxyContext = null } = {},
) {
  const entry = contexts.get(contextName);
  const proxy = entry?.proxy;
  if (!proxy?.port) {
    return false;
  }

  recordProxyFailure(proxy.port, severity);
  blacklistProxy(
    proxy.port,
    blacklistMs,
    proxyContext || entry.proxyContext || "default",
  );
  return true;
}

export async function closeAllBrowsers() {
  await Promise.allSettled(
    Array.from(contexts.keys()).map((contextName) => closeBrowser(contextName)),
  );
}

export async function cleanupAllBrowserData() {
  if (!fs.existsSync(config.browserDataRoot)) {
    return;
  }

  const entries = await fsPromises.readdir(config.browserDataRoot, {
    withFileTypes: true,
  });

  await Promise.allSettled(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        fsPromises.rm(path.join(config.browserDataRoot, entry.name), {
          recursive: true,
          force: true,
        }),
      ),
  );
}

export async function configureBrowserForScraping(page, quiet = false) {
  try {
    await page.goto(
      "chrome-extension://ddkjiahejlhfcafbddmgiahcphecmpfh/dashboard.html",
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForSelector('span[data-i18n="filteringMode3Name"]');
    await page.click('span[data-i18n="filteringMode3Name"]');
    await page.click('button[data-pane="rulesets"]');
    await page.waitForSelector("input#findInLists");
    await page.click('div[data-nodeid="regions"] > .detailbar');
    await page.waitForTimeout(500);
    await page.click('div[data-rulesetid="grc-0"] img[title="gr"]');
    await page.waitForTimeout(2_000);

    await page.goto("chrome://settings/content/images", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(1_000);

    await page.evaluate(() => {
      const legacyOption = document
        .querySelector("body > settings-ui")
        ?.shadowRoot?.querySelector("#main")
        ?.shadowRoot?.querySelector("#privacy > settings-privacy-page-index")
        ?.shadowRoot?.querySelector("#old")
        ?.shadowRoot?.querySelector(
          "#basicPage > settings-section > settings-privacy-page",
        )
        ?.shadowRoot?.querySelector(
          "#pages > settings-subpage > settings-category-default-radio-group",
        )
        ?.shadowRoot?.querySelector("#disabledRadioOption");

      if (legacyOption) {
        legacyOption.click();
        return;
      }

      const disabledOption = document
        .querySelector("body > settings-ui")
        ?.shadowRoot?.querySelector("settings-main")
        ?.shadowRoot?.querySelector("settings-privacy-page-index")
        ?.shadowRoot?.querySelector("settings-images-page")
        ?.shadowRoot?.querySelector("settings-category-default-radio-group")
        ?.shadowRoot?.querySelector("settings-radio-group")
        ?.querySelector("#disabledRadioOption");

      const clickable = disabledOption?.shadowRoot?.querySelector(
        '[role="radio"], [aria-checked], input[type="radio"]',
      );

      clickable?.click();
    });
  } catch (error) {
    if (!quiet) {
      console.warn(`[browser] scraping configuration failed: ${error.message}`);
    }
  }
}

export async function checkInternetConnectivity(
  page,
  contextName,
  quiet = false,
) {
  const checks = [
    { name: "icanhazip", url: "https://icanhazip.com" },
    { name: "ifconfig", url: "https://ifconfig.me/ip" },
  ];

  const failures = [];

  for (const check of checks) {
    try {
      const response = await page.goto(check.url, {
        waitUntil: "domcontentloaded",
        timeout: 10_000,
      });

      if (!response?.ok()) {
        throw new Error(`HTTP ${response?.status() ?? "unknown"}`);
      }

      const bodyText = (await page.textContent("body"))?.trim();
      if (bodyText && bodyText.length < 100) {
        return { success: true, ip: bodyText, method: check.name };
      }

      failures.push({
        method: check.name,
        error: "Invalid body",
      });
    } catch (error) {
      if (!quiet) {
        console.warn(
          `[browser] ${contextName}: connectivity check failed via ${check.name}: ${error.message}`,
        );
      }
      failures.push({ method: check.name, error: error.message });
    }
  }

  return {
    success: false,
    ip: null,
    method: null,
    allResults: failures,
    error: "all checks failed",
  };
}

async function checkConnectivityWithRetry(
  page,
  contextName,
  quiet = false,
  maxRetries = 3,
) {
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    const result = await checkInternetConnectivity(page, contextName, quiet);
    if (result.success) {
      return result;
    }

    if (attempt < maxRetries) {
      await timeout(2 ** attempt * 1_000);
    }
  }

  return {
    success: false,
    ip: null,
    method: null,
    error: `all connectivity checks failed after ${maxRetries} attempts`,
  };
}

async function cleanupBrowserResources(browserDataPath, quiet = false) {
  const filesToClean = [
    "SingletonLock",
    "SingletonSocket",
    "SingletonCookie",
    ".lock",
    "lockfile",
  ].map((filename) => path.join(browserDataPath, filename));

  for (const filePath of filesToClean) {
    try {
      if (fs.existsSync(filePath)) {
        await fsPromises.unlink(filePath);
      }
    } catch (error) {
      if (!quiet) {
        console.warn(
          `[browser] could not remove ${filePath}: ${error.message}`,
        );
      }
    }
  }
}

async function safeCloseContext(contextName, context) {
  const entry = contexts.get(contextName);
  try {
    await context.close();
  } catch {
    // ignore close failures
  } finally {
    if (entry) {
      releaseTrackedProxy(entry);
    }
    contexts.delete(contextName);
  }
}

function getTrackedProxy(selectedProxy) {
  if (!selectedProxy || typeof selectedProxy === "string") {
    return null;
  }

  return selectedProxy;
}

function releaseTrackedProxy(entry) {
  if (entry?.proxy?.port) {
    markProxyFree(entry.proxy);
  }
}

async function detectClosedContext(context) {
  for (;;) {
    if (!context.pages().length) {
      process.exit(1);
    }
    await timeout(1_000);
  }
}
