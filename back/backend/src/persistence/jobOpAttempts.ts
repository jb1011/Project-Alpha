import type Database from "better-sqlite3";

/** Per-(jobKey, step) attempt counter for circle-path job ops (review finding H1): a FAILED
 *  Circle tx burns its deterministic idempotency key, so without a persisted bump the retry
 *  would replay the original failed response forever — permanently wedging the job step. Mirrors
 *  `bridge_legs.attempt` for the funding saga. */
export interface JobOpAttempts {
  get(jobKey: string, step: string): number;
  /** Bump after a terminal Circle failure; returns the new attempt. */
  bump(jobKey: string, step: string): number;
}

export class SqliteJobOpAttempts implements JobOpAttempts {
  constructor(private readonly db: Database.Database) {}

  get(jobKey: string, step: string): number {
    const row = this.db
      .prepare("SELECT attempt FROM job_op_attempts WHERE job_key = ? AND step = ?")
      .get(jobKey, step) as { attempt: number } | undefined;
    return row?.attempt ?? 0;
  }

  bump(jobKey: string, step: string): number {
    this.db
      .prepare(
        `INSERT INTO job_op_attempts (job_key, step, attempt) VALUES (?, ?, 1)
         ON CONFLICT(job_key, step) DO UPDATE SET attempt = attempt + 1`,
      )
      .run(jobKey, step);
    return this.get(jobKey, step);
  }
}
