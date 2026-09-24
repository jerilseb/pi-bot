import { stopBackgroundBashFromTelegram } from './background-bash.ts';
import type { CallbackAction } from './callback-menu.ts';
import {
  JOB_STOP_CALLBACK_PREFIX,
  type JobStopOutcome,
  parseJobStopCallback,
} from './job-progress.ts';
import { stopSubagentTask } from './subagent.ts';

/**
 * The Stop buttons on live job messages (src/job-progress.ts): a background
 * bash session's, and one per unfinished sub-agent task. The callback data
 * names the job, and the task for a sub-agent; the ID's prefix says which kind.
 *
 * The tap is answered at once and the job ends on its own, which then reports
 * to the agent that the user stopped it. Registries live in memory, so a button
 * left over from before a restart, or on a job long since pruned, finds nothing
 * and says the job is no longer running.
 */

const NOT_RUNNING = 'That job is no longer running.';

export const jobStopCallbackAction: CallbackAction = {
  prefix: JOB_STOP_CALLBACK_PREFIX,
  answer(value) {
    const target = parseJobStopCallback(value);
    if (target?.jobId.startsWith('bg_') && target.taskNumber === undefined) {
      return toast(stopBackgroundBashFromTelegram(target.jobId), 'Stopping the command…');
    }
    if (target?.jobId.startsWith('sub_') && target.taskNumber !== undefined) {
      return toast(
        stopSubagentTask(target.jobId, target.taskNumber),
        `Stopping sub-agent ${target.taskNumber}…`,
      );
    }
    return 'Unknown action.';
  },
};

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
