import type { Files, Skill } from "../types/workspace";
import { unpack } from "./tree";

export type AuditRisk = "safe" | "caution" | "high";

export interface AuditFinding {
  severity: "high" | "caution";
  code: string;
  file: string;
  detail: string;
}

export interface SkillAuditReport {
  risk: AuditRisk;
  requiresCredentials: string[];
  executableFiles: string[];
  findings: AuditFinding[];
}

const EXECUTABLE_EXTS = [
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".ps1",
  ".psm1",
  ".bat",
  ".cmd",
  ".py",
  ".rb",
  ".pl",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".command",
];

const CREDENTIAL_PATTERNS: [string, string][] = [
  ["OPENAI_API_KEY", "OPENAI_API_KEY"],
  ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"],
  ["GEMINI_API_KEY", "GEMINI_API_KEY"],
  ["GOOGLE_API_KEY", "GOOGLE_API_KEY"],
  ["GITHUB_TOKEN", "GITHUB_TOKEN"],
  ["GH_TOKEN", "GH_TOKEN"],
  ["GITLAB_TOKEN", "GITLAB_TOKEN"],
  ["SLACK_TOKEN", "SLACK_TOKEN"],
  ["SLACK_BOT_TOKEN", "SLACK_BOT_TOKEN"],
  ["NOTION_API_KEY", "NOTION_API_KEY"],
  ["NOTION_TOKEN", "NOTION_TOKEN"],
  ["LINEAR_API_KEY", "LINEAR_API_KEY"],
  ["FIGMA_TOKEN", "FIGMA_TOKEN"],
  ["FIGMA_ACCESS_TOKEN", "FIGMA_ACCESS_TOKEN"],
  ["STRIPE_API_KEY", "STRIPE_API_KEY"],
  ["SUPABASE_KEY", "SUPABASE_KEY"],
  ["SUPABASE_ANON_KEY", "SUPABASE_ANON_KEY"],
  ["AWS_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"],
  ["AWS_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY"],
  ["DATABASE_URL", "DATABASE_URL"],
  ["API_KEY", "API Key"],
  ["ACCESS_TOKEN", "Access Token"],
  ["CLIENT_SECRET", "OAuth Client Secret"],
];

export function auditSkillFiles(files: Files): SkillAuditReport {
  const credentials = new Set<string>();
  const executables = new Set<string>();
  const findings: AuditFinding[] = [];
  let hasHigh = false;
  let hasCaution = false;

  for (const [path, b64] of Object.entries(files)) {
    let text = "";
    try {
      text = unpack(b64);
    } catch {
      text = "";
    }
    const lowerPath = path.toLowerCase();
    const hasShebang = text.trimStart().startsWith("#!");
    const isScript =
      EXECUTABLE_EXTS.some((ext) => lowerPath.endsWith(ext)) || hasShebang;

    if (isScript) {
      executables.add(path);
      hasCaution = true;
      findings.push({
        severity: "caution",
        code: "scriptFile",
        file: path,
        detail: hasShebang
          ? "Executable script with shebang"
          : "Executable or script asset",
      });
    }

    for (const [pat, label] of CREDENTIAL_PATTERNS) {
      if (text.includes(pat)) credentials.add(label);
    }

    const lower = text.toLowerCase();
    if (lowerPath === "skill.md") {
      if (
        (lower.includes("api key") ||
          lower.includes("api_key") ||
          lower.includes("bearer token")) &&
        credentials.size === 0
      ) {
        credentials.add("API Key");
      }
      if (
        lower.includes("oauth") &&
        !Array.from(credentials).some((c) => c.includes("OAuth"))
      ) {
        credentials.add("OAuth Account");
      }
    }

    if (
      (lower.includes("curl ") || lower.includes("wget ")) &&
      (lower.includes("| sh") ||
        lower.includes("| bash") ||
        lower.includes("| zsh") ||
        lower.includes("|sh") ||
        lower.includes("|bash"))
    ) {
      hasHigh = true;
      findings.push({
        severity: "high",
        code: "pipeShell",
        file: path,
        detail: "Downloads and pipes remote content directly into shell",
      });
    }

    if (
      lower.includes("invoke-expression") ||
      lower.includes("iex (") ||
      lower.includes("iex(")
    ) {
      hasHigh = true;
      findings.push({
        severity: "high",
        code: "pipeShell",
        file: path,
        detail: "Dynamic PowerShell Invoke-Expression execution",
      });
    }

    if (
      lower.includes("rm -rf /") ||
      lower.includes("rm -rf ~") ||
      lower.includes("rm -rf $home") ||
      lower.includes("del /f /s /q c:\\")
    ) {
      hasHigh = true;
      findings.push({
        severity: "high",
        code: "destructiveDelete",
        file: path,
        detail: "Destructive recursive delete targeting root or home directory",
      });
    }

    if (
      (lower.includes("~/.ssh") ||
        lower.includes(".ssh/id_") ||
        lower.includes("~/.aws/credentials") ||
        lower.includes("~/.gnupg")) &&
      (lower.includes("curl") ||
        lower.includes("wget") ||
        lower.includes("fetch(") ||
        lower.includes("http://") ||
        lower.includes("https://"))
    ) {
      hasHigh = true;
      findings.push({
        severity: "high",
        code: "secretExfil",
        file: path,
        detail: "References sensitive local credentials alongside network transfer",
      });
    }

    if (
      (lower.includes("base64 -d") || lower.includes("base64 --decode")) &&
      (lower.includes("| sh") ||
        lower.includes("| bash") ||
        lower.includes("eval ") ||
        lower.includes("exec("))
    ) {
      hasHigh = true;
      findings.push({
        severity: "high",
        code: "obfuscatedExec",
        file: path,
        detail: "Decodes obfuscated payload into shell or eval",
      });
    }

    if (
      isScript &&
      (lower.includes("curl ") ||
        lower.includes("wget ") ||
        lower.includes("fetch(") ||
        lower.includes("requests.") ||
        lower.includes("urllib"))
    ) {
      hasCaution = true;
      findings.push({
        severity: "caution",
        code: "networkScript",
        file: path,
        detail: "Script initiates outbound network requests",
      });
    }
  }

  if (credentials.size > 0) hasCaution = true;

  return {
    risk: hasHigh ? "high" : hasCaution ? "caution" : "safe",
    requiresCredentials: Array.from(credentials),
    executableFiles: Array.from(executables),
    findings,
  };
}

export function auditSkill(skill: Pick<Skill, "files">): SkillAuditReport {
  return auditSkillFiles(skill.files);
}
