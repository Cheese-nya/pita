import { useTranslation } from "react-i18next";
import type { SkillSearchMatch } from "../services/skillSearch";
import type { resolveSkillDescription } from "../services/translator";

export function SkillSearchText({
  text,
  match,
  excerpt = false,
}: {
  text: string;
  match?: SkillSearchMatch;
  excerpt?: boolean;
}) {
  if (!match) return <>{text}</>;
  const from = excerpt ? Math.max(0, match.start - 18) : 0;
  const end = match.start + match.length;
  return (
    <>
      {from > 0 && "…"}
      {text.slice(from, match.start)}
      <mark className="skill-search-match">{text.slice(match.start, end)}</mark>
      {text.slice(end)}
    </>
  );
}

export function SkillSearchContext({
  description,
  match,
}: {
  description: ReturnType<typeof resolveSkillDescription>;
  match?: SkillSearchMatch;
}) {
  const { t } = useTranslation();
  const context = match?.field === "name" ? undefined : match;
  const text = context?.text ?? description.display;
  if (!text) return null;
  const translated =
    context?.field !== "source" &&
    description.isTranslated &&
    text === description.zh;
  const badge =
    context?.field === "source"
      ? t("source")
      : translated
        ? t("translatedBadge")
        : context?.field === "description" &&
            description.isTranslated &&
            description.display === description.zh
          ? t("originalDesc")
          : "";
  const tooltip = translated
    ? `${text}\n${t("originalDesc")}: ${description.raw}`
    : text;
  return (
    <small className="skill-desc" title={tooltip}>
      {badge && (
        <span className="zh-tag" aria-hidden={!context || undefined}>
          {badge}
        </span>
      )}
      <SkillSearchText text={text} match={context} excerpt />
    </small>
  );
}
