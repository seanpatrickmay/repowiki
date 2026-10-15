import { type Deps, nameOf } from "../app.ts";

/**
 * Cancel a job's open batches upstream once the job has ended (fresh review I3): nothing reads
 * their results any more, so whatever they still process is spend no job is charged. Best effort,
 * after the ending transaction committed; every cancel runs at once, each under its own 30 s
 * timeout, so one slow call never holds up the rest. A failure is logged by name, never thrown.
 */
export async function cancelBatches(
  anthropic: Deps["anthropic"],
  batchIds: readonly string[],
  log: (line: object) => void,
): Promise<void> {
  const { key } = anthropic;
  if (key === null) return;
  const cancel = async (id: string) => {
    try {
      const response = await anthropic.fetch(
        `${anthropic.url}/v1/messages/batches/${encodeURIComponent(id)}/cancel`,
        {
          method: "POST",
          headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
          signal: AbortSignal.timeout(30_000),
        },
      );
      await response.body?.cancel();
      if (!response.ok) log({ batch: "cancel-refused", status: response.status });
    } catch (error) {
      log({ batch: "cancel-failed", error: nameOf(error) });
    }
  };
  await Promise.allSettled(batchIds.map(cancel));
}
