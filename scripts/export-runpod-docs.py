"""Export the existing Runpod lesson corpus as a local Qwen Chat index."""

import argparse
import json
import runpy
from pathlib import Path


def clip(text, limit):
    encoded = text.encode("utf-16-le")
    if len(encoded) <= limit * 2:
        return text
    prefix = encoded[: limit * 2].decode("utf-16-le", errors="ignore")
    if not prefix[-1].isspace() and not text[len(prefix)].isspace():
        prefix = prefix.rsplit(maxsplit=1)[0]
    return prefix.rstrip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("docs_search", type=Path, help="Path to runpod-learning/docs-search")
    args = parser.parse_args()
    baseline_path = args.docs_search / "search_docs.py"
    if not baseline_path.is_file():
        parser.error(f"Could not find {baseline_path}")
    baseline = runpy.run_path(str(baseline_path))
    paths = (
        "pods/storage/types",
        "pods/troubleshooting/zero-gpus",
        "serverless/endpoints/endpoint-configurations",
        "serverless/endpoints/send-requests",
        "storage/network-volumes",
    )
    terms = baseline["terms"]
    chunks = []
    for path in paths:
        source = args.docs_search / "corpus" / f"{path}.mdx"
        if not source.is_file():
            parser.error(f"Could not find {source}")
        url = baseline["DOCS_ROOT"] + path
        for heading, url, passage in baseline["split_page"](source.read_text(encoding="utf-8"), url):
            chunks.append({
                "heading": clip(heading, 160),
                "url": url,
                "passage": clip(passage, 1800),
                "headingTerms": sorted(terms(heading)),
                "bodyTerms": sorted(terms(passage)),
            })
    if not chunks:
        parser.error("No Markdown sections found in the Runpod Docs corpus.")

    output = Path(__file__).resolve().parents[1] / "data" / "runpod-docs-index.json"
    output.parent.mkdir(exist_ok=True)
    output.write_text(json.dumps({"version": 1, "chunks": chunks}, ensure_ascii=False, separators=(",", ":")) + "\n",
                      encoding="utf-8", newline="\n")
    print(f"Exported {len(chunks)} sections to {output}")


if __name__ == "__main__":
    main()
