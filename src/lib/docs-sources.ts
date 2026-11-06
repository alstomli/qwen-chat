export const DOCS_MODE_HEADER = "X-Chat-Docs-Mode";
export const DOCS_SOURCES_HEADER = "X-Chat-Docs-Sources";
export const DOCS_IMAGE_ERROR = "Runpod Docs supports text only. Remove the image to use Runpod Docs.";
export const DOCS_UNAVAILABLE_ERROR = "Runpod Docs is unavailable for this connection.";
export const DOCS_INDEX_ERROR = "Runpod Docs index is unavailable. Configure the local documentation index and try again.";
export const DOCS_GATEWAY_ERROR = "Update the selected gateway to use Runpod Docs.";

const RUNPOD_DOCS_URLS = new Set([
  "https://docs.runpod.io/pods/storage/types",
  "https://docs.runpod.io/pods/troubleshooting/zero-gpus",
  "https://docs.runpod.io/serverless/endpoints/endpoint-configurations",
  "https://docs.runpod.io/serverless/endpoints/send-requests",
  "https://docs.runpod.io/storage/network-volumes",
]);
export type DocsSource = { id: number; heading: string; url: string };
const SECTION_FRAGMENT = /^[a-z0-9][a-z0-9/-]{0,159}$/;

export function isRunpodDocsPage(value: unknown): value is string {
  return typeof value === "string" && RUNPOD_DOCS_URLS.has(value);
}

function isRunpodDocsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const [page, fragment, extra] = value.split("#");
  return isRunpodDocsPage(page) && extra === undefined && (fragment === undefined || SECTION_FRAGMENT.test(fragment));
}

export function sectionDocsUrl(page: string, heading: string) {
  const fragment = heading.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9/-]/g, "");
  return SECTION_FRAGMENT.test(fragment) ? `${page}#${fragment}` : page;
}

export function parseDocsSources(value: unknown): DocsSource[] | undefined {
  if (!Array.isArray(value) || value.length > 3) return undefined;
  const result: DocsSource[] = [];
  for (const [index, source] of value.entries()) {
    if (!source || source.id !== index + 1 || typeof source.heading !== "string" ||
      !source.heading.trim() || source.heading.length > 160 || !isRunpodDocsUrl(source.url)) return undefined;
    result.push({ id: source.id, heading: source.heading, url: source.url });
  }
  return result;
}

export function parseDocsSourcesHeader(value: string | null): DocsSource[] | undefined {
  if (!value || value.length > 6500) return undefined;
  try { return parseDocsSources(JSON.parse(decodeURIComponent(value))); }
  catch { return undefined; }
}
