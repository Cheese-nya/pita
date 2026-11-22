import {
  agents,
  globalTarget,
  projectTarget,
  type Workspace,
  type Skill,
} from "../types/workspace";
import { DEFAULT_ENABLED_AGENTS } from "./settings";
import {
  fixtureTree,
  makeSkill,
  pack,
  unpack,
  hash,
  changedFiles,
} from "./tree";
import { translateDescription } from "./translator";
const catalog = [
  [
    "accessibility-audit",
    "access",
    "Inspect focus order, contrast and accessible names across an interface.",
    "Review the keyboard path.",
    "studio-tools/interface-kit",
  ],
  [
    "api-design",
    "braces",
    "Design consistent REST resources and document their contracts.",
    "List endpoints and invariants.",
    "studio-tools/engineering",
  ],
  [
    "browser-testing",
    "globe",
    "Exercise browser workflows and capture reproducible failures.",
    "Select a representative user journey.",
    "microsoft/playwright-tools",
  ],
  [
    "code-review",
    "review",
    "Review changes for correctness, readability and missing edge cases.",
    "Read the patch in context.",
    "studio-tools/engineering",
  ],
  [
    "commit-craft",
    "commit",
    "Draft concise commit messages from staged changes.",
    "Group related changes.",
    "devtools/git-toolkit",
  ],
  [
    "design-tokens",
    "palette",
    "Maintain semantic design tokens across light and dark themes.",
    "Compare both palettes.",
    "studio-tools/interface-kit",
  ],
  [
    "doc-writer",
    "doc",
    "Turn project notes into structured technical documentation.",
    "Identify the intended reader.",
    "local",
  ],
  [
    "frontend-design",
    "layout",
    "Build polished, accessible interfaces with deliberate typography and spacing.",
    "Inspect the visual hierarchy.",
    "anthropics/skills",
  ],
  [
    "git-workflow",
    "branch",
    "Prepare clean feature branches and review repository history.",
    "Inspect the working tree.",
    "devtools/git-toolkit",
  ],
  [
    "markdown-tools",
    "text",
    "Format Markdown and validate document structure.",
    "Read the heading outline.",
    "unknown",
  ],
  [
    "pdf-toolkit",
    "pdf",
    "Inspect PDF pages, extract tables and assemble documents.",
    "Check the document dimensions.",
    "anthropics/skills",
  ],
  [
    "release-notes",
    "tag",
    "Organize user-facing release notes by feature and fix.",
    "Collect changes since the last tag.",
    "local",
  ],
  [
    "test-driven-dev",
    "flask",
    "Design focused regression cases from observable requirements.",
    "Specify the failing behavior.",
    "studio-tools/engineering",
  ],
  [
    "web-performance",
    "speed",
    "Profile loading and rendering costs in web applications.",
    "Record a representative trace.",
    "studio-tools/interface-kit",
  ],
];
export async function createSeed(): Promise<Workspace> {
  const now = new Date(),
    day = (n: number) => new Date(+now - n * 86400000).toISOString();
  const skills = await Promise.all(
    catalog.map(async ([name, glyph, desc, step, repo], i) => {
      const files = fixtureTree(name, desc, step),
        sha = await hash(files);
      const s = await makeSkill(
        files,
        repo === "local"
          ? { type: "local", originPath: "~/Documents/skills/" + name }
          : repo === "unknown"
            ? { type: "unknown" }
            : {
                type: "git",
                repoUrl: "https://github.com/" + repo,
                skillPath: "skills/" + name,
                ref: "main",
                commit: sha.slice(0, 40),
              },
        glyph,
      );
      s.installedAt = day(24 - i);
      s.descriptionZh = translateDescription(s.name, s.description);
      s.cumulativeEnabledHours = 12 + i * 5;
      s.pinned = i === 10;
      if ([2, 7].includes(i)) {
        const next = {
          ...files,
          "SKILL.md": pack(
            unpack(files["SKILL.md"]).replace(
              step,
              step + " Verify the result at two viewport sizes.",
            ),
          ),
        };
        s.upstream = { files: next, commit: (await hash(next)).slice(0, 40) };
        s.hasUpdate = true;
        s.updateSummary = {
          currentCommit: sha.slice(0, 40),
          latestCommit: s.upstream.commit,
          changedFiles: changedFiles(files, next),
          diffText:
            "-" +
            step +
            "\n+" +
            step +
            " Verify the result at two viewport sizes.",
        };
      }
      // Seed realistic staggered deployments across the 8 default-enabled agents
      const densityByAgent: Record<string, (idx: number) => boolean> = {
        "claude-code": (idx) => idx !== 9 && idx !== 11, // ~12 skills (~350+ tok, triggers default 320 tok budget cue)
        codex: (idx) => idx % 5 !== 4, // ~11 skills
        antigravity: (idx) => idx % 4 !== 3, // ~10 skills
        qoder: (idx) => idx % 3 !== 2, // ~9 skills
        workbuddy: (idx) => idx % 2 === 0 || idx === 3 || idx === 7, // ~8 skills
        "t3-code": (idx) => [0, 1, 2, 3, 5, 7, 12, 13].includes(idx), // 8 skills
        "gemini-cli": (idx) => [0, 1, 3, 6, 7, 9, 13].includes(idx), // 7 skills
        opencode: (idx) => [1, 3, 4, 8, 12].includes(idx), // 5 skills
      };
      for (const a of DEFAULT_ENABLED_AGENTS) {
        const include = densityByAgent[a]?.(i) ?? false;
        if (!include) continue;
        s.deployments.push({
          scope: globalTarget(a),
          agentId: a,
          status:
            i === 6 && a === "antigravity"
              ? "disabled-staging"
              : i === 4 && a === "claude-code"
                ? "disabled-native"
                : i === 9 && a === "workbuddy"
                  ? "disabled-staging"
                  : "enabled",
          installedHash: sha,
          drifted: false,
          manual: true,
        });
      }
      if (i === 6 && !s.deployments.some((d) => d.agentId === "antigravity"))
        s.deployments.push({
          scope: globalTarget("antigravity"),
          agentId: "antigravity",
          status: "disabled-staging",
          installedHash: sha,
          drifted: false,
          manual: true,
        });
      s.events = s.deployments.map((d) => ({
        at: day(2 + i / 4),
        action: d.status,
        target: "global/" + d.agentId,
      }));
      if (s.deployments.some((d) => d.status === "enabled"))
        s.enabledSince = now.toISOString();
      return s;
    }),
  );
  const projects = [
    {
      id: "atlas",
      name: "atlas-web",
      path: "~/Projects/atlas-web",
      enabledAgents: [agents[0], agents[1], agents[3]],
      isGitRepo: true,
    },
    {
      id: "studio",
      nativeOverrides: [],
      name: "studio-kit",
      path: "~/Projects/studio-kit",
      enabledAgents: [agents[1], agents[2], agents[5]],
      isGitRepo: true,
    },
  ];
  const front = ["frontend-design", "design-tokens", "accessibility-audit"],
    engineering = ["code-review", "git-workflow", "browser-testing"];
  const presets = [
    {
      id: "frontend",
      name: "@frontend",
      color: "accent",
      skillIds: front,
      updatedAt: day(1),
    },
    {
      id: "engineering",
      name: "@engineering",
      color: "ok",
      skillIds: engineering,
      updatedAt: day(3),
    },
  ];
  const bindings: Workspace["bindings"] = [
    {
      presetId: "frontend",
      target: projectTarget("atlas"),
      appliedIds: [front[0], front[1], "git-workflow"],
      appliedAt: day(3),
      outOfSync: true,
    },
    {
      presetId: "engineering",
      target: projectTarget("atlas"),
      appliedIds: engineering,
      appliedAt: day(3),
      outOfSync: false,
    },
  ];
  for (const id of new Set(bindings.flatMap((b) => b.appliedIds)))
    for (const a of projects[0].enabledAgents) {
      const s = skills.find((s) => s.id === id)!;
      s.deployments.push({
        scope: projectTarget("atlas"),
        agentId: a,
        status: "enabled",
        installedHash: s.centralHash,
        drifted: false,
        manual: false,
        gitTrackedInProject: true,
      });
    }
  const d = skills[5].deployments.find((d) => d.scope.kind === "project")!;
  d.files = {
    ...skills[5].files,
    "SKILL.md": pack(
      unpack(skills[5].files["SKILL.md"]) + "\nUse the Atlas palette.\n",
    ),
  };
  d.installedHash = await hash(d.files);
  d.drifted = true;
  const doc: Skill = skills[6];
  doc.deployments.push({
    scope: projectTarget("studio"),
    agentId: "codex",
    installedHash: doc.centralHash,
    status: "enabled",
    manual: true,
    drifted: false,
    gitTrackedInProject: true,
  });
  return {
    skills,
    projects,
    presets,
    bindings,
    snapshots: [],
    checkedAt: day(1),
    scannedAt: now.toISOString(),
    root: "~/.pita/",
    remote: null,
  };
}
