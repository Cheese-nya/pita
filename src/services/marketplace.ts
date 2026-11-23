import { invoke } from "@tauri-apps/api/core";
import { unzipSync } from "fflate";
import type { Skill } from "../types/workspace";
import { encode } from "./tree";

export type MarketplaceFeed = "all" | "trending" | "popular";

export interface MarketplaceItem {
  key: string;
  slug: string;
  name: string;
  source: string;
  repoUrl?: string;
  url: string;
  installs: number;
}

interface MarketplacePage {
  items: MarketplaceItem[];
  total?: number;
  hasMore: boolean;
}

const feeds = { all: "all-time", trending: "trending", popular: "hot" };
const cache = new Map<string, { at: number; result: MarketplacePage }>();
const githubRepo = /^[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+$/i;

export async function loadMarketplace(
  feed: MarketplaceFeed,
  page: number,
  query: string,
  signal: AbortSignal,
): Promise<MarketplacePage> {
  const view = feeds[feed];
  const key = JSON.stringify(query ? [query] : [view, page]);
  const saved = cache.get(key);
  if (saved && Date.now() - saved.at < 300_000) return saved.result;
  const params = new URLSearchParams({ q: query, limit: "80" });
  const endpoint = query ? `search?${params}` : `skills/${view}/${page}`;
  const response =
    "__TAURI_INTERNALS__" in window
      ? await invoke<unknown>("marketplace_feed", { view, page, query })
      : await fetch(`/marketplace-api/${endpoint}`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
        }).then((res) => {
          if (!res.ok) throw Error("marketUnavailable");
          return res.json();
        });
  const data = response as {
    skills?: unknown[];
    total?: number;
    hasMore?: boolean;
  };
  if (!Array.isArray(data.skills)) throw Error("marketUnavailable");
  const items = new Map<string, MarketplaceItem>();
  for (const entry of data.skills) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    if (
      typeof row.source !== "string" ||
      typeof row.name !== "string" ||
      typeof row.installs !== "number"
    )
      continue;
    const slug = row.skillId ?? row.name;
    if (typeof slug !== "string" || !slug.trim()) continue;
    const source = row.source;
    const id = `${source}/${slug}`;
    const repoUrl =
      githubRepo.test(source) && !/\/\.{1,2}$/.test(source)
        ? `https://github.com/${source}`
        : undefined;
    const url = `https://skills.sh/${source.split("/").map(encodeURIComponent).join("/")}/${encodeURIComponent(slug)}`;
    items.set(id, {
      key: id,
      slug,
      name: row.name,
      source,
      url,
      repoUrl,
      installs: row.installs,
    });
  }
  const result = {
    items: [...items.values()],
    total: data.total,
    hasMore: !query && !!data.hasMore,
  };
  if (cache.size >= 48) cache.clear();
  cache.set(key, { at: Date.now(), result });
  return result;
}

export function formatInstalls(n: number): string {
  if (n >= 1_000_000)
    return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

export function githubAvatarUrl(repoUrl?: string): string | undefined {
  if (!repoUrl) return undefined;
  const owner = repoUrl.match(
    /^https?:\/\/github\.com\/([a-z0-9][a-z0-9-]*)\//i,
  )?.[1];
  if (!owner) return undefined;
  if (
    [
      "vercel-labs",
      "heygen-com",
      "mattpocock",
      "anthropics",
      "microsoft",
    ].includes(owner.toLowerCase())
  ) {
    return `/avatars/${owner.toLowerCase()}.png`;
  }
  return `https://github.com/${owner}.png?size=64`;
}

export function marketplaceMember(
  item: MarketplaceItem,
  skills: Skill[],
): Skill | undefined {
  const slug = item.slug.toLowerCase();
  const candidates = skills.filter(
    (s) =>
      s.source.type === "git" &&
      s.source.repoUrl
        .replace(/(?:\.git)?\/+$/, "")
        .replace(/\.git$/, "")
        .toLowerCase() === item.repoUrl?.toLowerCase(),
  );
  const byPath = candidates.filter(
    (s) =>
      s.source.type === "git" &&
      s.source.skillPath.split("/").at(-1)?.toLowerCase() === slug,
  );
  if (byPath.length === 1) return byPath[0];
  const byName = candidates.filter(
    (s) => s.id === slug || s.name.toLowerCase() === item.name.toLowerCase(),
  );
  return byName.length === 1 ? byName[0] : undefined;
}

const repoCache = new Map<string, Promise<{ skills: Skill[] }>>();

export function isMarketplacePlaceholder(skill: Skill): boolean {
  return (
    skill.source.type === "git" &&
    skill.source.commit === skill.centralHash.slice(0, 40) &&
    Object.keys(skill.files).length === 2 &&
    !!skill.files["references/checklist.md"] &&
    skill.skillMdPreview.endsWith(
      "2. Review the result with the project owner.",
    )
  );
}

export async function loadMarketplaceRepo(
  item: MarketplaceItem,
  inspectGit: (url: string) => Promise<{ skills: Skill[] }>,
): Promise<Skill> {
  const repo = item.repoUrl;
  if (!repo) throw Error("marketExternalSource");
  let pending = repoCache.get(repo);
  if (!pending) {
    pending =
      "__TAURI_INTERNALS__" in window
        ? inspectGit(repo)
        : inspectBrowserRepository(repo, item.source);
    const request = pending;
    repoCache.set(repo, request);
    const expire = () => {
      if (repoCache.get(repo) === request) repoCache.delete(repo);
    };
    void request.then(() => window.setTimeout(expire, 60_000), expire);
  }
  const member = marketplaceMember(item, (await pending).skills);
  if (!member) throw Error("marketSkillMissing");
  return member;
}

async function inspectBrowserRepository(repoUrl: string, source: string) {
  const signal = AbortSignal.timeout(20_000);
  const headers = { Accept: "application/vnd.github+json" };
  const [repo, commit] = await Promise.all([
    fetch(`https://api.github.com/repos/${source}`, { headers, signal }),
    fetch(`https://api.github.com/repos/${source}/commits/HEAD`, {
      headers,
      signal,
    }),
  ]);
  if (!repo.ok || !commit.ok) throw Error("marketRepoUnavailable");
  const { default_branch: ref } = await repo.json();
  const { sha } = await commit.json();
  if (typeof ref !== "string" || !/^[a-f0-9]{40}$/.test(sha))
    throw Error("marketRepoUnavailable");
  const response = await fetch(`/marketplace-archive/${source}/zip/${sha}`, {
    signal,
  });
  if (!response.ok) throw Error("marketRepoUnavailable");
  let totalBytes = 0;
  const archive = unzipSync(new Uint8Array(await response.arrayBuffer()), {
    filter: ({ name, originalSize }) => {
      if (name.endsWith("/") || name.includes("/node_modules/")) return false;
      totalBytes += originalSize;
      if (totalBytes > 32 * 1024 * 1024) throw Error("marketRepoUnavailable");
      return true;
    },
  });
  const entries = Object.fromEntries(
    Object.entries(archive).map(([name, bytes]) => [
      name.slice(name.indexOf("/") + 1),
      encode(bytes),
    ]),
  );
  const { importTrees } = await import("./archive");
  const { skills } = await importTrees(entries, true);
  for (const skill of skills) {
    const skillPath =
      skill.source.type === "local" ? skill.source.originPath || "." : ".";
    skill.source = { type: "git", repoUrl, ref, commit: sha, skillPath };
  }
  return { skills };
}
