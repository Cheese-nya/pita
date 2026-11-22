import { fixtureTree, makeSkill } from "./tree";
import { translateDescription } from "./translator";

export type MarketplaceFeed = "all" | "trending" | "popular";

export interface MarketplaceItem {
  id: string;
  name: string;
  source: string;
  repoUrl: string;
  skillPath: string;
  description: string;
  workflowStep: string;
  installs: number;
  weeklyRank: number;
  popularRank: number;
  glyph: string;
  orgMark: string;
  orgTone: "neutral" | "warm" | "cool" | "sage" | "plum";
}

export const marketplaceCatalog: MarketplaceItem[] = [
  {
    id: "find-skills",
    name: "find-skills",
    source: "@vercel-labs/skills",
    repoUrl: "https://github.com/vercel-labs/skills",
    skillPath: "skills/find-skills",
    description:
      "Discover and evaluate installable agent skills across the skills.sh ecosystem.",
    workflowStep: "Search candidate skills and compare their scope.",
    installs: 4_520_000,
    weeklyRank: 2,
    popularRank: 1,
    glyph: "globe",
    orgMark: "VL",
    orgTone: "neutral",
  },
  {
    id: "hyperframes-cli",
    name: "hyperframes-cli",
    source: "@heygen-com/hyperframes",
    repoUrl: "https://github.com/heygen-com/hyperframes",
    skillPath: "skills/hyperframes-cli",
    description:
      "Compose, preview and render programmatic motion frames with the Hyperframes CLI.",
    workflowStep: "Inspect the timeline config before rendering.",
    installs: 1_740_000,
    weeklyRank: 1,
    popularRank: 3,
    glyph: "layout",
    orgMark: "HG",
    orgTone: "cool",
  },
  {
    id: "agent-browser",
    name: "agent-browser",
    source: "@vercel-labs/agent-browser",
    repoUrl: "https://github.com/vercel-labs/agent-browser",
    skillPath: "skills/agent-browser",
    description:
      "Automate headless browser navigation, DOM inspection and visual regression checks.",
    workflowStep: "Verify viewport layout and interactive elements.",
    installs: 1_630_000,
    weeklyRank: 4,
    popularRank: 2,
    glyph: "globe",
    orgMark: "VL",
    orgTone: "neutral",
  },
  {
    id: "hyperframes",
    name: "hyperframes",
    source: "@heygen-com/hyperframes",
    repoUrl: "https://github.com/heygen-com/hyperframes",
    skillPath: "skills/hyperframes",
    description:
      "Author HTML/CSS animation scenes and synchronized audio tracks for web video.",
    workflowStep: "Structure scene timing and cue transitions.",
    installs: 1_610_000,
    weeklyRank: 3,
    popularRank: 5,
    glyph: "layout",
    orgMark: "HG",
    orgTone: "cool",
  },
  {
    id: "grill-me",
    name: "grill-me",
    source: "@mattpocock/skills",
    repoUrl: "https://github.com/mattpocock/skills",
    skillPath: "skills/grill-me",
    description:
      "Stress-test feature specs and architecture trade-offs through focused interview questions.",
    workflowStep: "Identify unresolved decisions and walk through each branch.",
    installs: 1_580_000,
    weeklyRank: 6,
    popularRank: 4,
    glyph: "review",
    orgMark: "MP",
    orgTone: "warm",
  },
  {
    id: "design-mobile-apps",
    name: "design-mobile-apps",
    source: "@designed-by-ai/skills",
    repoUrl: "https://github.com/designed-by-ai/skills",
    skillPath: "skills/design-mobile-apps",
    description:
      "Design mobile screen flows, touch targets and navigation patterns for iOS and Android.",
    workflowStep: "Check safe-area spacing and thumb reach zones.",
    installs: 1_560_000,
    weeklyRank: 5,
    popularRank: 6,
    glyph: "palette",
    orgMark: "DA",
    orgTone: "warm",
  },
  {
    id: "media-use",
    name: "media-use",
    source: "@heygen-com/hyperframes",
    repoUrl: "https://github.com/heygen-com/hyperframes",
    skillPath: "skills/media-use",
    description:
      "Inspect, transcode and assemble image, audio and video assets in agent workflows.",
    workflowStep: "Probe codec parameters before transforming assets.",
    installs: 1_510_000,
    weeklyRank: 8,
    popularRank: 8,
    glyph: "box",
    orgMark: "HG",
    orgTone: "cool",
  },
  {
    id: "reddit-automation",
    name: "reddit-automation",
    source: "@flowkit-labs/skills",
    repoUrl: "https://github.com/flowkit-labs/skills",
    skillPath: "skills/reddit-automation",
    description:
      "Gather subreddit discussions, summarize recurring pain points and track launches.",
    workflowStep: "Filter threads by signal and extract direct quotes.",
    installs: 1_490_000,
    weeklyRank: 11,
    popularRank: 10,
    glyph: "globe",
    orgMark: "FK",
    orgTone: "plum",
  },
  {
    id: "hyperframes-registry",
    name: "hyperframes-registry",
    source: "@heygen-com/hyperframes",
    repoUrl: "https://github.com/heygen-com/hyperframes",
    skillPath: "skills/hyperframes-registry",
    description:
      "Resolve reusable motion templates, shaders and caption presets from the registry.",
    workflowStep: "Match template aspect ratio to the target output.",
    installs: 1_420_000,
    weeklyRank: 9,
    popularRank: 12,
    glyph: "tag",
    orgMark: "HG",
    orgTone: "cool",
  },
  {
    id: "grill-with-docs",
    name: "grill-with-docs",
    source: "@mattpocock/skills",
    repoUrl: "https://github.com/mattpocock/skills",
    skillPath: "skills/grill-with-docs",
    description:
      "Cross-check implementation proposals against project documentation and constraints.",
    workflowStep: "Compare proposal assumptions against canonical docs.",
    installs: 1_390_000,
    weeklyRank: 10,
    popularRank: 11,
    glyph: "doc",
    orgMark: "MP",
    orgTone: "warm",
  },
  {
    id: "improve-codebase-architecture",
    name: "improve-codebase-architecture",
    source: "@mattpocock/skills",
    repoUrl: "https://github.com/mattpocock/skills",
    skillPath: "skills/improve-codebase-architecture",
    description:
      "Identify module coupling, boundary leaks and pragmatic refactoring steps.",
    workflowStep: "Map module dependencies before extracting boundaries.",
    installs: 1_330_000,
    weeklyRank: 7,
    popularRank: 9,
    glyph: "branch",
    orgMark: "MP",
    orgTone: "warm",
  },
  {
    id: "tdd",
    name: "tdd",
    source: "@mattpocock/skills",
    repoUrl: "https://github.com/mattpocock/skills",
    skillPath: "skills/tdd",
    description:
      "Drive feature development through red-green-refactor cycles with behavior-focused tests.",
    workflowStep: "Write one failing behavior assertion before editing code.",
    installs: 1_290_000,
    weeklyRank: 12,
    popularRank: 7,
    glyph: "flask",
    orgMark: "MP",
    orgTone: "warm",
  },
  {
    id: "frontend-design",
    name: "frontend-design",
    source: "@anthropics/skills",
    repoUrl: "https://github.com/anthropics/skills",
    skillPath: "skills/frontend-design",
    description:
      "Build polished, accessible interfaces with deliberate typography and spacing.",
    workflowStep: "Inspect the visual hierarchy.",
    installs: 1_240_000,
    weeklyRank: 13,
    popularRank: 13,
    glyph: "layout",
    orgMark: "AN",
    orgTone: "neutral",
  },
  {
    id: "handoff",
    name: "handoff",
    source: "@mattpocock/skills",
    repoUrl: "https://github.com/mattpocock/skills",
    skillPath: "skills/handoff",
    description:
      "Generate crisp session handoff notes capturing state, decisions and next actions.",
    workflowStep: "Summarize verified state and open follow-ups.",
    installs: 1_210_000,
    weeklyRank: 15,
    popularRank: 14,
    glyph: "doc",
    orgMark: "MP",
    orgTone: "warm",
  },
  {
    id: "prototype",
    name: "prototype",
    source: "@mattpocock/skills",
    repoUrl: "https://github.com/mattpocock/skills",
    skillPath: "skills/prototype",
    description:
      "Rapidly build clickable UI prototypes to validate interaction flows before backend work.",
    workflowStep: "Focus on real state transitions and edge cases.",
    installs: 1_160_000,
    weeklyRank: 14,
    popularRank: 16,
    glyph: "layout",
    orgMark: "MP",
    orgTone: "warm",
  },
  {
    id: "triage",
    name: "triage",
    source: "@mattpocock/skills",
    repoUrl: "https://github.com/mattpocock/skills",
    skillPath: "skills/triage",
    description:
      "Reproduce bug reports, narrow root causes and classify severity systematically.",
    workflowStep: "Capture a minimal reproduction before proposing fixes.",
    installs: 1_130_000,
    weeklyRank: 18,
    popularRank: 17,
    glyph: "review",
    orgMark: "MP",
    orgTone: "warm",
  },
  {
    id: "ui-taste",
    name: "ui-taste",
    source: "@uizze.sh/skills",
    repoUrl: "https://github.com/uizze/skills",
    skillPath: "skills/ui-taste",
    description:
      "Audit spacing, visual rhythm, contrast and micro-interaction polish in web apps.",
    workflowStep: "Review elevation hierarchy and interactive states.",
    installs: 1_110_000,
    weeklyRank: 16,
    popularRank: 15,
    glyph: "palette",
    orgMark: "UI",
    orgTone: "sage",
  },
  {
    id: "ai-video-generation",
    name: "ai-video-generation",
    source: "@101-skills/superpowers",
    repoUrl: "https://github.com/101-skills/superpowers",
    skillPath: "skills/ai-video-generation",
    description:
      "Structure prompts, camera motion cues and shot consistency for AI video pipelines.",
    workflowStep: "Define shot list and continuity constraints.",
    installs: 1_080_000,
    weeklyRank: 17,
    popularRank: 18,
    glyph: "speed",
    orgMark: "10",
    orgTone: "sage",
  },
  {
    id: "browser-testing",
    name: "browser-testing",
    source: "@microsoft/playwright-tools",
    repoUrl: "https://github.com/microsoft/playwright-tools",
    skillPath: "skills/browser-testing",
    description:
      "Exercise browser workflows and capture reproducible failures.",
    workflowStep: "Select a representative user journey.",
    installs: 980_000,
    weeklyRank: 19,
    popularRank: 19,
    glyph: "globe",
    orgMark: "MS",
    orgTone: "cool",
  },
  {
    id: "pdf-toolkit",
    name: "pdf-toolkit",
    source: "@anthropics/skills",
    repoUrl: "https://github.com/anthropics/skills",
    skillPath: "skills/pdf-toolkit",
    description: "Inspect PDF pages, extract tables and assemble documents.",
    workflowStep: "Check the document dimensions.",
    installs: 940_000,
    weeklyRank: 21,
    popularRank: 20,
    glyph: "pdf",
    orgMark: "AN",
    orgTone: "neutral",
  },
  {
    id: "domain-modeling",
    name: "domain-modeling",
    source: "@mattpocock/skills",
    repoUrl: "https://github.com/mattpocock/skills",
    skillPath: "skills/domain-modeling",
    description:
      "Encode invariants and illegal-state prevention into clean TypeScript domain types.",
    workflowStep: "Express state transitions as discriminated unions.",
    installs: 890_000,
    weeklyRank: 20,
    popularRank: 21,
    glyph: "braces",
    orgMark: "MP",
    orgTone: "warm",
  },
];

export function formatInstalls(n: number): string {
  if (n >= 1_000_000)
    return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

const GITHUB_AVATARS: Record<string, string> = {
  "vercel-labs": "/avatars/vercel-labs.png",
  "heygen-com": "/avatars/heygen-com.png",
  mattpocock: "/avatars/mattpocock.png",
  anthropics: "/avatars/anthropics.png",
  microsoft: "/avatars/microsoft.png",
  "designed-by-ai": "/avatars/designed-by-ai.svg",
  "flowkit-labs": "/avatars/flowkit-labs.svg",
  uizze: "/avatars/uizze.svg",
  "101-skills": "/avatars/101-skills.svg",
};

export function githubAvatarUrl(repoUrl: string): string | undefined {
  const m = repoUrl.match(/github\.com\/([^/]+)/i);
  if (!m) return undefined;
  const owner = m[1];
  return (
    GITHUB_AVATARS[owner.toLowerCase()] ??
    `https://github.com/${owner}.png?size=64`
  );
}

export function marketplaceSources(
  items: MarketplaceItem[] = marketplaceCatalog,
) {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.source, (counts.get(item.source) ?? 0) + item.installs);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([source]) => source);
}

export async function buildMarketplaceSkill(item: MarketplaceItem) {
  const skill = await makeSkill(
    fixtureTree(item.name, item.description, item.workflowStep),
    {
      type: "git",
      repoUrl: item.repoUrl,
      ref: "main",
      commit: "",
      skillPath: item.skillPath,
    },
    item.glyph,
  );
  skill.descriptionZh = translateDescription(item.name, item.description);
  if (skill.source.type === "git") {
    skill.source.commit = skill.centralHash.slice(0, 40);
  }
  return skill;
}
