import fs from "node:fs";
import path from "node:path";

import browserPool from "./lib/browser-pool.js";
import { cleanupAllBrowserData, closeBrowser, initBrowser } from "./lib/browser.js";
import { loadConfig } from "./lib/config.js";
import {
  getProxyPoolStatus,
  initProxyManager,
  stopProxyManager,
  waitForInitialProxyLoad,
} from "./lib/proxy-manager.js";
import { getTarget, listTargets } from "./targets/index.js";

const config = loadConfig();

async function main() {
  const [command, arg] = process.argv.slice(2);

  switch (command) {
    case "crawl":
      await runCrawl(arg);
      break;
    case "list-targets":
      printTargets();
      break;
    case "proxies":
      await runProxyStatus();
      break;
    case "test-browser":
      await runBrowserTest(arg);
      break;
    default:
      printHelp();
      process.exitCode = 1;
  }
}

async function runCrawl(targetName) {
  const target = getTarget(targetName);
  if (!target) {
    throw new Error(`Unknown target "${targetName}"`);
  }
  const preserveBrowserData = Boolean(target.definition.preserveBrowserData);
  const removeBrowserClosedRejectionHandler =
    attachCrawlerBrowserClosedRejectionHandler(target.definition.name);

  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());

  initProxyManager();
  await waitForInitialProxyLoad();

  try {
    if (!preserveBrowserData) {
      await cleanupAllBrowserData();
    }
    const result = await target.run({ signal: controller.signal });
    console.log(
      `[crawl:${target.definition.name}] ingested ${result.count} item(s) into topic ${target.definition.topic.slug}`
    );
  } finally {
    if (!preserveBrowserData) {
      await browserPool.shutdown();
    }
    removeBrowserClosedRejectionHandler();
    stopProxyManager();
  }
}

function attachCrawlerBrowserClosedRejectionHandler(targetName) {
  const listener = (reason) => {
    if (isBrowserSessionClosedRejection(reason)) {
      console.warn(
        `[crawl:${targetName}] ignored browser-session-closed rejection: ${formatUnknown(reason)}`
      );
      return;
    }

    throw reason instanceof Error ? reason : new Error(String(reason));
  };

  process.on("unhandledRejection", listener);

  return () => process.off("unhandledRejection", listener);
}

function isBrowserSessionClosedRejection(reason) {
  const message =
    typeof reason === "string"
      ? reason
      : [reason?.name, reason?.type, reason?.method, reason?.message]
          .filter(Boolean)
          .join(" ");

  return /ProtocolError|Target closed|context.*closed|browser.*closed|session closed|Internal server error, session closed|Network\.setCacheDisabled/i.test(
    message
  );
}

async function runProxyStatus() {
  initProxyManager();
  await waitForInitialProxyLoad();
  console.log(JSON.stringify(getProxyPoolStatus({ context: "reddit" }), null, 2));
  stopProxyManager();
}

async function runBrowserTest(existingContextName = null) {
  initProxyManager();
  await waitForInitialProxyLoad();

  const reuseExistingContext = Boolean(existingContextName);
  if (!reuseExistingContext) {
    await cleanupAllBrowserData();
  }

  const contextName = existingContextName || `test-browser-${Date.now()}`;
  const logger = createTestBrowserLogger(contextName);
  logger.log("starting browser test", {
    pid: process.pid,
    node: process.version,
    headless: config.headless,
    debugMode: config.debugMode,
    crawlerDirectConnection: config.crawlerDirectConnection,
    withProxy: config.useBrowserProxies,
    browserDataRoot: config.browserDataRoot,
    reuseExistingContext,
  });

  const removeProcessDebugListeners = attachProcessDebugLogging(logger);
  const shutdown = async () => {
    logger.log("shutdown: begin");

    try {
      await closeBrowser(contextName);
      logger.log("shutdown: closeBrowser completed");
    } catch (error) {
      logger.log("shutdown: closeBrowser failed", formatError(error));
    }

    stopProxyManager();
    logger.log("shutdown: proxy manager stopped");
    removeProcessDebugListeners();
  };

  const keepProcessAlive = new Promise((resolve) => {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.once(signal, () => resolve({ type: "signal", signal }));
    }
  });

  try {
    const page = await initBrowser(contextName, {
      withProxy: config.useBrowserProxies,
      debugMode: config.debugMode,
      configureForScraping: true,
      userDataDir: contextName,
      quiet: false,
    });
    attachBrowserDebugLogging(page, contextName, logger);

    const startUrl = getBrowserTestStartUrl(contextName);
    if (startUrl) {
      logger.log("navigating to start url", { startUrl });
      const response = await page.goto(startUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      logger.log("start url loaded", {
        startUrl,
        status: response?.status() ?? "unknown",
      });
    }

    logger.log("browser initialized", {
      initialUrl: safePageUrl(page),
      pageCount: page.context().pages().length,
      logFile: logger.logFilePath,
      startUrl: startUrl || null,
    });

    const browserClosed = page
      .context()
      .waitForEvent("close", { timeout: 0 })
      .then(() => ({ type: "context-close" }))
      .catch((error) => ({
        type: "context-close-error",
        error: formatError(error),
      }));

    console.log(`[test-browser] browser started: ${contextName}`);
    console.log(`[test-browser] verbose log: ${logger.logFilePath}`);
    if (startUrl) {
      console.log(`[test-browser] opening ${startUrl}`);
    }
    if (reuseExistingContext) {
      console.log(`[test-browser] reusing browser-data/${contextName}`);
    }
    console.log("[test-browser] press Ctrl+C to close it");

    const exitReason = await Promise.race([keepProcessAlive, browserClosed]);
    logger.log("browser test wait finished", exitReason);
  } finally {
    await shutdown();
  }
}

function createTestBrowserLogger(contextName) {
  const logFilePath = path.join(
    config.browserDataRoot,
    contextName,
    "test-browser-debug.log"
  );

  const writeLine = (line, timestamp) => {
    try {
      fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
      fs.appendFileSync(logFilePath, `${line}\n`);
    } catch (error) {
      console.error(
        `[test-browser][${timestamp}][${contextName}] failed to write debug log ${error.message}`
      );
    }
  };

  return {
    logFilePath,
    log(message, details = null, { toConsole = true } = {}) {
      const timestamp = new Date().toISOString();
      const line = `[test-browser][${timestamp}][${contextName}] ${message}${
        details ? ` ${safeJson(details)}` : ""
      }`;

      if (toConsole) {
        console.log(line);
      }

      writeLine(line, timestamp);
    },
    fileOnly(message, details = null) {
      this.log(message, details, { toConsole: false });
    },
  };
}

function attachProcessDebugLogging(logger) {
  const listeners = [
    ["beforeExit", (code) => logger.fileOnly("process beforeExit", { code })],
    ["exit", (code) => logger.fileOnly("process exit", { code })],
    ["uncaughtExceptionMonitor", (error) =>
      logger.fileOnly("process uncaughtException", formatError(error))],
    ["unhandledRejection", (reason) =>
      logger.fileOnly("process unhandledRejection", formatUnknown(reason))],
    ["warning", (warning) =>
      logger.fileOnly("process warning", {
        name: warning.name,
        message: warning.message,
        stack: warning.stack,
      })],
    ["SIGINT", () => logger.fileOnly("process signal", { signal: "SIGINT" })],
    ["SIGTERM", () => logger.fileOnly("process signal", { signal: "SIGTERM" })],
    ["SIGHUP", () => logger.fileOnly("process signal", { signal: "SIGHUP" })],
  ];

  for (const [eventName, listener] of listeners) {
    process.on(eventName, listener);
  }

  return () => {
    for (const [eventName, listener] of listeners) {
      process.off(eventName, listener);
    }
  };
}

function attachBrowserDebugLogging(page, contextName, logger) {
  const context = page.context();
  const browser = typeof context.browser === "function" ? context.browser() : null;
  const attachedPages = new WeakSet();
  const pageIds = new WeakMap();
  let pageCounter = 0;

  const getPageId = (currentPage) => {
    if (!pageIds.has(currentPage)) {
      pageCounter += 1;
      pageIds.set(currentPage, `page-${pageCounter}`);
    }
    return pageIds.get(currentPage);
  };

  const describePage = (currentPage) => ({
    id: getPageId(currentPage),
    url: safePageUrl(currentPage),
    closed: currentPage.isClosed(),
  });

  const safeLog = (message, getDetails) => {
    try {
      logger.fileOnly(message, getDetails());
    } catch (error) {
      logger.fileOnly("debug handler failure", {
        message,
        ...formatError(error),
      });
    }
  };

  const attachPageListeners = (currentPage, reason) => {
    if (attachedPages.has(currentPage)) {
      logger.fileOnly("page already attached", {
        reason,
        ...describePage(currentPage),
      });
      return;
    }

    attachedPages.add(currentPage);
    const pageInfo = describePage(currentPage);
    logger.fileOnly("page attached", { reason, ...pageInfo });

    currentPage.on("close", () => {
      safeLog("page close", () => describePage(currentPage));
    });

    currentPage.on("crash", () => {
      safeLog("page crash", () => describePage(currentPage));
    });

    currentPage.on("domcontentloaded", () => {
      safeLog("page domcontentloaded", () => describePage(currentPage));
    });

    currentPage.on("load", () => {
      safeLog("page load", () => describePage(currentPage));
    });

    currentPage.on("pageerror", (error) => {
      safeLog("page error", () => ({
        ...describePage(currentPage),
        ...formatError(error),
      }));
    });

    currentPage.on("console", (message) => {
      safeLog("page console", () => ({
        ...describePage(currentPage),
        type: message.type(),
        text: message.text(),
      }));
    });

    currentPage.on("dialog", (dialog) => {
      safeLog("page dialog", () => ({
        ...describePage(currentPage),
        type: dialog.type(),
        message: dialog.message(),
        defaultValue: dialog.defaultValue(),
      }));
    });

    currentPage.on("popup", (popupPage) => {
      safeLog("page popup", () => ({
        sourcePageId: getPageId(currentPage),
        popupPageId: getPageId(popupPage),
        popupUrl: safePageUrl(popupPage),
      }));
      attachPageListeners(popupPage, "popup");
    });

    currentPage.on("framenavigated", (frame) => {
      safeLog("frame navigated", () => ({
        ...describePage(currentPage),
        frameUrl: frame.url(),
        isMainFrame: frame === currentPage.mainFrame(),
      }));
    });

    currentPage.on("download", (download) => {
      safeLog("page download", () => ({
        ...describePage(currentPage),
        url: download.url(),
        suggestedFilename: download.suggestedFilename(),
      }));
    });
  };

  context.on("close", () => {
    safeLog("context close", () => ({
      contextName,
      remainingPages: context.pages().length,
    }));
  });

  context.on("page", (newPage) => {
    attachPageListeners(newPage, "context-page-event");
  });

  context.on("request", (request) => {
    safeLog("request", () => ({
      ...describeRequest(request, getPageId),
      method: request.method(),
      resourceType: request.resourceType(),
      isNavigationRequest: request.isNavigationRequest(),
      url: request.url(),
    }));
  });

  context.on("response", (response) => {
    safeLog("response", () => ({
      ...describeRequest(response.request(), getPageId),
      status: response.status(),
      ok: response.ok(),
      url: response.url(),
    }));
  });

  context.on("requestfailed", (request) => {
    safeLog("request failed", () => ({
      ...describeRequest(request, getPageId),
      method: request.method(),
      resourceType: request.resourceType(),
      url: request.url(),
      failure: request.failure(),
    }));
  });

  context.on("requestfinished", (request) => {
    safeLog("request finished", () => ({
      ...describeRequest(request, getPageId),
      method: request.method(),
      resourceType: request.resourceType(),
      url: request.url(),
    }));
  });

  if (browser?.on) {
    browser.on("disconnected", () => {
      safeLog("browser disconnected", () => ({
        contextName,
        pageCount: context.pages().length,
      }));
    });
  }

  for (const existingPage of context.pages()) {
    attachPageListeners(existingPage, "initial-page-scan");
  }
}

function describeRequest(request, getPageId) {
  const details = {
    pageId: null,
    frameUrl: null,
    serviceWorkerUrl: null,
    pageResolutionError: null,
  };

  try {
    const frame = typeof request.frame === "function" ? request.frame() : null;
    if (frame) {
      details.frameUrl = safeCall(() => frame.url());
      const ownerPage =
        typeof frame.page === "function" ? safeCall(() => frame.page()) : null;
      if (ownerPage) {
        details.pageId = getPageId(ownerPage);
      }
    }
  } catch (error) {
    details.pageResolutionError = error.message;
  }

  if (!details.pageId && typeof request.serviceWorker === "function") {
    const serviceWorker = safeCall(() => request.serviceWorker());
    if (serviceWorker) {
      details.serviceWorkerUrl = safeCall(() => serviceWorker.url());
    }
  }

  return details;
}

function safePageUrl(page) {
  try {
    return page.url();
  } catch (error) {
    return `unavailable: ${error.message}`;
  }
}

function formatError(error) {
  if (!error) {
    return { message: "unknown error" };
  }

  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
}

function formatUnknown(value) {
  if (value instanceof Error) {
    return formatError(value);
  }

  return {
    value:
      typeof value === "string" ? value : safeJson(value),
  };
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return JSON.stringify({
      serializationError: error.message,
      fallback: String(value),
    });
  }
}

function safeCall(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

function getBrowserTestStartUrl(contextName) {
  const target = listTargets().find(
    (candidate) => candidate.browserContextName === contextName
  );
  return target?.listingUrl ?? null;
}

function printTargets() {
  for (const target of listTargets()) {
    console.log(
      `${target.name} -> ${target.topic.slug} (${target.topic.rankingStrategy})`
    );
  }
}

function printHelp() {
  console.log(`Usage:

  node src/cli.js list-targets
  node src/cli.js crawl <target-name>
  node src/cli.js proxies
  node src/cli.js test-browser
  node src/cli.js test-browser <existing-context-name>
`);
}

main().catch(async (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
