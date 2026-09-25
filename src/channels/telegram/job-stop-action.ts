import type { JobStopOutcome } from '../../contract.ts';
import type { CallbackAction } from './callback-menu.ts';
import { JOB_STOP_CALLBACK_PREFIX, parseJobStopCallback } from './job-progress.ts';

/**
 * The Stop buttons on live job messages (job-progress.ts): a background bash
 * session's, and one per unfinished sub-agent task. The callback data names
 * the job, and the task for a sub-agent.
 *
 * The tap is answered at once and the job ends on its own, which then reports
 * to the agent that the user stopped it. Jobs live in memory, so a button left
 * over from before a restart, or on a job long since pruned, finds nothing and
 * says the job is no longer running.
 */

const NOT_RUNNING = 'That job is no longer running.';

export function jobStopCallbackAction(
  stopJob: (jobId: string, task: number | undefined) => Promise<JobStopOutcome>,
): CallbackAction {
  return {
    prefix: JOB_STOP_CALLBACK_PREFIX,
    async answer(value) {
      const target = parseJobStopCallback(value);
      if (!target) return 'Unknown action.';
      const { jobId, taskNumber } = target;
      return toast(
        await stopJob(jobId, taskNumber),
        taskNumber === undefined ? 'Stopping the command…' : `Stopping sub-agent ${taskNumber}…`,
      );
    },
  };
}

function toast(outcome: JobStopOutcome, stopping: string): string {
  switch (outcome) {
    case 'stopping':
      return stopping;
    case 'already-stopping':
      return 'Already stopping…';
    case 'not-running':
      return NOT_RUNNING;
  }
}
