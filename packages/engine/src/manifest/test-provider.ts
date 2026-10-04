import type { GenerateRequest, Provider } from "@repowiki/llm";
import type { ManifestProposal } from "./proposal.ts";

/** Splits sampleIndex() into c01 (docs + app), c02 (routes + test), c03 (frontend). */
export const SAMPLE_CLUSTER_OPTIONS = { resolution: 1, minClusterSize: 1 };

/** An answer that sampleIndex() accepts. */
export const SAMPLE_PROPOSAL: ManifestProposal = {
  features: [
    { id: "http-api", title: "HTTP API", aliases: ["API server", "FastAPI app", "routes"] },
    { id: "web-frontend", title: "Web frontend", aliases: ["UI", "React app", "dashboard"] },
  ],
  clusters: [
    { cluster: "c01", feature: "http-api", role: "core" },
    { cluster: "c02", feature: "http-api", role: "supporting" },
    { cluster: "c03", feature: "web-frontend", role: "core" },
  ],
};

/** A provider that answers from a script, in order, and remembers every request. Test-only. */
export function scriptedProvider(...answers: (ManifestProposal | Error)[]) {
  const requests: GenerateRequest<unknown>[] = [];
  const provider: Provider = {
    async generate<T>(request: GenerateRequest<T>) {
      requests.push(request as GenerateRequest<unknown>);
      const answer = answers.shift();
      if (answer === undefined) throw new Error("no scripted answer left");
      if (answer instanceof Error) throw answer;
      const usage = { in: 1, out: 1, cacheRead: 0, cacheWrite: 0 };
      return { output: request.schema.parse(answer), usage, model: "claude-haiku-4-5" };
    },
  };
  return { provider, requests };
}
