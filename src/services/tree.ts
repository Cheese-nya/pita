import { parse } from "yaml";
import type { Files, Skill } from "../types/workspace";
import type { SkillSource } from "../types/domain";
const encoder = new TextEncoder(),
  decoder = new TextDecoder();
export function encode(bytes: Uint8Array) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192)
    out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(out);
}
export const decode = (s: string) =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const pack = (s: string) => encode(encoder.encode(s));
export const unpack = (s: string) => decoder.decode(decode(s));
export async function hash(files: Files) {
  const bytes = encoder.encode(
    JSON.stringify(
      Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
  );
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export const normalize = (s: string) =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-");
export function meta(files: Files) {
  if (!Object.hasOwn(files, "SKILL.md")) throw Error("invalidSkill");
  const raw = unpack(files["SKILL.md"])
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n");
  const front = raw.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  const data = front && parse(front[1]);
  if (
    typeof data?.name !== "string" ||
    !data.name.trim() ||
    typeof data.description !== "string"
  )
    throw Error("invalidSkill");
  return {
    name: data.name.trim(),
    description: data.description,
    skillMdPreview: raw.slice(front![0].length).trim(),
    charCount: Array.from(data.name + data.description).length,
  };
}
export async function makeSkill(
  files: Files,
  source: SkillSource,
  glyph = "box",
): Promise<Skill> {
  const m = meta(files);
  return {
    ...m,
    id: normalize(m.name),
    files,
    source,
    glyph,
    centralHash: await hash(files),
    pinned: false,
    installedAt: new Date().toISOString(),
    cumulativeEnabledHours: 0,
    hasUpdate: false,
    events: [],
    deployments: [],
  };
}
export function fixtureTree(name: string, description: string, step: string) {
  return {
    "SKILL.md": pack(
      "---\nname: " +
        name +
        "\ndescription: " +
        JSON.stringify(description) +
        "\n---\n# " +
        name +
        "\n\n" +
        description +
        "\n\n## Workflow\n\n1. " +
        step +
        "\n2. Review the result with the project owner.\n",
    ),
    "references/checklist.md": pack("- Confirm scope\n- Review changes\n"),
  };
}
export function changedFiles(a: Files, b: Files) {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
    (k) => a[k] !== b[k],
  );
}
export function normalizeGitUrl(raw: string): string | null {
  let trimmed = raw.trim();
  if (!trimmed) return null;

  // Support pasting CLI commands like `npx skills add owner/repo` or `pnpx skills add https://...`
  const tokens = trimmed.split(/\s+/);
  if (
    tokens.length >= 4 &&
    ["npx", "pnpx", "bunx", "yarn"].includes(tokens[0]) &&
    tokens[1].endsWith("skills") &&
    ["add", "install", "i"].includes(tokens[2])
  ) {
    const target = tokens.slice(3).find((t) => !t.startsWith("-"));
    if (target) trimmed = target.replace(/^["']|["']$/g, "");
  }

  if (gitUrl(trimmed)) return trimmed.replace(/\/+$/, "");

  if (trimmed.startsWith("github.com/") || trimmed.startsWith("gitlab.com/")) {
    const withScheme = "https://" + trimmed.replace(/\/+$/, "");
    if (gitUrl(withScheme)) return withScheme;
  }

  const cleaned = trimmed.replace(/^\/+|\/+$/g, "");
  const parts = cleaned.split("/");
  if (
    parts.length === 2 &&
    /^[A-Za-z0-9_.-]+$/.test(parts[0]) &&
    /^[A-Za-z0-9_.-]+$/.test(parts[1]) &&
    parts[0] !== "." &&
    parts[0] !== ".." &&
    parts[1] !== "." &&
    parts[1] !== ".."
  ) {
    const repo = parts[1].replace(/\.git$/, "");
    if (repo) return `https://github.com/${parts[0]}/${repo}`;
  }
  return null;
}

export function gitUrl(value: string) {
  try {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      u.pathname.split("/").filter(Boolean).length >= 2 &&
      !u.search &&
      !u.hash
    );
  } catch {
    return false;
  }
}
