import type { IngestionTicket } from './contract.ts';

/**
 * Ingestion epoch. A channel may take minutes to turn a message into input
 * (a download, a transcription), so it takes a ticket when it starts. /abort
 * and /new bump the epoch, and a submit whose ticket predates the bump is
 * turned away: the user cancelled that message before it arrived.
 */
let epoch = 0;

export function beginIngestion(): IngestionTicket {
  return { epoch };
}

/** Makes every ticket taken so far stale. */
export function discardPendingIngestion(): void {
  epoch++;
}

export function isStaleTicket(ticket: IngestionTicket): boolean {
  return ticket.epoch !== epoch;
}
