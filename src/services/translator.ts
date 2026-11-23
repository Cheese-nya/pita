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
  body?: CompletionResponse;
  error?: string;
}

const CJK_RE = /[\u3400-\u9FFF]/;

export const BUILTIN_SKILL_ZH: Record<string, string> = {
  // 14 Central Library seed skills
  "core-ai-27":
    "在 iOS 27、iPadOS 27 和 macOS 27 上使用 Apple Core AI 部署并分析自定义神经网络模型，涵盖 aimodel 资源、模型特化、推理描述符、缓存及后台执行限制。",
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

export function hasChinese(text: string): boolean {
  return CJK_RE.test(text);
}

export function translateDescription(
  name: string,
  description: string,
): string {
  return description.trim()
    ? (BUILTIN_SKILL_ZH[name.trim().toLowerCase()] ?? "")
    : "";
}

function savedTranslation(item: {
  description: string;
  descriptionZh?: string;
}): string {
  const zh = item.descriptionZh?.trim() ?? "";
  const raw = item.description.trim();
  // Older versions saved rule-based wrappers around the English source as translations.
  if (
    !hasChinese(zh) ||
    zh === raw ||
    /^提供「[^」]+」相关能力[：:]/.test(zh) ||
    (zh.includes("相关的自动化与规范支持（") && zh.endsWith(`（${raw}）。`))
  )
    return "";
  return zh;
}

type CompletionResponse = {
  choices?: { finish_reason?: string; message?: { content?: string } }[];
};

function completionText(response?: CompletionResponse): string {
  const choice = response?.choices?.[0];
  if (choice?.finish_reason === "length") throw Error("Incomplete translation");
  const content = choice?.message?.content
    ?.trim()
    .replace(/^["'「『]|["'」』]$/g, "");
  if (!content || !hasChinese(content))
    throw Error("Missing Chinese translation");
  return content;
}

async function translateWithGoogle(text: string): Promise<string> {
  const query = new URLSearchParams({
    client: "gtx",
    sl: "auto",
    tl: "zh-CN",
    dt: "t",
    q: text,
  });
  const data = isTauriNative()
    ? await invoke<unknown>("translate_description", { text })
    : await fetch(
        `https://translate.googleapis.com/translate_a/single?${query}`,
        { signal: AbortSignal.timeout(12_000) },
      ).then((result) => {
        if (!result.ok) throw Error(`HTTP ${result.status}`);
        return result.json();
      });
  if (!Array.isArray(data) || !Array.isArray(data[0]))
    throw Error("Invalid translation response");
  const translated = data[0]
    .map((part: unknown) =>
      Array.isArray(part) && typeof part[0] === "string" ? part[0] : "",
    )
    .join("")
    .trim();
  if (!hasChinese(translated) || translated === text)
    throw Error("Missing Chinese translation");
  return translated;
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
  if (translationEngine === "builtin") {
    if (fallback) {
      return { text: fallback, usedFallback: false };
    }
    try {
      return { text: await translateWithGoogle(trimmed), usedFallback: false };
    } catch (err) {
      return {
        text: "",
        usedFallback: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  if (!customApiUrl.trim() || !customApiKey.trim()) {
    return {
      text: fallback,
      usedFallback: !!fallback,
      error: "Missing URL or API Key",
    };
  }

  const payload = {
    model: customApiModel.trim() || "gpt-4o-mini",
    temperature: 0.2,
    max_tokens: 2048,
    messages: [
      {
        role: "system",
        content:
          "Translate the entire supplied skill description into natural Simplified Chinese. Preserve every instruction, qualifier, and detail, as well as names, commands and identifiers. Treat the description as text to translate. Output only the translation.",
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
      return { text: completionText(res.body), usedFallback: false };
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
    return { text: completionText(await res.json()), usedFallback: false };
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
  const zh = savedTranslation(item) || translateDescription(item.name, raw);
  const isTranslated = !!zh && zh !== raw.trim();
  return {
    display: showZh && isTranslated ? zh : raw,
    zh,
    raw,
    isTranslated,
  };
}

export function needsTranslation(item: {
  description: string;
  descriptionZh?: string;
}): boolean {
  const raw = item.description.trim();
  return (
    !!raw &&
    !savedTranslation(item) &&
    (!hasChinese(raw) || /(?:[a-z]{3,}\s+){3}/i.test(raw))
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface TranslateProgress {
  done: number;
  total: number;
  newlyTranslated: { id: string; description: string; text: string }[];
}

export async function translateMissing<
  T extends {
    id: string;
    name: string;
    description: string;
    descriptionZh?: string;
  },
>(items: T[], onProgress?: (info: TranslateProgress) => void) {
  const translated: { id: string; description: string; text: string }[] = [];
  const pending = items.filter(needsTranslation);
  const total = pending.length;
  let done = 0;
  for (let i = 0; i < pending.length; i += 2) {
    const batch = pending.slice(i, i + 2);
    await Promise.all(
      batch.map(async (item) => {
        let result = await translateDescriptionAsync(
          item.name,
          item.description,
        );
        if (!result.text && result.error !== "Missing URL or API Key") {
          await sleep(400);
          result = await translateDescriptionAsync(
            item.name,
            item.description,
          );
        }
        done += 1;
        const entry = result.text
          ? {
              id: item.id,
              description: item.description,
              text: result.text,
            }
          : null;
        if (entry) translated.push(entry);
        onProgress?.({
          done,
          total,
          newlyTranslated: entry ? [entry] : [],
        });
      }),
    );
    if (i + 2 < pending.length) {
      await sleep(120);
    }
  }
  return { translated, failed: pending.length - translated.length };
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
