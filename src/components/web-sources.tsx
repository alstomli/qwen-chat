import { parseWebMetadata, type WebSource } from "@/lib/web-search";
import type { Message } from "@/lib/storage";

type MarkdownNode = { type: string; value?: string; url?: string; children?: MarkdownNode[] };
/** Only registered markers become citation links; code, existing links and unknown IDs stay intact. */
export function citationPlugin(sources: WebSource[]) {
  const ids = new Set(sources.map(s => s.sourceId));
  return function plugin() {
    return function transform(tree: MarkdownNode) {
      function visit(node: MarkdownNode) {
        if (!node.children || ["link", "code", "inlineCode"].includes(node.type)) return;
        node.children = node.children.flatMap(child => {
          if (child.type !== "text" || !child.value) { visit(child); return [child]; }
          const result: MarkdownNode[] = []; let offset = 0;
          for (const match of child.value.matchAll(/\[(S[1-9][0-9]{0,2})\]/g)) {
            if (!ids.has(match[1])) continue;
            if (match.index! > offset) result.push({ type: "text", value: child.value.slice(offset, match.index) });
            result.push({ type: "link", url: "#web-citation-" + match[1], children: [{ type: "text", value: "[" + match[1] + "]" }] });
            offset = match.index! + match[0].length;
          }
          if (offset < child.value.length) result.push({ type: "text", value: child.value.slice(offset) });
          return result;
        });
      }
      visit(tree);
    };
  };
}

export function WebSources({ message }: { message: Message }) {
  const metadata = parseWebMetadata(message.webSearch);
  if (!metadata) return null;
  const finished = metadata.outcome === "completed" && message.state === "complete";
  return <div className="web-sources">
    <p className="web-sources-outcome">{finished ? metadata.sources.length ? "Answer with web sources" : "Search finished without usable sources."
      : message.state ? "Search incomplete. Collected sources may not support a complete answer." : "Sources collected"}</p>
    {metadata.sources.length > 0 && <details><summary>Sources ({metadata.sources.length})</summary><ul>{metadata.sources.map(source => <li key={source.sourceId}>
      <a href={source.url} target="_blank" rel="noopener noreferrer" aria-label={`${source.sourceId}: ${source.title} (opens in a new tab)`}>
        <span className="web-source-id">[{source.sourceId}]</span> {source.title} <span aria-hidden="true">↗</span>
      </a><small>{new URL(source.url).hostname} · {source.evidenceKind === "page" ? "Page read" : "Search result"} · Retrieved {new Date(source.retrievedAt).toLocaleDateString()}</small>
    </li>)}</ul></details>}
  </div>;
}
