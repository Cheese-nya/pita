import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  canInstallMarketplace,
  getCachedMarketplacePreview,
  loadMarketplaceCardDocument,
  type MarketplaceDocument,
  type MarketplaceItem,
} from "../services/marketplace";

function excerpt({ description, skillMdPreview }: MarketplaceDocument) {
  const lines = skillMdPreview
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^(?:```|~~~|[-*_]{3,}\s*$)/.test(line));
  const title = lines.findIndex((line) => /^#\s/.test(line));
  const body = lines.slice(title + 1).filter((line) => !/^#{1,6}\s/.test(line));
  const prose = body.filter((line) => !/^>/.test(line));
  const text =
    (prose.length ? prose : body.length ? body : lines)
      .map((line) => line.replace(/^(?:#{1,6}|>|[-*+]|\d+\.)\s+/, ""))
      .join(" ")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(
        /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__/g,
        (_, code, bold, strong) => code ?? bold ?? strong,
      )
      .replace(/(^|\s)\*([^*]+)\*(?=\s|[.,!?:]|$)/g, "$1$2")
      .replace(/\s+/g, " ")
      .trim() || description.trim();
  return text.length > 360 ? text.slice(0, 360).trimEnd() + "…" : text;
}

export function MarketCardExcerpt({
  item,
  installed,
}: {
  item: MarketplaceItem;
  installed?: MarketplaceDocument;
}) {
  const { t } = useTranslation();
  const container = useRef<HTMLParagraphElement>(null);
  const [fetched, setFetched] = useState<MarketplaceDocument | null>();
  const cached = getCachedMarketplacePreview(item);
  const available = canInstallMarketplace(item);

  useEffect(() => {
    if (cached || installed || !available || fetched !== undefined) return;
    const node = container.current;
    if (!node) return;
    const controller = new AbortController();
    const load = () => {
      void loadMarketplaceCardDocument(item, controller.signal)
        .then((document) => {
          if (!controller.signal.aborted) setFetched(document ?? null);
        })
        .catch(() => {
          if (!controller.signal.aborted) setFetched(null);
        });
    };
    if (typeof IntersectionObserver === "undefined") {
      load();
      return () => controller.abort();
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        observer.disconnect();
        load();
      },
      { rootMargin: "96px 0px" },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      controller.abort();
    };
  }, [available, cached, fetched, installed, item]);

  const document = cached ?? installed ?? fetched;
  const loading = available && document === undefined;
  return (
    <p
      ref={container}
      className={`market-card-excerpt${loading ? " is-loading" : ""}`}
      aria-hidden={loading || undefined}
      dir="auto"
    >
      {document
        ? excerpt(document) || t("marketCardPreviewUnavailable")
        : loading
          ? null
          : t("marketCardPreviewUnavailable")}
    </p>
  );
}
