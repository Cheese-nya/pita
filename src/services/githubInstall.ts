import { invoke } from "@tauri-apps/api/core";
import { unzipSync } from "fflate";
import type { Files, Skill } from "../types/workspace";
import { encode, makeSkill, normalize, normalizeGitUrl } from "./tree";

type Inspection = { skills: Skill[]; rejected: string[] };
type Inspector = (url: string) => Promise<Inspection>;

export type InstallSource =
  | { site: string; slug: string; url: string }
  | { url: string; repo?: string; slug?: string; tree?: string[] };

const refHash = /^[a-f0-9]{40}$/;
const segment = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
const safePath = (path: string) =>
  path
    .split("/")
    .every(
      (part) =>
        !!part && part !== "." && part !== ".." && !/[:\\\x00]/.test(part),
    );
const encodePath = (path: string) =>
  path.split("/").map(encodeURIComponent).join("/");
const hiddenCache = new Set([
  ".git",
  "node_modules",
  "__MACOSX",
  ".venv",
  "__pycache__",
  ".next",
  "target",
  ".cache",
  "dist",
  "build",
]);
const fileLimit = 2 * 1024 * 1024;
const skillLimit = 10 * 1024 * 1024;
const native = () => "__TAURI_INTERNALS__" in window;

export function installSource(input: string): InstallSource | null {
  let value = input.trim();
  let requested: string | undefined;
  const command = value.match(
    /^(?:npx|pnpx|bunx|yarn)\s+\S*skills\s+(?:add|install|i)\s+(?:"([^"]+)"|'([^']+)'|(\S+))(.*)$/,
  );
  if (command) {
    value = command[1] ?? command[2] ?? command[3];
    requested = command[4]
      .match(/(?:^|\s)(?:--skill|-s)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/)
      ?.slice(1)
      .find(Boolean);
  }

  const shortcut = value.match(/^([\w.-]+\/[\w.-]+)@([^/]+)$/);
  if (shortcut) {
    value = shortcut[1];
    requested ??= shortcut[2];
  }
  if (/^(?:www\.)?skills\.sh\//i.test(value)) value = "https://" + value;
  const url = normalizeGitUrl(value);
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent);
    const [owner, repo, marker, ...tail] = parts;
    if (parts.some((part) => !safePath(part) || part.includes("/")))
      return null;
    if (["skills.sh", "www.skills.sh"].includes(parsed.hostname)) {
      if (parts.length !== 3 || !segment.test(marker)) return null;
      if (owner === "site")
        return {
          site: repo.toLowerCase(),
          slug: marker,
          url: `https://skills.sh/site/${repo.toLowerCase()}/${marker}`,
        };
      if (!segment.test(owner) || !segment.test(repo)) return null;
      return {
        url: `https://github.com/${owner}/${repo}`,
        repo: `${owner}/${repo}`,
        slug: marker,
      };
    }
    if (parsed.hostname === "github.com") {
      const name = repo.replace(/\.git$/, "");
      if (!segment.test(owner) || !segment.test(name)) return null;
      if (
        parts.length > 2 &&
        ((marker !== "tree" && marker !== "blob") || !tail.length)
      )
        return null;
      if (marker === "blob" && tail.at(-1)?.toLowerCase() !== "skill.md")
        return null;
      return {
        url: `https://github.com/${owner}/${name}`,
        repo: `${owner}/${name}`,
        slug: requested,
        tree: tail.length ? tail : undefined,
      };
    }
    return { url, slug: requested };
  } catch {
    return null;
  }
}

async function githubBytes(path: string, raw = false): Promise<Uint8Array> {
  if (native()) {
    const data = await invoke<ArrayBuffer>("github_install_fetch", {
      path,
      raw,
    });
    return new Uint8Array(data);
  }
  const host = raw ? "raw.githubusercontent.com" : "api.github.com";
  const response = await fetch(`https://${host}/${path}`, {
    signal: AbortSignal.timeout(12_000),
  });
  if (response.status === 404) throw Error("gitSourceNotFound");
  if ([403, 429].includes(response.status)) throw Error("gitApiLimited");
  if (!response.ok) throw Error("marketRepoUnavailable");
  const data = new Uint8Array(await response.arrayBuffer());
  if (data.length > (raw ? fileLimit : 16 * 1024 * 1024))
    throw Error("sourceTooLarge");
  return data;
}

async function githubJson<T>(path: string): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await githubBytes(path)));
}

type Commit = { sha: string; commit: { tree: { sha: string } } };
type Entry = {
  path: string;
  type: string;
  mode: string;
  size?: number;
  sha: string;
};
type GitTree = { tree: Entry[]; truncated: boolean };

async function githubHead(repo: string, tree?: string[]) {
  if (tree?.length) {
    for (let end = 1; end <= tree.length && end <= 12; end++) {
      const ref = tree.slice(0, end).join("/");
      const commit = await githubJson<Commit>(
        `repos/${repo}/commits/${encodeURIComponent(ref)}`,
      ).catch((e) => {
        if (
          String(e) !== "gitSourceNotFound" &&
          (e as Error)?.message !== "gitSourceNotFound"
        )
          throw e;
      });
      if (!commit) continue;
      const path = tree
        .slice(end)
        .join("/")
        .replace(/(?:^|\/)SKILL\.md$/i, "");
      return { ref, commit, path };
    }
    throw Error("gitSourceNotFound");
  }
  const [meta, commits] = await Promise.all([
    githubJson<{ default_branch: string }>(`repos/${repo}`),
    githubJson<Commit[]>(`repos/${repo}/commits?per_page=1`),
  ]);
  return { ref: meta.default_branch, commit: commits[0], path: "" };
}

function selectSkillRoots(tree: Entry[], prefix: string, slug?: string) {
  const roots = tree
    .filter(
      (entry) =>
        entry.type === "blob" && ["100644", "100755"].includes(entry.mode),
    )
    .map((entry) => entry.path)
    .filter(
      (path) =>
        /(?:^|\/)skill\.md$/i.test(path) &&
        (!prefix || path.startsWith(prefix + "/")),
    )
    .filter(
      (path) =>
        safePath(path) &&
        !path.split("/").some((part) => hiddenCache.has(part)),
    )
    .map((path) => path.slice(0, -"SKILL.md".length));
  if (!slug) {
    const exact = prefix && prefix + "/";
    return exact && roots.includes(exact) ? [exact] : [...new Set(roots)];
  }
  const key = normalize(slug);
  const exact = [`skills/${slug}/`, `.agents/skills/${slug}/`, `${slug}/`];
  if (!prefix) {
    for (const path of exact) if (roots.includes(path)) return [path];
  }
  const matching = roots.filter(
    (root) => normalize(root.slice(0, -1).split("/").at(-1) ?? "") === key,
  );
  // A single root or an exact tree URL can use a title different from the directory.
  return matching.length ? matching : roots.length === 1 ? roots : [];
}

async function readGithubSkill(
  source: { url: string; repo: string },
  ref: string,
  commit: string,
  entries: Entry[],
  root: string,
): Promise<Skill> {
  const scoped = entries.filter((entry) => {
    if (
      !entry.path.startsWith(root) ||
      entry.type !== "blob" ||
      !["100644", "100755"].includes(entry.mode)
    )
      return false;
    const path = entry.path.slice(root.length);
    return (
      safePath(path) && !path.split("/").some((part) => hiddenCache.has(part))
    );
  });
  if (
    scoped.length > 200 ||
    scoped.some(
      (entry) => typeof entry.size !== "number" || entry.size > fileLimit,
    ) ||
    scoped.reduce((total, entry) => total + (entry.size ?? 0), 0) > skillLimit
  )
    throw Error("sourceTooLarge");
  const files: Files = Object.create(null);
  const names = new Set<string>();
  for (const entry of scoped) {
    const relative = entry.path.slice(root.length).toLowerCase();
    if (names.has(relative)) throw Error("invalidBundle");
    names.add(relative);
  }
  for (let at = 0; at < scoped.length; at += 8) {
    await Promise.all(
      scoped.slice(at, at + 8).map(async (entry) => {
        const bytes = await githubBytes(
          `${source.repo}/${commit}/${encodePath(entry.path)}`,
          true,
        );
        if (bytes.length !== entry.size) throw Error("downloadFailed");
        const relative = entry.path.slice(root.length);
        files[relative.toLowerCase() === "skill.md" ? "SKILL.md" : relative] =
          encode(bytes);
      }),
    );
  }
  const skill = await makeSkill(files, {
    type: "git",
    repoUrl: source.url,
    ref,
    commit,
    skillPath: root.slice(0, -1) || ".",
  });
  if (refHash.test(ref)) skill.pinned = true;
  return skill;
}

export async function inspectGithubSkill(source: {
  url: string;
  repo: string;
  slug?: string;
  tree?: string[];
}): Promise<Inspection> {
  const { ref, commit, path } = await githubHead(source.repo, source.tree);
  if (
    !ref ||
    !refHash.test(commit?.sha) ||
    !refHash.test(commit?.commit?.tree?.sha)
  )
    throw Error("marketRepoUnavailable");
  const result = await githubJson<GitTree>(
    `repos/${source.repo}/git/trees/${commit.commit.tree.sha}?recursive=1`,
  );
  if (result.truncated) throw Error("sourceTooLarge");
  const roots = selectSkillRoots(result.tree, path, source.slug);
  if (!roots.length) throw Error("marketSkillMissing");
  const skills: Skill[] = [];
  const rejected: string[] = [];
  for (const root of roots) {
    try {
      const skill = await readGithubSkill(
        source,
        ref,
        commit.sha,
        result.tree,
        root,
      );
      const name = source.slug ? normalize(source.slug) : "";
      if (
        !name ||
        skill.id === name ||
        normalize(root.slice(0, -1).split("/").at(-1) ?? "") === name
      )
        skills.push(skill);
    } catch (e) {
      if (roots.length === 1) throw e;
      rejected.push(root + "SKILL.md");
    }
  }
  if (!skills.length) throw Error("marketSkillMissing");
  if (source.slug && skills.length !== 1) throw Error("sourceCollision");
  return { skills, rejected };
}

async function inspectBrowserGithub(
  url: string,
  repo: string,
): Promise<Inspection> {
  const { ref, commit } = await githubHead(repo);
  if (!ref || !refHash.test(commit?.sha)) throw Error("marketRepoUnavailable");
  const response = await fetch(
    `/marketplace-archive/${repo}/zip/${commit.sha}`,
    {
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!response.ok) throw Error("marketRepoUnavailable");
  let totalBytes = 0;
  const unpacked = unzipSync(new Uint8Array(await response.arrayBuffer()), {
    filter: ({ name, originalSize }) => {
      if (
        name.endsWith("/") ||
        name.split("/").some((part) => hiddenCache.has(part))
      )
        return false;
      totalBytes += originalSize;
      if (totalBytes > 32 * 1024 * 1024) throw Error("sourceTooLarge");
      return true;
    },
  });
  const entries = Object.fromEntries(
    Object.entries(unpacked).map(([name, bytes]) => [
      name.slice(name.indexOf("/") + 1),
      encode(bytes),
    ]),
  );
  const { importTrees } = await import("./archive");
  const result = await importTrees(entries, true);
  for (const skill of result.skills) {
    const skillPath =
      skill.source.type === "local" ? skill.source.originPath || "." : ".";
    skill.source = {
      type: "git",
      repoUrl: url,
      ref,
      commit: commit.sha,
      skillPath,
    };
  }
  return result;
}

export async function inspectInstallSource(
  source: InstallSource,
  inspectGit: Inspector,
): Promise<Inspection> {
  if ("site" in source) {
    if (!native()) throw Error("marketExternalSource");
    return invoke("inspect_site_skill", {
      domain: source.site,
      slug: source.slug,
    });
  }
  if (source.repo && (source.tree || source.slug)) {
    try {
      return await inspectGithubSkill({ ...source, repo: source.repo });
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error);
      if (
        !native() ||
        source.tree ||
        !["gitApiLimited", "marketSkillMissing"].includes(code)
      )
        throw error;
    }
  }
  if (!native() && !source.repo) throw Error("gitDesktopOnly");
  const result =
    !native() && source.repo
      ? await inspectBrowserGithub(source.url, source.repo)
      : await inspectGit(source.url);
  if (!source.slug) return result;
  const slug = normalize(source.slug);
  const matches = result.skills.filter(
    (skill) =>
      skill.id === slug ||
      (skill.source.type === "git" &&
        normalize(skill.source.skillPath.split("/").at(-1) ?? "") === slug),
  );
  if (matches.length !== 1)
    throw Error(matches.length ? "sourceCollision" : "marketSkillMissing");
  return { skills: matches, rejected: result.rejected };
}
