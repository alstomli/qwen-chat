import assert from "node:assert/strict";
import { test } from "node:test";
import { runpodDocsIndex, searchRunpodDocs } from "../src/lib/runpod-docs.server";

const index = runpodDocsIndex();
const podStorage = "pods/storage/types";
const zeroGpus = "pods/troubleshooting/zero-gpus";
const endpoint = "serverless/endpoints/endpoint-configurations";
const requests = "serverless/endpoints/send-requests";
const networkVolumes = "storage/network-volumes";

// Expected top three in the order printed by the lesson's search_docs.py.
const cases = [
  ["What happens to files on the container disk and volume disk when I stop a Pod?", [
    ["Container disk", podStorage], ["Volume disk", podStorage], ["Comparison", podStorage],
  ]],
  ["How can I recover files when my Pod restarts with zero GPUs?", [
    ["What are my options?", zeroGpus], ["GPUs per worker", endpoint], ["Why does this happen?", zeroGpus],
  ]],
  ["Can I attach a network volume to a Pod after deployment?", [
    ["Network volume", podStorage], ["Network volumes for Pods", networkVolumes], ["Attach multiple volumes", networkVolumes],
  ]],
  ["What does the Serverless worker idle timeout control?", [
    ["Idle timeout", endpoint], ["Execution timeout", endpoint], ["Initialization timeout", endpoint],
  ]],
  ["How do I submit an asynchronous job and check its status?", [
    ["Operation overview", requests], ["Job TTL (time-to-live)", endpoint], ["Sync vs. async", requests],
  ]],
] as const;

test("the generated index matches the Python baseline for the five Runpod lesson questions", {
  skip: !index && "Generate the local Runpod Docs index to verify lesson parity.",
}, () => {
  assert.ok(index);
  for (const [question, expected] of cases) {
    const actual = searchRunpodDocs(index, question);
    assert.deepEqual(actual.map(({ heading, url }) => [heading, url.replace("https://docs.runpod.io/", "")]), expected, question);
    assert.ok(actual.every(hit => hit.passage.length <= 1800));
  }
});
