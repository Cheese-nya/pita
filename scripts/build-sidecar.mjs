#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const tauriDir = path.join(rootDir, "src-tauri");

// Accept optional --target <triple> or Tauri's TAURI_ENV_TARGET_TRIPLE (for cross-compile CI)
let explicitTarget = process.env.TAURI_ENV_TARGET_TRIPLE || "";
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--target" && process.argv[i + 1]) {
    explicitTarget = process.argv[i + 1];
    break;
  }
}

function detectHostTriple() {
  const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const match = out.match(/^host:\s*(\S+)/m);
  if (!match) {
    throw new Error("Unable to determine Rust host triple from rustc -vV");
  }
  return match[1];
}

const targetTriple = explicitTarget || detectHostTriple();
const isWindows = targetTriple.includes("windows");
const exeSuffix = isWindows ? ".exe" : "";

const outDir = path.join(tauriDir, "binaries");
fs.mkdirSync(outDir, { recursive: true });
const sidecarDest = path.join(outDir, `pita-hook-${targetTriple}${exeSuffix}`);
// Create placeholder on clean checkout so tauri_build::build() validates externalBin before copying real binary
if (!fs.existsSync(sidecarDest)) {
  fs.writeFileSync(sidecarDest, "");
}

const cargoArgs = [
  "build",
  "--manifest-path",
  path.join(tauriDir, "Cargo.toml"),
  "--release",
  "--bin",
  "pita-hook",
];
if (explicitTarget) {
  cargoArgs.push("--target", explicitTarget);
}

execFileSync("cargo", cargoArgs, { stdio: "inherit", cwd: rootDir });

const builtBin = explicitTarget
  ? path.join(
      tauriDir,
      "target",
      explicitTarget,
      "release",
      `pita-hook${exeSuffix}`,
    )
  : path.join(tauriDir, "target", "release", `pita-hook${exeSuffix}`);

if (!fs.existsSync(builtBin)) {
  throw new Error(`Expected pita-hook binary not found at ${builtBin}`);
}

fs.copyFileSync(builtBin, sidecarDest);
if (!isWindows) {
  fs.chmodSync(sidecarDest, 0o755);
}
console.log(`[sidecar] bundled ${sidecarDest}`);
