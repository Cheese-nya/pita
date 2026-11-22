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
const hookDir = path.join(tauriDir, "pita-hook");

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

const cargoArgs = [
  "build",
  "--manifest-path",
  path.join(hookDir, "Cargo.toml"),
  "--release",
];
if (explicitTarget) {
  cargoArgs.push("--target", explicitTarget);
}

execFileSync("cargo", cargoArgs, { stdio: "inherit", cwd: rootDir });

const builtBin = explicitTarget
  ? path.join(
      hookDir,
      "target",
      explicitTarget,
      "release",
      `pita-hook${exeSuffix}`,
    )
  : path.join(hookDir, "target", "release", `pita-hook${exeSuffix}`);

if (!fs.existsSync(builtBin)) {
  throw new Error(`Expected pita-hook binary not found at ${builtBin}`);
}

const outDir = path.join(tauriDir, "binaries");
fs.mkdirSync(outDir, { recursive: true });
const sidecarDest = path.join(outDir, `pita-hook-${targetTriple}${exeSuffix}`);
fs.copyFileSync(builtBin, sidecarDest);
if (!isWindows) {
  fs.chmodSync(sidecarDest, 0o755);
}
console.log(`[sidecar] bundled ${sidecarDest}`);
