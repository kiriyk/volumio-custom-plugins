'use strict';

// Volumio 4.239 emits pushQueue, then calls kew.fcall with emit's return value.
// The mutation has succeeded, but its notification promise rejects. Accept only
// that exact defect, and only when the complete resulting queue matches.
class VolumioQueue {
  constructor(sm, logger) { this.sm = sm; this.logger = logger; }
  uris() { return this.sm.getQueue().map(track => track.uri); }
  async mutation(operation, expected) {
    try { await operation(); }
    catch (error) {
      const notificationDefect = /^(?:TypeError: )?callback\.apply is not a function$/.test(error.message);
      if (!notificationDefect || JSON.stringify(this.uris()) !== JSON.stringify(expected)) throw error;
      this.logger?.warn('[yandex wave] confirmed queue mutation despite Volumio 4.239 pushQueue rejection');
    }
    if (JSON.stringify(this.uris()) !== JSON.stringify(expected)) throw new Error('WAVE_QUEUE_CHANGED');
  }
  clear() { return this.mutation(() => this.sm.clearQueue(), []); }
  async removePast() {
    const expected = this.uris().slice(1);
    if (this.sm.currentPosition <= 0) throw new Error('WAVE_QUEUE_CHANGED');
    // CoreStateMachine.removeQueueItem never rejects when playQueue rejects.
    // Use its native queue operation and the same position adjustment directly.
    this.sm.currentPosition--;
    await this.mutation(() => this.sm.playQueue.removeQueueItem({ value: 0 }), expected);
    // Core pushState also waits for unrelated favourites work; the queue
    // mutation is already verified, so publish without blocking later commands.
    Promise.resolve(this.sm.pushState()).catch(error => this.logger?.error('[yandex wave] state notification failed: ' + error.message));
  }
}
module.exports = VolumioQueue;
