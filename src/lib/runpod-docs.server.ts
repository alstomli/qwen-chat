import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRunpodDocsPage } from "./docs-sources";

type DocsChunk = {
  heading: string; url: string; passage: string; headingTerms: string[]; bodyTerms: string[];
};

const stopWords = new Set("a an and are can do does for how i in is it my of on or the to what when which with".split(" "));
let cached: DocsChunk[] | undefined;

export function runpodDocsIndex(): DocsChunk[] | null {
  if (cached) return cached;
  try {
    const index: { version?: unknown; chunks?: unknown } = JSON.parse(readFileSync(join(process.cwd(), "data/runpod-docs-index.json"), "utf8"));
    if (index.version === 1 && Array.isArray(index.chunks) && index.chunks.length > 0 && index.chunks.every(isChunk)) {
      cached = index.chunks;
      return cached;
    }
  } catch { /* The optional local index may be missing or unreadable. */ }
  return null;
}

function isChunk(value: unknown): value is DocsChunk {
  if (!value || typeof value !== "object") return false;
  const chunk = value as Record<string, unknown>;
  return typeof chunk.heading === "string" && !!chunk.heading.trim() && chunk.heading.length <= 160 &&
    typeof chunk.passage === "string" && !!chunk.passage.trim() && chunk.passage.length <= 1800 &&
    isRunpodDocsPage(chunk.url) && isTerms(chunk.headingTerms) && isTerms(chunk.bodyTerms);
}

function isTerms(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(term => typeof term === "string" && /^[a-z0-9]+$/.test(term)) &&
    new Set(value).size === value.length;
}

/** Same inverse-frequency and heading weighting as the Python lesson baseline. */
export function searchRunpodDocs(chunks: DocsChunk[], question: string) {
  const query = new Set(question.toLowerCase().match(/[a-z0-9]+/g)?.filter(term => !stopWords.has(term)));
  const frequency = new Map<string, number>();
  const matches = chunks.map(chunk => {
    const heading = chunk.headingTerms.filter(term => query.has(term)).sort();
    const body = chunk.bodyTerms.filter(term => query.has(term)).sort();
    for (const term of new Set([...heading, ...body])) frequency.set(term, (frequency.get(term) ?? 0) + 1);
    return { chunk, heading, body };
  });
  const weights = new Map([...frequency].map(([term, count]) => [term, 1 + Math.log((1 + chunks.length) / (1 + count))]));
  const weightOf = (terms: string[]) => terms.reduce((sum, term) => sum + weights.get(term)!, 0);
  return matches.map(({ chunk, heading, body }) => ({ chunk, score: 2 * weightOf(heading) + weightOf(body) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map(({ chunk: { heading, passage, url } }) => ({ heading, passage, url }));
}
