import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { preference, remember } from "../i18n";
import { getSettings } from "./settings";

function isTauriNative(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

interface TranslateProxyResponse {
  ok: boolean;
  status: number;
  body?: { choices?: { message?: { content?: string } }[] };
  error?: string;
}

const CJK_RE = /[\u3400-\u9FFF]/;

export const BUILTIN_SKILL_ZH: Record<string, string> = {
  // 14 Central Library seed skills
  "accessibility-audit":
    "检查界面的焦点顺序、色彩对比度与无障碍语义名称，确保符合 WCAG 规范。",
  "api-design": "设计一致的 REST 资源接口，并规范化记录请求/响应契约与不变量。",
  "browser-testing": "执行真实浏览器交互流程，自动捕获并复现前端页面异常。",
  "code-review": "审查代码变更的正确性、可读性与潜在边界条件遗漏。",
  "commit-craft": "根据暂存区变更自动起草清晰、符合规范的 Git 提交信息。",
  "design-tokens": "跨浅色与深色主题维护语义化设计 Token 与视觉一致性。",
  "doc-writer": "将零散的项目笔记整理为结构清晰的技术文档与使用指南。",
  "frontend-design":
    "通过考究的排版、间距与视觉层级，构建精致且无障碍的现代界面。",
  "git-workflow": "整理干净的特性分支结构，规范化审查与维护仓库提交历史。",
  "markdown-tools": "格式化 Markdown 文本并校验标题大纲与文档结构完整性。",
  "pdf-toolkit": "解析 PDF 页面结构、提取表格数据并按需重组文档内容。",
  "release-notes": "按新特性与问题修复分类整理面向用户的版本发布说明。",
  "test-driven-dev": "从可观测的业务需求出发，编写聚焦行为验证的回归测试用例。",
  "web-performance": "分析 Web 应用的加载链路与渲染开销，定位前端性能瓶颈。",

  // Additional skills.sh marketplace catalog skills
  "find-skills": "在 skills.sh 生态中检索、发现并评估可安装的 Agent 技能。",
  "hyperframes-cli": "使用 Hyperframes CLI 编排、预览并渲染程序化动态视频帧。",
  "agent-browser": "自动化无头浏览器导航、DOM 结构检查与视觉回归校验。",
  hyperframes: "编写 HTML/CSS 动画场景与同步音轨，用于生成 Web 视频。",
  "grill-me": "通过聚焦的追问式访谈，对功能规格与架构权衡进行压力测试。",
  "design-mobile-apps":
    "设计 iOS 与 Android 移动端页面流、触控热区与导航模式。",
  "media-use": "在 Agent 工作流中检查、转码并拼装图片、音频与视频素材。",
  "reddit-automation":
    "采集 Subreddit 社区讨论，归纳高频痛点并追踪产品发布反馈。",
  "hyperframes-registry": "从注册中心解析可复用的动效模板、着色器与字幕预设。",
  "grill-with-docs": "对照项目权威文档与约束条件，交叉核验实现方案的合理性。",
  "improve-codebase-architecture":
    "识别模块耦合与边界泄漏，制定务实的渐进式重构步骤。",
  tdd: "通过「红-绿-重构」循环与行为导向测试驱动功能开发。",
  handoff: "生成简明扼要的会话交接记录，留存当前状态、关键决策与后续行动。",
  prototype: "在后端开发前快速构建可交互的 UI 原型以验证交互流程。",
  triage: "系统化复现缺陷报告、收敛根因范围并评估问题严重级别。",
  "ui-taste": "审计 Web 应用的留白间距、视觉节奏、对比度与微交互质感。",
  "ai-video-generation":
    "为 AI 视频生成管线构建分镜提示词、运镜指令与画面一致性约束。",
  "domain-modeling":
    "将业务不变量与非法状态拦截编码为严谨的 TypeScript 领域类型。",

  // Git inspection demo skills
  "readme-editor": "润色并重构项目 README 文档，提升可读性与上手清晰度。",
  "link-checker": "检查文档中的超链接与锚点引用，定位失效链接。",
};

const PHRASE_RULES: [RegExp, string][] = [
  [/^inspect\b/i, "检查并分析"],
  [/^review\b/i, "审查"],
  [/^design\b/i, "设计"],
  [/^build\b/i, "构建"],
  [/^automate\b/i, "自动化执行"],
  [/^discover\b/i, "发现并评估"],
  [/^generate\b/i, "生成"],
  [/^format\b/i, "格式化"],
  [/^organize\b/i, "整理并组织"],
  [/^profile\b/i, "分析并剖析"],
  [/^validate\b/i, "校验"],
  [/^maintain\b/i, "维护"],
  [/^extract\b/i, "提取"],
  [/^audit\b/i, "审计"],
  [/^check\b/i, "检查"],
  [/^edit\b/i, "编辑并优化"],
];

const TERM_RULES: [RegExp, string][] = [
  [/\baccessibility\b/gi, "无障碍"],
  [/\binterface(s)?\b/gi, "界面"],
  [/\bworkflow(s)?\b/gi, "工作流"],
  [/\bbrowser\b/gi, "浏览器"],
  [/\bdocument(ation|s)?\b/gi, "文档"],
  [/\brepository\b/gi, "仓库"],
  [/\bcomponent(s)?\b/gi, "组件"],
  [/\bperformance\b/gi, "性能"],
  [/\barchitecture\b/gi, "架构"],
  [/\btest(s|ing)?\b/gi, "测试"],
  [/\bdeployment(s)?\b/gi, "部署"],
  [/\bsecurity\b/gi, "安全"],
  [/\bcodebase\b/gi, "代码库"],
  [/\bskill(s)?\b/gi, "技能"],
  [/\bagent(s)?\b/gi, "Agent"],
];

export function hasChinese(text: string): boolean {
  return CJK_RE.test(text);
}

export function translateDescription(
  name: string,
  description: string,
): string {
  const trimmed = description.trim();
  if (!trimmed) return "";
  const key = name.trim().toLowerCase();
  if (BUILTIN_SKILL_ZH[key]) return BUILTIN_SKILL_ZH[key];
  if (hasChinese(trimmed)) return trimmed;

  let working = trimmed.replace(/\.$/, "");
  let prefix = "提供";
  for (const [re, zh] of PHRASE_RULES) {
    if (re.test(working)) {
      prefix = zh;
      working = working.replace(re, "").trim();
      break;
    }
  }
  const matchedTerms: string[] = [];
  for (const [re, zh] of TERM_RULES) {
    if (re.test(working) && !matchedTerms.includes(zh)) {
      matchedTerms.push(zh);
    }
  }
  if (matchedTerms.length >= 2) {
    return `${prefix}${matchedTerms.slice(0, 3).join("、")}相关的自动化与规范支持（${trimmed}）。`;
  }
  return `${prefix}「${name}」相关能力：${trimmed}`;
}

export interface TranslationResult {
  text: string;
  usedFallback: boolean;
  error?: string;
}

function buildCompletionsUrl(baseUrl: string): string {
  const clean = baseUrl.trim().replace(/\/+$/, "");
  return /\/chat\/completions$/i.test(clean)
    ? clean
    : `${clean}/chat/completions`;
}

export async function translateDescriptionAsync(
  name: string,
  description: string,
): Promise<TranslationResult> {
  const fallback = translateDescription(name, description);
  const trimmed = description.trim();
  if (!trimmed) return { text: "", usedFallback: false };

  const { translationEngine, customApiUrl, customApiModel, customApiKey } =
    getSettings();
  if (
    translationEngine !== "custom" ||
    !customApiUrl.trim() ||
    !customApiKey.trim()
  ) {
    return { text: fallback, usedFallback: false };
  }

  const payload = {
    model: customApiModel.trim() || "gpt-4o-mini",
    temperature: 0.2,
    max_tokens: 120,
    messages: [
      {
        role: "system",
        content:
          "You translate AI coding skill descriptions into one concise, natural Simplified Chinese sentence (<= 45 Chinese characters). Output only the Chinese translation without quotes or prefixes.",
      },
      {
        role: "user",
        content: `Skill: ${name}\nDescription: ${trimmed}`,
      },
    ],
  };

  if (isTauriNative()) {
    try {
      const res = await invoke<TranslateProxyResponse>("translate_proxy", {
        req: {
          url: buildCompletionsUrl(customApiUrl),
          apiKey: customApiKey.trim(),
          body: payload,
          timeoutMs: 12000,
        },
      });
      if (!res.ok) throw new Error(res.error || `HTTP ${res.status}`);
      const content = res.body?.choices?.[0]?.message?.content
        ?.trim()
        .replace(/^["'「『]|["'」』]$/g, "");
      if (!content) throw new Error("Empty response");
      return { text: content, usedFallback: false };
    } catch (err) {
      return {
        text: fallback,
        usedFallback: true,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(buildCompletionsUrl(customApiUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${customApiKey.trim()}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = json.choices?.[0]?.message?.content
      ?.trim()
      .replace(/^["'「『]|["'」』]$/g, "");
    if (!content) throw new Error("Empty response");
    return { text: content, usedFallback: false };
  } catch (err) {
    return {
      text: fallback,
      usedFallback: true,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    window.clearTimeout(timer);
  }
}

export async function testTranslationEndpoint(
  baseUrl: string,
  model: string,
  apiKey: string,
): Promise<{ ok: boolean; detail: string }> {
  if (!baseUrl.trim() || !apiKey.trim()) {
    return { ok: false, detail: "Missing URL or API Key" };
  }
  const testPayload = {
    model: model.trim() || "gpt-4o-mini",
    max_tokens: 16,
    messages: [{ role: "user", content: "Reply OK" }],
  };
  if (isTauriNative()) {
    try {
      const res = await invoke<TranslateProxyResponse>("translate_proxy", {
        req: {
          url: buildCompletionsUrl(baseUrl),
          apiKey: apiKey.trim(),
          body: testPayload,
          timeoutMs: 8000,
        },
      });
      if (!res.ok) return { ok: false, detail: res.error || `HTTP ${res.status}` };
      return { ok: true, detail: `HTTP ${res.status}` };
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : "Network error",
      };
    }
  }
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(buildCompletionsUrl(baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey.trim()}`,
      },
      body: JSON.stringify(testPayload),
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    return { ok: true, detail: `HTTP ${res.status}` };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : "Network error",
    };
  } finally {
    window.clearTimeout(timer);
  }
}

export function resolveSkillDescription(
  item: { name: string; description: string; descriptionZh?: string },
  showZh: boolean,
): {
  display: string;
  zh: string;
  raw: string;
  isTranslated: boolean;
} {
  const raw = item.description;
  const zh =
    item.descriptionZh?.trim() ||
    BUILTIN_SKILL_ZH[item.name.trim().toLowerCase()] ||
    "";
  const isTranslated = !!zh && zh !== raw;
  return {
    display: showZh && isTranslated ? zh : raw,
    zh: zh || translateDescription(item.name, raw),
    raw,
    isTranslated,
  };
}

const PREF_EVENT = "pita:translate-pref";

export function getTranslatePref(): boolean {
  return preference("translateDesc", "on") !== "off";
}

export function setTranslatePref(on: boolean) {
  remember("translateDesc", on ? "on" : "off");
  window.dispatchEvent(new CustomEvent(PREF_EVENT, { detail: on }));
}

export function useTranslatePref(): [boolean, (next: boolean) => void] {
  const [on, setOn] = useState<boolean>(() => getTranslatePref());
  useEffect(() => {
    const sync = () => setOn(getTranslatePref());
    window.addEventListener(PREF_EVENT, sync);
    return () => window.removeEventListener(PREF_EVENT, sync);
  }, []);
  return [
    on,
    (next: boolean) => {
      setOn(next);
      setTranslatePref(next);
    },
  ];
}
