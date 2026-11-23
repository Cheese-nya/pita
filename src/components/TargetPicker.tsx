import { useTranslation } from "react-i18next";
import { ChevronDown, FolderClosed } from "lucide-react";
import type { ScopeTarget } from "../types/domain";
import {
  globalTarget,
  orderAgentsByPresence,
  projectTarget,
  sameScope,
  scopeAgents,
  type Workspace,
} from "../types/workspace";
import { isNativeRuntime } from "../services/pitaClient";
import { useSettings } from "../services/settings";
import { usePita, useWorkspace } from "../store";
import { AgentIcon } from "./ui";

export function targetName(
  w: Workspace,
  target: ScopeTarget,
  t: (key: string) => string,
) {
  return target.kind === "global-agent"
    ? t(target.agentId)
    : (w.projects.find((p) => p.id === target.projectId)?.name ??
        target.projectId);
}

export function TargetPicker({
  value,
  onChange,
  label,
  empty,
  defaultOpen = false,
}: {
  value: ScopeTarget[];
  onChange: (next: ScopeTarget[]) => void;
  label: string;
  empty: string;
  defaultOpen?: boolean;
}) {
  const w = useWorkspace(),
    enabledAgents = useSettings((s) => s.enabledAgents),
    userReorderedAgents = useSettings((s) => s.userReorderedAgents),
    installedAgents = usePita((s) => s.installedAgents),
    { t } = useTranslation();
  const orderedAgents = orderAgentsByPresence(
    enabledAgents,
    installedAgents,
    userReorderedAgents,
  );
  const native = isNativeRuntime();
  const selected = (target: ScopeTarget) =>
    value.some((v) => sameScope(v, target));
  const toggle = (target: ScopeTarget) =>
    onChange(
      selected(target)
        ? value.filter((v) => !sameScope(v, target))
        : [...value, target],
    );
  return (
    <details className="target-picker" open={defaultOpen || undefined}>
      <summary>
        <strong>{label}</strong>
        <span>
          {value.map((v) => targetName(w, v, t)).join(" · ") || empty}
        </span>
        <ChevronDown size={15} />
      </summary>
      <div>
        <fieldset>
          <legend>{t("agents")}</legend>
          {orderedAgents.map((a) => {
            const isChecked = selected(globalTarget(a));
            const unavailable =
              native && (!installedAgents || !installedAgents.includes(a));
            const disabled = unavailable && !isChecked;
            return (
              <label
                className="choice"
                key={a}
                title={unavailable ? t("agentNotInstalled") : undefined}
              >
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={isChecked}
                  onChange={() => toggle(globalTarget(a))}
                />
                <AgentIcon id={a} />
                <span>
                  {t(a)}
                  {unavailable && (
                    <small className="target-agent-hint">
                      {t("agentNotInstalled")}
                    </small>
                  )}
                </span>
              </label>
            );
          })}
        </fieldset>
        {w.projects.length > 0 && (
          <fieldset>
            <legend>{t("projects")}</legend>
            {w.projects.map((p) => {
              const target = projectTarget(p.id),
                projectAgents = orderAgentsByPresence(
                  scopeAgents(w, target),
                  installedAgents,
                  userReorderedAgents,
                );
              return (
                <label className="choice" key={p.id}>
                  <input
                    type="checkbox"
                    disabled={!projectAgents.length && !selected(target)}
                    checked={selected(target)}
                    onChange={() => toggle(target)}
                  />
                  <FolderClosed size={16} />
                  <span>
                    {p.name}
                    <small>
                      {projectAgents.length
                        ? projectAgents.map((a) => t(a)).join(" · ")
                        : t("chooseProjectAgents")}
                    </small>
                  </span>
                </label>
              );
            })}
          </fieldset>
        )}
      </div>
    </details>
  );
}
