import type { GenerateRequest, Provider } from "@repowiki/llm";

/**
 * A provider that answers each call with `answer(request, n)` (n counts calls from 1): the
 * output, parsed with the request's schema, or an Error to throw. Remembers every request.
 * Test-only.
 */
export function scriptedProvider(
  answer: (request: GenerateRequest<unknown>, n: number) => unknown,
) {
  const requests: GenerateRequest<unknown>[] = [];
  const provider: Provider = {
    async generate<T>(request: GenerateRequest<T>) {
      requests.push(request as GenerateRequest<unknown>);
      const output = answer(request as GenerateRequest<unknown>, requests.length);
      if (output instanceof Error) throw output;
      const usage = { in: 100, out: 10, cacheRead: 0, cacheWrite: 0 };
      return { output: request.schema.parse(output), usage, model: "claude-haiku-4-5-20251001" };
    },
  };
  return { provider, requests };
}
