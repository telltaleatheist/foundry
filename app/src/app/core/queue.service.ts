import { Injectable, computed, signal } from '@angular/core';

import type { Job, JobRequest } from '@shared/types';

import { api } from './foundry';

/**
 * The renderer's MIRROR of main's queue.
 *
 * Every mutation is an IPC call and every update arrives as a whole list from
 * main — this class never edits a job. Optimistic local state would be a second
 * opinion about a process this window does not own.
 */
@Injectable({ providedIn: 'root' })
export class QueueService {
  private readonly all = signal<Job[]>([]);

  readonly jobs = this.all.asReadonly();

  readonly running = computed(() => this.all().find((job) => job.state === 'running') ?? null);
  readonly queued = computed(() => this.all().filter((job) => job.state === 'queued'));
  readonly active = computed(() =>
    this.all().filter((job) => job.state === 'running' || job.state === 'queued'));
  readonly finished = computed(() =>
    this.all().filter((job) => job.state !== 'running' && job.state !== 'queued'));
  readonly failed = computed(() => this.all().filter((job) => job.state === 'failed'));

  constructor() {
    if (!api) return;
    api.queue.onChanged((jobs) => this.all.set(jobs));
    void api.queue.list().then((jobs) => this.all.set(jobs));
  }

  async enqueue(request: JobRequest): Promise<void> {
    await api?.queue.enqueue(request);
  }

  async cancel(id: string): Promise<void> {
    await api?.queue.cancel(id);
  }

  async clearFinished(): Promise<void> {
    await api?.queue.clearFinished();
  }
}
