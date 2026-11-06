import type { Link, Parent, Root, RootContent, Text } from "mdast";
import type { DocsSource } from "./docs-sources";

/** Link citation markers in Markdown text, without rewriting code or nested links. */
export function remarkDocsCitations(sources: DocsSource[]) {
  const byMarker = new Map(sources.map(source => [`[${source.id}]`, source]));

  function cite(parent: Parent) {
    parent.children = parent.children.flatMap<RootContent>(node => {
      if (node.type === "image" || node.type === "imageReference") return [{ type: "text", value: node.alt ?? "" }];
      if (node.type === "link" || node.type === "linkReference") return [node];
      if (node.type !== "text") {
        if ("children" in node) cite(node);
        return [node];
      }
      return node.value.split(/(\[[1-3]\])/g).filter(Boolean).map((value): Link | Text => {
        const text: Text = { type: "text", value };
        const source = byMarker.get(value);
        return source ? { type: "link", url: source.url, children: [text],
          data: { hProperties: { dataDocsCitation: source.id } } } : text;
      });
    });
  }

  return (tree: Root) => cite(tree);
}
