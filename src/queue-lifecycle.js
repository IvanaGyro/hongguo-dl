// Browser lifecycle cleanup for queued downloads and archive exports.
// Keep this small and testable: status persistence and UI remain in main.js.
const BUSY = new Set(['queued', 'resolving', 'downloading', 'processing', 'retrying']);

export function interruptQueueOnPageHide({
  active, retryTimers, jobs, bulkController, onInterrupted,
  clearTimer = clearTimeout
}) {
  for (const timer of retryTimers.values()) clearTimer(timer);
  retryTimers.clear();
  for (const controller of active.values()) controller.abort();
  bulkController?.abort();
  // The browser's BFCache may preserve these objects. Do not leave any job
  // queued for automatic restart; the user can explicitly retry on return.
  const interrupted = jobs.filter(job => BUSY.has(job.status));
  for (const job of interrupted) onInterrupted(job);
  return interrupted.length;
}
