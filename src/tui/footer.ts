import type { ChannelRef, CoreState } from '../contract.ts';
import { channelName } from './chat-view.ts';
import { dim, yellow } from './style.ts';

/**
 * The line under the editor: the chat's model and reasoning, whether it is
 * working and what waits, background messages held for later, running jobs,
 * and which other interfaces are attached. Or, while the bot is out of reach,
 * that it is and when the next try is.
 */

export interface FooterState {
  connection:
    | { status: 'connecting' }
    | { status: 'connected' }
    | { status: 'lost'; retryInMs: number };
  state: CoreState | null;
  channels: ChannelRef[];
  self: ChannelRef | null;
  jobs: number;
}

export function footerLine(footer: FooterState): string {
  const { connection, state } = footer;
  if (connection.status === 'connecting') return dim('Connecting to the bot…');
  if (connection.status === 'lost') {
    const seconds = Math.max(1, Math.round(connection.retryInMs / 1000));
    return yellow(`⚠ Not connected to the bot · retrying in ${seconds}s`);
  }
  const parts: string[] = [];
  if (state) {
    const { chat } = state;
    parts.push(chat.model || 'no model');
    if (chat.reasoning) parts.push(chat.reasoning);
    parts.push(chat.busy ? '🟡 working' : '🟢 idle');
    if (chat.queued) parts.push(`📥 ${chat.queued} queued`);
    if (chat.steering) parts.push(`↪️ ${chat.steering} steering`);
    if (state.background.busy) parts.push('🌙 background working');
    if (state.held) parts.push(`📬 ${state.held} held`);
  }
  if (footer.jobs) parts.push(`⚙ ${footer.jobs} job${footer.jobs === 1 ? '' : 's'}`);
  const others = footer.channels.filter((ref) => ref.id !== footer.self?.id);
  if (others.length) parts.push(`also on ${others.map(channelName).join(', ')}`);
  return dim(parts.join(' · '));
}
