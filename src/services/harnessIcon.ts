export const MAX_HARNESS_ICON_BYTES = 5 * 1024 * 1024;
export const MAX_HARNESS_ICON_DATA_URL_LEN = 200_000;
export const HARNESS_ICON_ACCEPT =
  "image/png,image/jpeg,image/webp,image/svg+xml,image/x-icon,image/gif,.png,.jpg,.jpeg,.webp,.svg,.ico";

const DATA_URL_RE =
  /^data:image\/(png|jpeg|webp|gif|svg\+xml|x-icon);base64,[A-Za-z0-9+/=]+$/;

const BLOCKED_SVG_TAGS = new Set([
  "script",
  "foreignobject",
  "iframe",
  "object",
  "embed",
]);

const RASTER_SIZE = 128;

export function isValidHarnessIconDataUrl(val: unknown): val is string {
  return (
    typeof val === "string" &&
    val.length <= MAX_HARNESS_ICON_DATA_URL_LEN &&
    DATA_URL_RE.test(val)
  );
}

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function sanitizeSvgElement(el: Element): void {
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    const local = attr.localName.toLowerCase();
    if (name.startsWith("on")) {
      el.removeAttributeNode(attr);
      continue;
    }
    if (local === "href" || name === "href" || name === "xlink:href") {
      const normalized = attr.value
        .replace(/[\u0000-\u0020]+/g, "")
        .toLowerCase();
      if (
        normalized.startsWith("javascript:") ||
        normalized.startsWith("vbscript:")
      ) {
        el.removeAttributeNode(attr);
      }
    }
  }
  for (const child of Array.from(el.children)) {
    if (BLOCKED_SVG_TAGS.has(child.localName.toLowerCase())) {
      child.remove();
    } else {
      sanitizeSvgElement(child);
    }
  }
}

async function rasterizeToPngDataUrl(blob: Blob): Promise<string> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("customHarnessIconError"));
      img.src = url;
    });
    const naturalW = img.naturalWidth || img.width;
    const naturalH = img.naturalHeight || img.height;
    if (!naturalW || !naturalH) {
      throw new Error("customHarnessIconError");
    }
    const canvas = document.createElement("canvas");
    canvas.width = RASTER_SIZE;
    canvas.height = RASTER_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("customHarnessIconError");
    }
    ctx.clearRect(0, 0, RASTER_SIZE, RASTER_SIZE);
    const scale = Math.min(RASTER_SIZE / naturalW, RASTER_SIZE / naturalH);
    const drawW = naturalW * scale;
    const drawH = naturalH * scale;
    const dx = (RASTER_SIZE - drawW) / 2;
    const dy = (RASTER_SIZE - drawH) / 2;
    ctx.drawImage(img, dx, dy, drawW, drawH);
    const out = canvas.toDataURL("image/png");
    if (!isValidHarnessIconDataUrl(out)) {
      throw new Error("customHarnessIconError");
    }
    return out;
  } catch {
    throw new Error("customHarnessIconError");
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function processHarnessIconFile(file: File): Promise<string> {
  if (file.size === 0 || file.size > MAX_HARNESS_ICON_BYTES) {
    throw new Error("customHarnessIconError");
  }

  const isSvg = file.type === "image/svg+xml" || /\.svg$/i.test(file.name);
  if (isSvg) {
    let text: string;
    try {
      text = await file.text();
    } catch {
      throw new Error("customHarnessIconError");
    }
    const doc = new DOMParser().parseFromString(text, "image/svg+xml");
    const root = doc.documentElement;
    if (
      !root ||
      root.localName.toLowerCase() !== "svg" ||
      doc.querySelector("parsererror") !== null ||
      doc.getElementsByTagName("parsererror").length > 0
    ) {
      throw new Error("customHarnessIconError");
    }
    sanitizeSvgElement(root);
    if (!root.getAttribute("xmlns")) {
      root.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    }
    const serialized = new XMLSerializer().serializeToString(root);
    const dataUrl = `data:image/svg+xml;base64,${utf8ToBase64(serialized)}`;
    if (dataUrl.length <= MAX_HARNESS_ICON_DATA_URL_LEN) {
      if (!isValidHarnessIconDataUrl(dataUrl)) {
        throw new Error("customHarnessIconError");
      }
      return dataUrl;
    }
    return rasterizeToPngDataUrl(
      new Blob([serialized], { type: "image/svg+xml" }),
    );
  }

  return rasterizeToPngDataUrl(file);
}
