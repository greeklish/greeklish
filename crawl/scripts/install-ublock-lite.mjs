#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_ID = "ddkjiahejlhfcafbddmgiahcphecmpfh";
const EXTENSION_NAME = "uBlock Origin Lite";
const INSTALL_DIR_NAME = "2025.921.2008_0";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const targetDir = path.join(
  projectRoot,
  "extensions",
  EXTENSION_ID,
  INSTALL_DIR_NAME,
);
const targetManifest = path.join(targetDir, "manifest.json");

async function main() {
  const browserVersion = await getPatchrightChromiumVersion();
  const crxUrl = buildChromeWebStoreDownloadUrl(browserVersion);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ublock-lite-"));
  const crxPath = path.join(tempDir, "extension.crx");
  const zipPath = path.join(tempDir, "extension.zip");
  const stagingDir = path.join(tempDir, "unpacked");

  try {
    console.log(`[setup] downloading ${EXTENSION_NAME} (${EXTENSION_ID})`);
    console.log(`[setup] Chrome prodversion: ${browserVersion}`);
    const crx = await download(crxUrl);
    await fs.writeFile(crxPath, crx);
    await fs.writeFile(zipPath, crx.subarray(getZipOffset(crx)));

    await fs.mkdir(stagingDir, { recursive: true });
    execFileSync("unzip", ["-q", zipPath, "-d", stagingDir], {
      stdio: "inherit",
    });

    const manifest = JSON.parse(
      await fs.readFile(path.join(stagingDir, "manifest.json"), "utf8"),
    );

    if (
      manifest.name !== "__MSG_extName__" &&
      !String(manifest.name).includes("uBlock")
    ) {
      throw new Error(`unexpected extension manifest name: ${manifest.name}`);
    }

    await fs.mkdir(path.dirname(targetDir), { recursive: true });
    await fs.rm(targetDir, { recursive: true, force: true });
    await fs.cp(stagingDir, targetDir, { recursive: true });

    console.log(`[setup] installed ${EXTENSION_NAME} ${manifest.version}`);
    console.log(
      `[setup] using fixed crawler extension path ${INSTALL_DIR_NAME}`,
    );
    console.log(`[setup] ${targetManifest}`);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function buildChromeWebStoreDownloadUrl(browserVersion) {
  const params = new URLSearchParams({
    response: "redirect",
    prodversion: browserVersion,
    acceptformat: "crx2,crx3",
    x: `id=${EXTENSION_ID}&installsource=ondemand&uc`,
  });

  return `https://clients2.google.com/service/update2/crx?${params}`;
}

async function getPatchrightChromiumVersion() {
  const browsersJsonPath = path.join(
    projectRoot,
    "node_modules",
    "patchright-core",
    "browsers.json",
  );

  try {
    const browsersJson = JSON.parse(
      await fs.readFile(browsersJsonPath, "utf8"),
    );
    const chromium = browsersJson.browsers.find(
      (browser) => browser.name === "chromium",
    );
    if (chromium?.browserVersion) {
      return chromium.browserVersion;
    }
  } catch {
    // Fall through to the stable fallback below.
  }

  return "149.0.7827.55";
}

async function download(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari/537.36",
    },
  });

  if (!response.ok) {
    throw new Error(
      `download failed: ${response.status} ${response.statusText}`,
    );
  }

  return Buffer.from(await response.arrayBuffer());
}

function getZipOffset(crx) {
  if (crx.subarray(0, 2).toString("utf8") === "PK") {
    return 0;
  }

  if (crx.subarray(0, 4).toString("utf8") !== "Cr24") {
    throw new Error("downloaded file is not a CRX or ZIP archive");
  }

  const version = crx.readUInt32LE(4);

  if (version === 2) {
    const publicKeyLength = crx.readUInt32LE(8);
    const signatureLength = crx.readUInt32LE(12);
    return 16 + publicKeyLength + signatureLength;
  }

  if (version === 3) {
    const headerLength = crx.readUInt32LE(8);
    return 12 + headerLength;
  }

  throw new Error(`unsupported CRX version: ${version}`);
}

main().catch((error) => {
  console.error(`[setup] ${error.message}`);
  process.exit(1);
});
