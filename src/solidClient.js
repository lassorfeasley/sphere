const CANCELLED = 'solid-job-cancelled';

export const isCancelled = (error) => error?.message === CANCELLED;

/**
 * Runs `buildStrutSolid` in a Web Worker, one job at a time. The level-set
 * extraction can't be interrupted, so cancelling terminates the worker and
 * the next job starts a fresh one.
 */
export class SolidWorker {
  constructor() {
    this.worker = null;
    this.pending = null;
  }

  get busy() {
    return Boolean(this.pending);
  }

  spawn() {
    this.worker = new Worker(new URL('./solidWorker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      const job = this.pending;
      this.pending = null;
      if (data.error) {
        job?.reject(new Error(data.error));
      } else {
        job?.resolve(data.mesh);
      }
    };
    this.worker.onerror = (event) => {
      const job = this.pending;
      this.pending = null;
      this.worker.terminate();
      this.worker = null;
      job?.reject(new Error(event.message || 'Solid worker failed'));
    };
  }

  /** Build a solid; a job already running is cancelled first. */
  run(args) {
    this.cancel();
    if (!this.worker) {
      this.spawn();
    }
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.worker.postMessage(args, [args.segments.buffer]);
    });
  }

  cancel() {
    if (!this.pending) {
      return;
    }
    const job = this.pending;
    this.pending = null;
    this.worker.terminate();
    this.worker = null;
    job.reject(new Error(CANCELLED));
  }
}
