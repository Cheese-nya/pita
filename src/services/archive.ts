import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { z } from "zod";
import type { Files, Skill, Workspace } from "../types/workspace";
import type { AgentId, ProjectWorkspace } from "../types/domain";
import { decode, encode, makeSkill, hash, normalize } from "./tree";
import { getSettings } from "./settings";
import { createSeed } from "./seed";
export type RestoreData = Pick<
  Workspace,
  "skills" | "presets" | "projects" | "bindings"
>;
export interface RestorePlan {
  data: RestoreData;
  added: Skill[];
  replaced: Skill[];
  skipped: Skill[];
  bundled: Skill[];
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
function restoreFingerprint(s: Skill) {
  return JSON.stringify(
    canonical([
      s.centralHash,
      s.source,
      s.pinned,
      s.deployments,
      s.installedAt,
      s.events,
      s.enabledSince,
      s.cumulativeEnabledHours,
    ]),
  );
}
const builtinAgent = z.enum([
  "claude-code",
  "codex",
  "antigravity",
  "dsh",
  "qoder",
  "workbuddy",
  "t3-code",
  "gemini-cli",
  "opencode",
  "windsurf",
  "codex-cli",
  "claude-cli",
  "antigravity-cli",
  "trae",
  "hermes",
  "pi",
  "openclaw",
]);
const customAgent = z
  .string()
  .regex(
    /^custom:[a-z0-9][a-z0-9_-]{0,47}$/,
  ) as unknown as z.ZodType<`custom:${string}`>;
const agent = z.union([builtinAgent, customAgent]);
const scope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global-agent"), agentId: agent }),
  z.object({ kind: z.literal("project"), projectId: z.string() }),
]);
const files = z.record(z.string(), z.string());
const sha = z.string().regex(/^[\da-f]{64}$/);
const source = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("git"),
    repoUrl: z.url(),
    commit: z.string(),
    ref: z.string(),
    skillPath: z.string(),
  }),
  z.object({ type: z.literal("local"), originPath: z.string().optional() }),
  z.object({ type: z.literal("website"), url: z.url() }),
  z.object({ type: z.literal("unknown") }),
]);
const entry = z.object({
  id: z.string().regex(/^[\p{L}\p{N}_.-]+$/u),
  origin: source,
  computedHash: sha,
  bundled: z.boolean(),
  pinned: z.boolean(),
  glyph: z.string(),
  installedAt: z.iso.datetime(),
  cumulativeEnabledHours: z.number(),
  enabledSince: z.iso.datetime().optional(),
  deployments: z.array(
    z.object({
      scope,
      agentId: agent,
      status: z.enum(["enabled", "disabled-native", "disabled-staging"]),
      manual: z.boolean(),
      pausedByProject: z.boolean().optional(),
      installedHash: sha,
      drifted: z.boolean(),
      files: files.optional(),
      gitTrackedInProject: z.boolean().optional(),
    }),
  ),
  events: z.array(
    z.object({ at: z.iso.datetime(), action: z.string(), target: z.string() }),
  ),
});
const schema = z.object({
  version: z.literal(1),
  skills: z.array(entry),
  projects: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      path: z.string(),
      enabledAgents: z.array(agent),
      nativeOverrides: z.array(agent).optional(),
      isGitRepo: z.boolean(),
    }),
  ),
  presets: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      color: z.string(),
      skillIds: z.array(z.string()),
      updatedAt: z.iso.datetime(),
    }),
  ),
  bindings: z.array(
    z.object({
      presetId: z.string(),
      target: scope,
      appliedIds: z.array(z.string()),
      appliedAt: z.iso.datetime(),
      outOfSync: z.boolean(),
    }),
  ),
});
let seeds: ReturnType<typeof createSeed> | undefined;
async function refTree(s: Skill["source"]) {
  if (s.type !== "git") return;
  const seed = await (seeds ??= createSeed());
  const original = seed.skills.find(
    (x) =>
      x.source.type === "git" &&
      x.source.repoUrl === s.repoUrl &&
      x.source.skillPath === s.skillPath,
  );
  if (original?.source.type === "git" && original.source.commit === s.commit)
    return original.files;
  if (original?.upstream?.commit === s.commit) return original.upstream.files;
}
export async function manifest(w: Workspace) {
  const skills = await Promise.all(
    w.skills.map(async (s) => {
      const tree = await refTree(s.source);
      const bundled = !tree || (await hash(tree)) !== s.centralHash;
      return {
        id: s.id,
        origin: s.source,
        source:
          s.source.type === "git"
            ? s.source.repoUrl
            : s.source.type === "local"
              ? (s.source.originPath ?? null)
              : s.source.type === "website"
                ? s.source.url
                : null,
        sourceType: s.source.type,
        skillPath: s.source.type === "git" ? s.source.skillPath : s.id,
        computedHash: s.centralHash,
        bundled,
        pinned: s.pinned,
        glyph: s.glyph,
        installedAt: s.installedAt,
        cumulativeEnabledHours: s.cumulativeEnabledHours,
        enabledSince: s.enabledSince,
        deployments: s.deployments,
        events: s.events,
      };
    }),
  );
  return {
    version: 1,
    skills,
    projects: w.projects,
    presets: w.presets,
    bindings: w.bindings,
  };
}
export async function archive(w: Workspace) {
  const m = await manifest(w);
  const entries: Record<string, Uint8Array> = {
    "skills-lock.json": strToU8(JSON.stringify(m, null, 2)),
  };
  for (const [i, s] of w.skills.entries())
    if (m.skills[i].bundled)
      for (const [p, v] of Object.entries(s.files))
        entries["local-skills/" + s.id + "/" + p] = decode(v);
  return zipSync(entries);
}
export async function restore(
  bytes: Uint8Array,
  current: Workspace,
): Promise<RestorePlan> {
  try {
    const entries = unzipSync(bytes),
      m = schema.parse(JSON.parse(strFromU8(entries["skills-lock.json"])));
    const skills = await Promise.all(
      m.skills.map(async (row) => {
        const prefix = "local-skills/" + row.id + "/";
        const tree = row.bundled
          ? Object.fromEntries(
              Object.entries(entries)
                .filter(([k]) => k.startsWith(prefix) && !k.endsWith("/"))
                .map(([k, v]) => [k.slice(prefix.length), encode(v)]),
            )
          : await refTree(row.origin);
        if (!tree || (await hash(tree)) !== row.computedHash) throw Error();
        const s = await makeSkill(tree, row.origin, row.glyph);
        if (s.id !== row.id) throw Error();
        Object.assign(s, {
          pinned: row.pinned,
          installedAt: row.installedAt,
          cumulativeEnabledHours: row.cumulativeEnabledHours,
          enabledSince: row.enabledSince,
          deployments: row.deployments,
          events: row.events,
        });
        for (const d of s.deployments)
          if (
            d.installedHash !==
              (d.files ? await hash(d.files) : s.centralHash) ||
            d.drifted !== (d.installedHash !== s.centralHash)
          )
            throw Error();
        const seed = (await (seeds ??= createSeed())).skills.find(
          (o) => o.id === s.id,
        );
        if (
          seed?.upstream &&
          s.source.type === "git" &&
          seed.source.type === "git" &&
          s.source.repoUrl === seed.source.repoUrl &&
          s.source.commit === seed.source.commit
        )
          Object.assign(s, {
            upstream: seed.upstream,
            hasUpdate: true,
            updateSummary: seed.updateSummary,
          });
        return s;
      }),
    );
    const ids = new Set(skills.map((s) => s.id)),
      targets = new Set(m.projects.map((p) => p.id));
    const validScope = (t: z.infer<typeof scope>) =>
      t.kind === "global-agent" || targets.has(t.projectId);
    if (
      ids.size !== skills.length ||
      m.presets.some((p) => p.skillIds.some((id) => !ids.has(id))) ||
      m.bindings.some(
        (b) =>
          !validScope(b.target) ||
          !m.presets.some((p) => p.id === b.presetId) ||
          b.appliedIds.some((id) => !ids.has(id)),
      ) ||
      skills.some((s) => s.deployments.some((d) => !validScope(d.scope)))
    )
      throw Error();
    const added: Skill[] = [],
      replaced: Skill[] = [],
      skipped: Skill[] = [];
    for (const s of skills) {
      const old = current.skills.find((x) => x.id === s.id);
      if (!old) added.push(s);
      else if (restoreFingerprint(old) === restoreFingerprint(s))
        skipped.push(s);
      else replaced.push(s);
    }
    return {
      data: {
        skills: [...added, ...replaced],
        projects: m.projects,
        presets: m.presets,
        bindings: m.bindings,
      },
      added,
      replaced,
      skipped,
      bundled: skills.filter((_, i) => m.skills[i].bundled),
    };
  } catch {
    throw Error("invalidBundle");
  }
}
export async function importTrees(entries: Files, local: boolean) {
  const normalized: Files = Object.create(null);
  const paths = new Set<string>();
  for (const [path, content] of Object.entries(entries)) {
    const parts = path
      .replaceAll("\\", "/")
      .split("/")
      .filter((p) => p !== ".");
    if (parts.some((part) => !part || part === ".." || /[:\u0000]/.test(part)))
      throw Error("invalidBundle");
    if (parts[0] === "__MACOSX" || parts.at(-1) === ".DS_Store") continue;
    if (parts.at(-1)?.toLowerCase() === "skill.md")
      parts[parts.length - 1] = "SKILL.md";
    const key = parts.join("/");
    if (!key || paths.has(key.toLowerCase())) throw Error("invalidBundle");
    paths.add(key.toLowerCase());
    normalized[key] = content;
  }
  entries = normalized;
  const roots = Object.keys(entries)
    .filter((p) => p === "SKILL.md" || p.endsWith("/SKILL.md"))
    .map((p) => p.slice(0, -8));
  if (!roots.length) throw Error("invalidSkill");
  const parsed = await Promise.allSettled(
    roots.map(async (root) => {
      const tree = Object.fromEntries(
        Object.entries(entries)
          .filter(
            ([p]) =>
              p.startsWith(root) &&
              !roots.some(
                (r) => r !== root && r.startsWith(root) && p.startsWith(r),
              ),
          )
          .map(([p, v]) => [p.slice(root.length), v]),
      );
      const payloads = Object.values(tree);
      const sizes = payloads.map(
        (content) =>
          Math.floor((content.length * 3) / 4) -
          (content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0),
      );
      if (
        payloads.length > 200 ||
        sizes.some((size) => size > 2 * 1024 * 1024) ||
        sizes.reduce((sum, size) => sum + size, 0) > 10 * 1024 * 1024
      )
        throw Error("sourceTooLarge");
      return makeSkill(tree, {
        type: "local",
        originPath: local ? root.replace(/\/$/, "") : undefined,
      });
    }),
  );
  const skills: Skill[] = [],
    rejected: string[] = [];
  parsed.forEach((r, index) => {
    if (r.status === "fulfilled") skills.push(r.value);
    else rejected.push(roots[index] + "SKILL.md");
  });
  if (!skills.length) throw Error("invalidSkill");
  return { skills, rejected };
}
export type DetectedProject = ProjectWorkspace & {
  detectedSkills?: { id: string; agentId: AgentId }[];
};

export function detectProjects(
  paths: string[],
  batch: boolean,
): DetectedProject[] {
  const matches = new Map<string, Set<AgentId>>();
  const skillMatches = new Map<string, Map<string, AgentId>>();
  const customByDot = new Map(
    getSettings().customHarnesses.map((h) => [h.projectDir, h.id]),
  );
  for (const path of paths) {
    const parts = path.split("/"),
      len = batch ? 2 : 1;
    if (parts.length <= len) continue;
    const root = parts.slice(0, len).join("/"),
      dot = parts[len],
      found = matches.get(root) ?? new Set();
    let agent: AgentId | undefined;
    if (dot === ".claude") agent = "claude-code";
    else if (dot === ".codex" || dot === ".agents") agent = "codex";
    else if (dot === ".agent") agent = "antigravity";
    else if (dot === ".dsh") agent = "dsh";
    else if (dot === ".qoder") agent = "qoder";
    else if (dot === ".workbuddy") agent = "workbuddy";
    else if (dot === ".t3code") agent = "t3-code";
    else if (dot === ".gemini") agent = "gemini-cli";
    else if (dot === ".opencode") agent = "opencode";
    else if (dot === ".windsurf") agent = "windsurf";
    else if (dot === ".codex-cli") agent = "codex-cli";
    else if (dot === ".claude-cli") agent = "claude-cli";
    else if (dot === ".agent-cli") agent = "antigravity-cli";
    else if (dot === ".trae") agent = "trae";
    else if (dot === ".hermes") agent = "hermes";
    else if (dot === ".pi") agent = "pi";
    else if (dot === ".openclaw") agent = "openclaw";
    else if (customByDot.has(dot)) agent = customByDot.get(dot);
    if (agent) {
      found.add(agent);
      matches.set(root, found);
      if (parts[len + 1] === "skills" && parts.length > len + 3) {
        const skillId = normalize(parts[len + 2]);
        if (skillId) {
          const byProject = skillMatches.get(root) ?? new Map();
          byProject.set(skillId + ":" + agent, agent);
          skillMatches.set(root, byProject);
        }
      }
    }
  }
  return Array.from(matches, ([path, a]) => {
    const byProject = skillMatches.get(path);
    const detectedSkills = byProject
      ? Array.from(byProject.entries()).map(([key, agentId]) => ({
          id: key.split(":")[0],
          agentId,
        }))
      : [];
    return {
      id: normalize(path) + "-" + crypto.randomUUID().slice(0, 6),
      name: path.split("/").at(-1)!,
      path,
      enabledAgents: [...a],
      isGitRepo: paths.some((p) => p.startsWith(path + "/.git/")),
      detectedSkills,
    };
  });
}
