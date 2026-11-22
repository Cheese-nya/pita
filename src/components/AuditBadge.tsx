import { ShieldAlert, ShieldCheck, ShieldQuestion, KeyRound, FileCode2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SkillAuditReport } from "../services/audit";

export function AuditBadge({
  report,
  compact = false,
}: {
  report: SkillAuditReport;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const RiskIcon =
    report.risk === "high"
      ? ShieldAlert
      : report.risk === "caution"
        ? ShieldQuestion
        : ShieldCheck;
  const riskLabel =
    report.risk === "high"
      ? t("auditHigh")
      : report.risk === "caution"
        ? t("auditCaution")
        : t("auditSafe");

  return (
    <div className="audit-block">
      <div className="audit-strip">
        <span className={"audit-pill " + report.risk}>
          <RiskIcon size={12} aria-hidden="true" />
          {riskLabel}
        </span>
        {report.requiresCredentials.length > 0 && (
          <span className="audit-pill caution">
            <KeyRound size={11} aria-hidden="true" />
            {t("auditCredentials", {
              list: report.requiresCredentials.slice(0, 2).join(", "),
            })}
          </span>
        )}
        {report.executableFiles.length > 0 && (
          <span className="audit-pill neutral">
            <FileCode2 size={11} aria-hidden="true" />
            {t("auditScripts", { n: report.executableFiles.length })}
          </span>
        )}
      </div>
      {!compact && report.findings.length > 0 && (
        <details
          className="audit-details"
          onClick={(e) => e.stopPropagation()}
        >
          <summary>{t("auditDetails", { n: report.findings.length })}</summary>
          <ul>
            {report.findings.map((f, idx) => (
              <li key={idx} className={"audit-finding " + f.severity}>
                <code>{f.file}</code>
                <span>{t("auditFinding_" + f.code, { defaultValue: f.detail })}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
