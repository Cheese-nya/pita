import type { Skill } from "../types/workspace";
import { resolveSkillDescription } from "./translator";

export type SkillSearchField = "name" | "description" | "source" | "all";

export type SkillSearchMatch = {
  field: Exclude<SkillSearchField, "all">;
  text: string;
  start: number;
  length: number;
  rank: number;
};

export function createSkillSearch(
  query: string,
  field: SkillSearchField,
  showZh: boolean,
) {
  const term = query.trim();
  if (!term) return;
  const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");
  const find = (
    text: string,
    field: SkillSearchMatch["field"],
    rank: number,
  ): SkillSearchMatch | undefined => {
    const match = pattern.exec(text);
    if (match)
      return { field, text, start: match.index, length: match[0].length, rank };
  };

  return (skill: Skill, sourceLabel: string): SkillSearchMatch | undefined => {
    if (field === "name" || field === "all") {
      const match = find(skill.name, "name", 3);
      if (match) {
        if (match.length === skill.name.length) match.rank = 0;
        else if (match.start === 0) match.rank = 1;
        else if (/[\s_.\/-]/.test(skill.name[match.start - 1])) match.rank = 2;
        return match;
      }
    }
    if (field === "description" || field === "all") {
      const { display, zh, raw } = resolveSkillDescription(skill, showZh);
      const match =
        find(display, "description", 4) ??
        find(display === raw ? zh : raw, "description", 4);
      if (match) return match;
    }
    if (field === "source" || field === "all") {
      const source = skill.source;
      const origin =
        source.type === "git"
          ? source.repoUrl
          : source.type === "local"
            ? source.originPath
            : source.type === "website"
              ? source.url
              : undefined;
      return (
        find(sourceLabel, "source", 5) ??
        (origin ? find(origin, "source", 5) : undefined)
      );
    }
  };
}
