import { invoke } from "@tauri-apps/api/core";
import { preference, remember } from "../i18n";
import type { Skill } from "../types/workspace";
import { auditSkillFiles, type SkillAuditReport } from "./audit";
import { meta, pack } from "./tree";
import { inspectInstallSource, type InstallSource } from "./githubInstall";

export type MarketplaceFeed = "all" | "trending" | "popular";

export interface MarketplaceItem {
  key: string;
  slug: string;
  name: string;
  source: string;
  repoUrl?: string;
  site?: string;
  url: string;
  installs: number;
}

export interface MarketplacePage {
  items: MarketplaceItem[];
  total?: number;
  hasMore: boolean;
}

const feeds = { all: "all-time", trending: "trending", popular: "hot" };
type CachedPage = { at: number; result: MarketplacePage };
const cache = new Map<string, CachedPage>();
const feedRequests = new Map<string, Promise<MarketplacePage>>();
const FEED_FRESH_MS = 5 * 60_000;
const FEED_CACHE_MS = 7 * 24 * 60 * 60_000;
const githubRepo = /^[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+$/i;

const WELL_KNOWN_MARKETPLACE_REPOS: Record<string, string> = {
  "agent-browser": "https://github.com/vercel-labs/agent-browser",
  "find-skills": "https://github.com/vercel-labs/skills",
  "vercel-react-best-practices": "https://github.com/vercel-labs/agent-skills",
  "web-design-guidelines": "https://github.com/vercel-labs/agent-skills",
  "vercel-composition-patterns": "https://github.com/vercel-labs/agent-skills",
  "frontend-design": "https://github.com/anthropics/skills",
  pdf: "https://github.com/anthropics/skills",
  docx: "https://github.com/anthropics/skills",
  pptx: "https://github.com/anthropics/skills",
  xlsx: "https://github.com/anthropics/skills",
  "skill-creator": "https://github.com/anthropics/skills",
  "mcp-builder": "https://github.com/anthropics/skills",
  "webapp-testing": "https://github.com/anthropics/skills",
  "playwright-cli": "https://github.com/microsoft/playwright-cli",
  hyperframes: "https://github.com/heygen-com/hyperframes",
  "hyperframes-cli": "https://github.com/heygen-com/hyperframes",
  "hyperframes-registry": "https://github.com/heygen-com/hyperframes",
  "remotion-best-practices": "https://github.com/remotion-dev/skills",
};

const skillRepoMap = new Map<string, { repoUrl: string; installs: number }>();

function recordMarketplaceRepo(
  skillKey: string,
  repoUrl: string,
  installs: number,
) {
  const normalized = skillKey.trim().toLowerCase();
  if (!normalized) return;
  const existing = skillRepoMap.get(normalized);
  if (!existing || installs > existing.installs) {
    skillRepoMap.set(normalized, { repoUrl, installs });
  }
}

export function knownMarketplaceRepoForSkill(
  skillId: string,
): string | undefined {
  const key = skillId.trim().toLowerCase();
  if (!key) return undefined;
  return skillRepoMap.get(key)?.repoUrl ?? WELL_KNOWN_MARKETPLACE_REPOS[key];
}

function feedCacheKey(feed: MarketplaceFeed, page: number, query: string) {
  return query ? JSON.stringify([query]) : `marketplace.v1.${feed}.${page}`;
}

function websiteSource(source: string) {
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(source)
    ? source.toLowerCase()
    : undefined;
}

function cachedPage(feed: MarketplaceFeed, page: number, query: string) {
  const key = feedCacheKey(feed, page, query);
  const saved = cache.get(key);
  if (saved && Date.now() - saved.at < FEED_CACHE_MS) return saved;
  if (query || page !== 0) return undefined;
  try {
    const stored = JSON.parse(preference(key, "null")) as CachedPage | null;
    if (
      stored &&
      Date.now() - stored.at < FEED_CACHE_MS &&
      Array.isArray(stored.result?.items)
    ) {
      for (const item of stored.result.items) {
        item.site = websiteSource(item.source);
        if (item.site)
          item.url = `https://skills.sh/site/${item.site}/${encodeURIComponent(item.slug)}`;
        if (item.repoUrl) {
          recordMarketplaceRepo(item.slug, item.repoUrl, item.installs);
          recordMarketplaceRepo(item.name, item.repoUrl, item.installs);
        }
      }
      cache.set(key, stored);
      return stored;
    }
  } catch {
    // A damaged cache is replaced after the next successful request.
  }
}

export function getCachedMarketplace(
  feed: MarketplaceFeed,
  page = 0,
  query = "",
) {
  return cachedPage(feed, page, query)?.result;
}

export async function loadMarketplace(
  feed: MarketplaceFeed,
  page: number,
  query: string,
): Promise<MarketplacePage> {
  const key = feedCacheKey(feed, page, query);
  const saved = cachedPage(feed, page, query);
  if (saved && Date.now() - saved.at < FEED_FRESH_MS) return saved.result;
  const pending = feedRequests.get(key);
  if (pending) return pending;

  const request = fetchMarketplace(feed, page, query)
    .then((result) => {
      const entry = { at: Date.now(), result };
      if (cache.size >= 48) cache.delete(cache.keys().next().value!);
      cache.set(key, entry);
      if (!query && page === 0) remember(key, JSON.stringify(entry));
      return result;
    })
    .finally(() => feedRequests.delete(key));
  feedRequests.set(key, request);
  return request;
}

async function fetchMarketplace(
  feed: MarketplaceFeed,
  page: number,
  query: string,
): Promise<MarketplacePage> {
  const view = feeds[feed];
  const params = new URLSearchParams({ q: query, limit: "80" });
  const endpoint = query ? `search?${params}` : `skills/${view}/${page}`;
  const response =
    "__TAURI_INTERNALS__" in window
      ? await invoke<unknown>("marketplace_feed", { view, page, query })
      : await fetch(`/marketplace-api/${endpoint}`, {
          signal: AbortSignal.timeout(12_000),
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
    if (typeof slug !== "string" || !slug.trim() || /^\.{1,2}$/.test(slug))
      continue;
    const source = row.source;
    const id = `${source}/${slug}`;
    const repoUrl =
      githubRepo.test(source) && !/\/\.{1,2}$/.test(source)
        ? `https://github.com/${source}`
        : undefined;
    const site = websiteSource(source);
    const sourcePath = site
      ? `site/${site}`
      : source.split("/").map(encodeURIComponent).join("/");
    const url = `https://skills.sh/${sourcePath}/${encodeURIComponent(slug)}`;
    if (repoUrl) {
      recordMarketplaceRepo(slug, repoUrl, row.installs);
      recordMarketplaceRepo(row.name, repoUrl, row.installs);
    }
    items.set(id, {
      key: id,
      slug,
      name: row.name,
      source,
      url,
      repoUrl,
      site,
      installs: row.installs,
    });
  }
  return {
    items: [...items.values()],
    total: data.total,
    hasMore: !query && !!data.hasMore,
  };
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
  if (item.site) {
    const matches = skills.filter(
      (skill) =>
        skill.source.type === "website" && skill.source.url === item.url,
    );
    return matches.length === 1 ? matches[0] : undefined;
  }
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

const repoCache = new Map<string, Promise<Skill>>();

export function canInstallMarketplace(item: MarketplaceItem) {
  return !!item.repoUrl || (!!item.site && "__TAURI_INTERNALS__" in window);
}

export type MarketplaceDocument = Pick<Skill, "description" | "skillMdPreview">;

export type MarketplacePreview = Pick<
  Skill,
  "name" | "description" | "descriptionZh" | "skillMdPreview"
> & {
  fileCount: number;
  skillPath?: string;
  audit: SkillAuditReport;
};

type CachedPreview = { at: number; result: MarketplacePreview };
const PREVIEW_STORAGE_KEY = "marketplace.previews.v1";
const previewCache = new Map<string, CachedPreview>();
const previewRequests = new Map<string, Promise<MarketplacePreview>>();
let previewCacheLoaded = false;
const cardPreviewQueue: (() => void)[] = [];
let activeCardPreviews = 0;
const siteDocuments = new Map<string, MarketplaceDocument>();

function previewFromSkill(skill: Skill): MarketplacePreview {
  return {
    name: skill.name,
    description: skill.description,
    descriptionZh: skill.descriptionZh,
    skillMdPreview: skill.skillMdPreview,
    fileCount: Object.keys(skill.files).length,
    skillPath: skill.source.type === "git" ? skill.source.skillPath : undefined,
    audit: auditSkillFiles(skill.files),
  };
}

function cachedPreview(item: MarketplaceItem) {
  if (!previewCacheLoaded) {
    previewCacheLoaded = true;
    try {
      const entries = JSON.parse(preference(PREVIEW_STORAGE_KEY, "[]")) as [
        string,
        CachedPreview,
      ][];
      for (const [key, entry] of entries) {
        if (
          Date.now() - entry.at < FEED_CACHE_MS &&
          typeof entry.result?.skillMdPreview === "string" &&
          Array.isArray(entry.result.audit?.findings)
        ) {
          previewCache.set(key, entry);
        }
      }
    } catch {
      previewCache.clear();
    }
  }
  const entry = previewCache.get(item.key);
  if (entry && Date.now() - entry.at < FEED_CACHE_MS) return entry;
}

export function getCachedMarketplacePreview(item: MarketplaceItem) {
  return cachedPreview(item)?.result;
}

function savePreview(item: MarketplaceItem, result: MarketplacePreview) {
  previewCache.delete(item.key);
  if (previewCache.size >= 32)
    previewCache.delete(previewCache.keys().next().value!);
  previewCache.set(item.key, { at: Date.now(), result });
  const entries: string[] = [];
  let remaining = 250_000;
  for (const entry of [...previewCache].reverse()) {
    const serialized = JSON.stringify(entry);
    if (serialized.length > remaining) continue;
    remaining -= serialized.length;
    entries.unshift(serialized);
  }
  remember(PREVIEW_STORAGE_KEY, `[${entries.join(",")}]`);
}

export async function loadMarketplacePreview(
  item: MarketplaceItem,
  inspectGit: Parameters<typeof inspectInstallSource>[1],
): Promise<MarketplacePreview> {
  if (!canInstallMarketplace(item)) throw Error("marketExternalSource");
  const saved = cachedPreview(item);
  if (saved && Date.now() - saved.at < FEED_FRESH_MS) return saved.result;

  if (item.repoUrl) {
    try {
      return await loadMarketplaceSnapshot(item);
    } catch (error) {
      if (saved) throw error;
    }
  }
  const result = previewFromSkill(await loadMarketplaceRepo(item, inspectGit));
  savePreview(item, result);
  return result;
}

function loadMarketplaceSnapshot(item: MarketplaceItem) {
  const pending = previewRequests.get(item.key);
  if (pending) return pending;
  const request = fetchMarketplacePreview(item)
    .then((result) => {
      savePreview(item, result);
      return result;
    })
    .finally(() => previewRequests.delete(item.key));
  previewRequests.set(item.key, request);
  return request;
}

export async function loadMarketplaceCardDocument(
  item: MarketplaceItem,
  signal: AbortSignal,
): Promise<MarketplaceDocument | undefined> {
  const saved =
    getCachedMarketplacePreview(item) ?? siteDocuments.get(item.key);
  if (saved) return saved;
  if (activeCardPreviews < 4) activeCardPreviews++;
  else await new Promise<void>((resolve) => cardPreviewQueue.push(resolve));
  try {
    if (signal.aborted) return;
    const current =
      getCachedMarketplacePreview(item) ?? siteDocuments.get(item.key);
    if (current) return current;
    // Cards share the drawer's snapshot request. Only opening the drawer can
    // fall back to inspecting a whole skill directory.
    if (item.repoUrl) return await loadMarketplaceSnapshot(item);
    const result = await invoke<MarketplaceDocument>("site_skill_document", {
      domain: item.site,
      slug: item.slug,
    });
    if (siteDocuments.size >= 32)
      siteDocuments.delete(siteDocuments.keys().next().value!);
    siteDocuments.set(item.key, result);
    return result;
  } finally {
    const next = cardPreviewQueue.shift();
    if (next) next();
    else activeCardPreviews--;
  }
}

async function fetchMarketplacePreview(
  item: MarketplaceItem,
): Promise<MarketplacePreview> {
  const path = [...item.source.split("/"), item.slug]
    .map(encodeURIComponent)
    .join("/");
  const data: { files?: unknown } =
    "__TAURI_INTERNALS__" in window
      ? await invoke("marketplace_preview", {
          source: item.source,
          slug: item.slug,
        })
      : await fetch(`/marketplace-api/download/${path}`, {
          signal: AbortSignal.timeout(8_000),
        }).then(async (res) => {
          if (!res.ok) throw Error("marketRepoUnavailable");
          const body = await res.text();
          if (body.length > 2 * 1024 * 1024)
            throw Error("marketRepoUnavailable");
          return JSON.parse(body);
        });

  if (!Array.isArray(data.files)) throw Error("marketRepoUnavailable");
  const files = Object.fromEntries(
    data.files.map(({ path, contents }) => {
      if (typeof path !== "string" || typeof contents !== "string")
        throw Error("marketRepoUnavailable");
      return [path, pack(contents)];
    }),
  );
  return {
    ...meta(files),
    fileCount: Object.keys(files).length,
    audit: auditSkillFiles(files),
  };
}

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
  inspectGit: Parameters<typeof inspectInstallSource>[1],
): Promise<Skill> {
  const source: InstallSource | undefined = item.repoUrl
    ? { url: item.repoUrl, repo: item.source, slug: item.slug }
    : item.site
      ? { site: item.site, url: item.url, slug: item.slug }
      : undefined;
  if (!source) throw Error("marketExternalSource");
  let pending = repoCache.get(item.key);
  if (!pending) {
    const request = inspectInstallSource(source, inspectGit).then(
      ({ skills }) => skills[0],
    );
    pending = request;
    repoCache.set(item.key, request);
    const expire = () => {
      if (repoCache.get(item.key) === request) repoCache.delete(item.key);
    };
    void request.then(() => window.setTimeout(expire, 60_000), expire);
  }
  return pending;
}
