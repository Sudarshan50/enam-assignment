export interface Job {
  name: string;
  description: string;
  run(): Promise<Record<string, unknown>>;
}

/** Named maintenance jobs reachable via POST /api/v1/internal/jobs/:name. Add a job by registering it in the container. */
export class JobRegistry {
  private readonly jobs = new Map<string, Job>();

  constructor(jobs: Job[] = []) {
    for (const job of jobs) this.register(job);
  }

  register(job: Job): this {
    if (this.jobs.has(job.name)) throw new Error(`Job ${job.name} is already registered`);
    this.jobs.set(job.name, job);
    return this;
  }

  get(name: string): Job | undefined {
    return this.jobs.get(name);
  }

  list(): { name: string; description: string }[] {
    return [...this.jobs.values()].map(({ name, description }) => ({ name, description }));
  }
}
