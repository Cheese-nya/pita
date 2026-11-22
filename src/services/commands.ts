import type { AgentId, ScopeTarget, ProjectWorkspace } from "../types/domain";
import {
  available,
  bindingAt,
  presetNameTaken,
  projectTarget,
  stagedDisable,
  sameScope,
  scopeAgents,
  scopeKey,
  type Skill,
  type Binding,
  type Workspace,
  type Files,
} from "../types/workspace";
import { meta, gitUrl, hash } from "./tree";
import { translateDescription, translateDescriptionAsync } from "./translator";
export type Command =
  | {
      type: "deploy";
      id: string;
      target: ScopeTarget;
      agent: AgentId;
      action: "enable" | "disable" | "remove";
    }
  | {
      type: "bulkDeploy";
      ids: string[];
      targets: ScopeTarget[];
      action: "enable" | "disable" | "remove";
    }
  | {
      type: "matrixDeploy";
      changes: { id: string; target: ScopeTarget; agent: AgentId }[];
      action: "enable" | "disable";
    }
  | { type: "pin" | "delete"; id: string }
  | { type: "bulkDelete"; ids: string[] }
  | { type: "source"; id: string; url: string }
  | { type: "translateSkill"; id: string; text?: string }
  | { type: "translateAllSkills"; ids?: string[] }
  | {
      type: "drift";
      id: string;
      target: ScopeTarget;
      agent: AgentId;
      direction: "central" | "copy";
    }
  | { type: "update"; ids: string[] }
  | { type: "rollback"; id: string }
  | { type: "bind" | "unbind" | "sync"; id: string; target: ScopeTarget }
  | {
      type: "createPreset";
      name: string;
      ids: string[];
      targets: ScopeTarget[];
    }
  | {
      type: "preset";
      id: string;
      name: string;
      ids: string[];
      sync: boolean;
      targets?: ScopeTarget[];
    }
  | { type: "deletePreset"; id: string }
  | { type: "addToPreset"; id: string; ids: string[]; sync: boolean }
  | {
      type: "togglePresetMember";
      presetId: string;
      skillId: string;
      sync?: boolean;
    }
  | { type: "projectAgents"; id: string; agents: AgentId[] }
  | { type: "removeProject"; id: string }
  | { type: "rescanProject"; id: string }
  | {
      type: "projects";
      projects: (ProjectWorkspace & {
        detectedSkills?: { id: string; agentId: AgentId }[];
      })[];
    }
  | {
      type: "add";
      skills: Skill[];
      targets: ScopeTarget[];
      reuse?: { id: string; hash: string }[];
    }
  | {
      type: "restore";
      data: Pick<Workspace, "skills" | "presets" | "projects" | "bindings">;
    }
  | { type: "connect"; kind: "github" }
  | { type: "connect"; kind: "https"; url: string; token: string }
  | { type: "disconnect" | "scan" | "check" | "backup" }
  | { type: "root"; path: string };
const now = () => new Date().toISOString();
function deploy(
  s: Skill,
  target: ScopeTarget,
  a: AgentId,
  manual: boolean,
  enable = true,
) {
  const existing = s.deployments.find(
    (d) => sameScope(d.scope, target) && d.agentId === a,
  );
  if (existing) {
    existing.manual ||= manual;
    if (enable) {
      existing.status = "enabled";
      delete existing.pausedByProject;
    }
    return;
  }
  s.deployments.push({
    scope: target,
    agentId: a,
    status: "enabled",
    manual,
    installedHash: s.centralHash,
    drifted: false,
  });
}
function reconcile(w: Workspace, b: Binding, ids: string[]) {
  const removed = b.appliedIds.filter((id) => !ids.includes(id));
  for (const s of w.skills) {
    if (ids.includes(s.id) && !b.appliedIds.includes(s.id))
      for (const a of scopeAgents(w, b.target)) deploy(s, b.target, a, false);
    if (
      removed.includes(s.id) &&
      !w.bindings.some(
        (o) =>
          o !== b &&
          sameScope(b.target, o.target) &&
          o.appliedIds.includes(s.id),
      )
    )
      s.deployments = s.deployments.filter(
        (d) => !sameScope(d.scope, b.target) || d.manual,
      );
  }
  b.appliedIds = [...ids];
  b.appliedAt = now();
}
function replaceCentral(s: Skill, files: Files, sha: string) {
  const previous = s.centralHash;
  Object.assign(s, meta(files), { files, centralHash: sha });
  for (const d of s.deployments) {
    if (d.installedHash === previous || d.installedHash === sha) {
      d.installedHash = sha;
      delete d.files;
    }
    d.drifted = d.installedHash !== sha;
  }
}
function bindMembers(
  w: Workspace,
  id: string,
  target: ScopeTarget,
  ids: string[],
) {
  const b = bindingAt(w, id, target);
  if (!w.bindings.includes(b)) {
    if (!scopeAgents(w, target).length) throw Error("chooseProjectAgents");
    w.bindings.push(b);
  }
  reconcile(w, b, ids);
}
function unbind(w: Workspace, b: Binding) {
  reconcile(w, b, []);
  w.bindings = w.bindings.filter((x) => x !== b);
}
export async function apply(w: Workspace, c: Command) {
  const get = (id: string) => {
    const s = w.skills.find((s) => s.id === id);
    if (!s) throw Error("missing");
    return s;
  };
  const preset = (id: string) => {
    const p = w.presets.find((p) => p.id === id);
    if (!p) throw Error("missing");
    return p;
  };
  const before = new Map(
    w.skills.map((s) => [
      s.id,
      s.deployments.map(
        (d) => [scopeKey(d.scope) + "/" + d.agentId, d.status] as const,
      ),
    ]),
  );
  switch (c.type) {
    case "deploy": {
      const s = get(c.id),
        d = s.deployments.find(
          (d) => sameScope(d.scope, c.target) && d.agentId === c.agent,
        );
      if (c.action === "enable") {
        if (!scopeAgents(w, c.target).includes(c.agent))
          throw Error("chooseProjectAgents");
        deploy(s, c.target, c.agent, true);
        break;
      }
      if (!d) throw Error("missing");
      if (c.action === "remove")
        s.deployments = s.deployments.filter((x) => x !== d);
      else {
        d.status = stagedDisable(w, c.target, c.agent)
          ? "disabled-staging"
          : "disabled-native";
        delete d.pausedByProject;
      }
      break;
    }
    case "bulkDeploy": {
      if (!c.ids.length) throw Error("chooseSkill");
      if (
        c.action === "enable" &&
        c.targets.some((target) => !scopeAgents(w, target).length)
      )
        throw Error("chooseProjectAgents");
      const list = c.ids.map(get);
      for (const s of list) {
        for (const target of c.targets) {
          const targetAgents = scopeAgents(w, target);
          if (c.action === "enable") {
            for (const a of targetAgents) deploy(s, target, a, true);
          } else if (c.action === "remove") {
            s.deployments = s.deployments.filter(
              (d) => !sameScope(d.scope, target),
            );
          } else {
            for (const d of s.deployments) {
              if (!sameScope(d.scope, target) || d.status !== "enabled")
                continue;
              d.status = stagedDisable(w, target, d.agentId)
                ? "disabled-staging"
                : "disabled-native";
              delete d.pausedByProject;
            }
          }
        }
      }
      break;
    }
    case "matrixDeploy": {
      if (!c.changes.length) throw Error("chooseSkill");
      for (const ch of c.changes) {
        const s = get(ch.id);
        if (c.action === "enable") {
          if (!scopeAgents(w, ch.target).includes(ch.agent)) continue;
          deploy(s, ch.target, ch.agent, true);
        } else {
          const d = s.deployments.find(
            (x) => sameScope(x.scope, ch.target) && x.agentId === ch.agent,
          );
          if (d && d.status === "enabled") {
            d.status = stagedDisable(w, ch.target, ch.agent)
              ? "disabled-staging"
              : "disabled-native";
            delete d.pausedByProject;
          }
        }
      }
      break;
    }
    case "pin":
      get(c.id).pinned = !get(c.id).pinned;
      break;
    case "source": {
      if (!gitUrl(c.url)) throw Error("invalidUrl");
      const s = get(c.id);
      s.source = {
        type: "git",
        repoUrl: c.url,
        ref: "main",
        commit: s.centralHash.slice(0, 40),
        skillPath: s.id,
      };
      break;
    }
    case "translateSkill": {
      const s = get(c.id);
      const next =
        c.text !== undefined
          ? c.text.trim()
          : (await translateDescriptionAsync(s.name, s.description)).text;
      if (next) s.descriptionZh = next;
      else delete s.descriptionZh;
      break;
    }
    case "translateAllSkills": {
      const targets = c.ids?.length ? c.ids.map(get) : w.skills;
      for (const s of targets) {
        if (!s.descriptionZh?.trim()) {
          const res = await translateDescriptionAsync(s.name, s.description);
          s.descriptionZh = res.text;
        }
      }
      break;
    }
    case "delete": {
      w.skills = w.skills.filter((s) => s.id !== c.id);
      w.snapshots = w.snapshots.filter((x) => x.skillId !== c.id);
      for (const p of w.presets)
        p.skillIds = p.skillIds.filter((id) => id !== c.id);
      for (const b of w.bindings)
        b.appliedIds = b.appliedIds.filter((id) => id !== c.id);
      break;
    }
    case "bulkDelete": {
      if (!c.ids.length) throw Error("chooseSkill");
      const removeSet = new Set(c.ids);
      w.skills = w.skills.filter((s) => !removeSet.has(s.id));
      w.snapshots = w.snapshots.filter((x) => !removeSet.has(x.skillId));
      for (const p of w.presets)
        p.skillIds = p.skillIds.filter((id) => !removeSet.has(id));
      for (const b of w.bindings)
        b.appliedIds = b.appliedIds.filter((id) => !removeSet.has(id));
      break;
    }
    case "drift": {
      const s = get(c.id),
        d = s.deployments.find(
          (d) => d.agentId === c.agent && sameScope(d.scope, c.target),
        );
      if (!d?.drifted || !d.files) throw Error("missing");
      if (c.direction === "copy") replaceCentral(s, d.files, d.installedHash);
      else {
        d.installedHash = s.centralHash;
        d.drifted = false;
        delete d.files;
      }
      break;
    }
    case "update": {
      for (const id of c.ids) {
        const s = get(id);
        if (!available(s) || !s.upstream || s.source.type !== "git") continue;
        w.snapshots.unshift({
          id: crypto.randomUUID(),
          at: now(),
          skillId: id,
          skill: structuredClone(s),
        });
        replaceCentral(s, s.upstream.files, await hash(s.upstream.files));
        s.source.commit = s.upstream.commit;
        s.hasUpdate = false;
        delete s.updateSummary;
      }
      break;
    }
    case "rollback": {
      const snap = w.snapshots.find((x) => x.id === c.id);
      if (!snap) throw Error("missing");
      const s = get(snap.skillId),
        old = snap.skill;
      replaceCentral(s, old.files, old.centralHash);
      s.source = structuredClone(old.source);
      s.hasUpdate = old.hasUpdate;
      s.updateSummary = old.updateSummary;
      s.upstream = old.upstream;
      w.snapshots = w.snapshots.filter((x) => x.id !== c.id);
      break;
    }
    case "bind":
    case "unbind":
    case "sync": {
      const p = preset(c.id);
      const b = bindingAt(w, c.id, c.target);
      if (c.type === "unbind") {
        unbind(w, b);
      } else {
        if (c.type === "sync" && !w.bindings.includes(b))
          throw Error("missing");
        bindMembers(w, p.id, c.target, p.skillIds);
      }
      break;
    }
    case "createPreset":
    case "preset": {
      const p =
        c.type === "preset"
          ? preset(c.id)
          : {
              id: crypto.randomUUID(),
              name: "",
              color: "accent",
              skillIds: [],
              updatedAt: "",
            };
      if (!c.name.trim() || presetNameTaken(w, c.name, p.id))
        throw Error("presetNameTaken");
      if (!c.ids.length) throw Error("chooseSkill");
      c.ids.forEach(get);
      p.name = c.name.trim();
      p.skillIds = [...new Set(c.ids)];
      p.updatedAt = now();
      if (c.type === "createPreset") {
        w.presets.push(p);
        for (const target of c.targets)
          bindMembers(w, p.id, target, p.skillIds);
      } else if (c.sync) {
        const bindings = w.bindings.filter((b) => b.presetId === p.id);
        const targets = c.targets ?? bindings.map((b) => b.target);
        for (const b of bindings)
          if (!targets.some((t) => sameScope(t, b.target))) unbind(w, b);
        for (const target of targets) bindMembers(w, p.id, target, p.skillIds);
      }
      break;
    }
    case "deletePreset": {
      const p = preset(c.id);
      for (const b of w.bindings.filter((b) => b.presetId === p.id))
        unbind(w, b);
      w.presets = w.presets.filter((x) => x.id !== p.id);
      break;
    }
    case "addToPreset": {
      if (!c.ids.length) throw Error("chooseSkill");
      c.ids.forEach(get);
      const p = preset(c.id);
      p.skillIds = Array.from(new Set([...p.skillIds, ...c.ids]));
      p.updatedAt = now();
      if (c.sync) {
        for (const b of w.bindings.filter((b) => b.presetId === p.id))
          bindMembers(w, p.id, b.target, p.skillIds);
      }
      break;
    }
    case "togglePresetMember": {
      get(c.skillId);
      const p = preset(c.presetId);
      if (p.skillIds.includes(c.skillId)) {
        if (p.skillIds.length <= 1) throw Error("chooseSkillOrDelete");
        p.skillIds = p.skillIds.filter((id) => id !== c.skillId);
      } else {
        p.skillIds = [...p.skillIds, c.skillId];
      }
      p.updatedAt = now();
      if (c.sync) {
        for (const b of w.bindings.filter((b) => b.presetId === p.id))
          bindMembers(w, p.id, b.target, p.skillIds);
      }
      break;
    }
    case "projectAgents": {
      const p = w.projects.find((p) => p.id === c.id);
      if (!p) throw Error("missing");
      const added = c.agents.filter((a) => !p.enabledAgents.includes(a));
      p.enabledAgents = c.agents;
      for (const s of w.skills)
        for (const d of s.deployments) {
          if (d.scope.kind !== "project" || d.scope.projectId !== p.id)
            continue;
          if (!p.enabledAgents.includes(d.agentId) && d.status === "enabled") {
            d.status = stagedDisable(w, d.scope, d.agentId)
              ? "disabled-staging"
              : "disabled-native";
            d.pausedByProject = true;
          } else if (added.includes(d.agentId) && d.pausedByProject) {
            d.status = "enabled";
            delete d.pausedByProject;
          }
        }
      for (const b of w.bindings.filter(
        (b) => b.target.kind === "project" && b.target.projectId === p.id,
      ))
        for (const id of b.appliedIds)
          for (const a of added) deploy(get(id), b.target, a, false, false);
      break;
    }
    case "removeProject": {
      const p = w.projects.find((x) => x.id === c.id);
      if (!p) throw Error("missing");
      w.projects = w.projects.filter((x) => x.id !== c.id);
      w.bindings = w.bindings.filter(
        (b) => b.target.kind !== "project" || b.target.projectId !== c.id,
      );
      for (const s of w.skills) {
        s.deployments = s.deployments.filter(
          (d) => d.scope.kind !== "project" || d.scope.projectId !== c.id,
        );
      }
      break;
    }
    case "rescanProject": {
      const p = w.projects.find((x) => x.id === c.id);
      if (!p) throw Error("missing");
      for (const s of w.skills) {
        for (const d of s.deployments) {
          if (d.scope.kind === "project" && d.scope.projectId === c.id) {
            d.installedHash = d.files ? await hash(d.files) : s.centralHash;
            d.drifted = d.installedHash !== s.centralHash;
          }
        }
      }
      w.scannedAt = now();
      break;
    }
    case "projects": {
      const added = c.projects.filter(
        (p) => !w.projects.some((x) => x.path === p.path),
      );
      if (!added.length) throw Error("duplicate");
      for (const p of added) {
        const { detectedSkills, ...projectRecord } = p;
        w.projects.push(projectRecord);
        if (detectedSkills?.length) {
          const target = projectTarget(projectRecord.id);
          for (const item of detectedSkills) {
            const s = w.skills.find((x) => x.id === item.id);
            if (s && projectRecord.enabledAgents.includes(item.agentId)) {
              deploy(s, target, item.agentId, true, false);
            }
          }
        }
      }
      break;
    }
    case "add": {
      if (c.targets.some((target) => !scopeAgents(w, target).length))
        throw Error("chooseProjectAgents");
      if (
        c.skills.some((s) => w.skills.some((x) => x.id === s.id)) ||
        new Set(c.skills.map((s) => s.id)).size !== c.skills.length
      )
        throw Error("duplicate");
      const reuse = (c.reuse ?? []).map((item) => {
        const s = get(item.id);
        if (s.centralHash !== item.hash) throw Error("workspaceChanged");
        return s;
      });
      const additions = structuredClone(c.skills);
      for (const s of additions) {
        if (!s.descriptionZh?.trim()) {
          s.descriptionZh = translateDescription(s.name, s.description);
        }
      }
      w.skills.push(...additions);
      for (const s of [...additions, ...reuse]) {
        for (const t of c.targets)
          for (const a of scopeAgents(w, t))
            if (
              !s.deployments.some(
                (d) =>
                  sameScope(d.scope, t) &&
                  d.agentId === a &&
                  d.status === "enabled",
              )
            )
              deploy(s, t, a, true);
      }
      break;
    }
    case "restore": {
      for (const s of c.data.skills) {
        const i = w.skills.findIndex((old) => old.id === s.id);
        if (i < 0) w.skills.push(s);
        else w.skills[i] = s;
      }
      const merge = <T extends { id: string }>(a: T[], b: T[]) => [
        ...a.filter((x) => !b.some((y) => x.id === y.id)),
        ...b,
      ];
      w.projects = merge(w.projects, c.data.projects);
      w.presets = merge(w.presets, c.data.presets);
      w.bindings = [
        ...w.bindings.filter(
          (b) => !c.data.presets.some((p) => p.id === b.presetId),
        ),
        ...c.data.bindings,
      ];
      break;
    }
    case "check": {
      for (const s of w.skills) {
        if (s.source.type !== "git" || s.pinned) continue;
        s.hasUpdate = !!s.upstream && s.upstream.commit !== s.source.commit;
      }
      w.checkedAt = now();
      break;
    }
    case "scan": {
      for (const s of w.skills)
        for (const d of s.deployments) {
          d.installedHash = d.files ? await hash(d.files) : s.centralHash;
          d.drifted = d.installedHash !== s.centralHash;
        }
      w.scannedAt = now();
      break;
    }
    case "root":
      if (!c.path.trim()) throw Error("missing");
      w.root = c.path.trim();
      break;
    case "connect": {
      if (c.kind === "https" && (!gitUrl(c.url) || !c.token.trim()))
        throw Error("invalidUrl");
      w.remote = {
        kind: c.kind,
        url:
          c.kind === "github"
            ? "https://github.com/pita-demo/workspace-backup"
            : c.url,
      };
      break;
    }
    case "disconnect":
      w.remote = null;
      break;
    case "backup":
      if (!w.remote) throw Error("missing");
      w.remote.backedAt = now();
      break;
  }
  for (const b of w.bindings) {
    const ids = preset(b.presetId).skillIds;
    b.outOfSync =
      ids.length !== b.appliedIds.length ||
      ids.some((id) => !b.appliedIds.includes(id));
  }
  if (c.type === "restore") return;
  for (const s of w.skills) {
    const old = new Map(before.get(s.id)),
      next = new Map(
        s.deployments.map((d) => [
          scopeKey(d.scope) + "/" + d.agentId,
          d.status,
        ]),
      );
    for (const key of new Set([...old.keys(), ...next.keys()]))
      if (old.get(key) !== next.get(key))
        s.events.unshift({
          at: now(),
          action: next.get(key) ?? "removed",
          target: key,
        });
    const enabled = [...next.values()].includes("enabled");
    if (enabled && !s.enabledSince) s.enabledSince = now();
    if (!enabled && s.enabledSince) {
      s.cumulativeEnabledHours +=
        (Date.now() - Date.parse(s.enabledSince)) / 3600000;
      delete s.enabledSince;
    }
  }
}
