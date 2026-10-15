/** One attempt of a job to start, with the single-use token its worker authenticates with. */
export interface StartRequest {
  jobId: string;
  attempt: number;
  token: string;
}

/** Starts one attempt of a job somewhere isolated (spec 2 S16). */
export interface JobRunner {
  start(request: StartRequest): Promise<void>;
}

/** Test-only: a runner that records what it was asked to start. */
export function recordingRunner(): { runner: JobRunner; started: StartRequest[] } {
  const started: StartRequest[] = [];
  return {
    runner: {
      start: async (request) => {
        started.push(request);
      },
    },
    started,
  };
}
