export class ProjectQueue {
  readonly #tails = new Map<string, Promise<void>>();

  async run<T>(projectId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(projectId) ?? Promise.resolve();
    const running = previous.then(task, task);
    const barrier = running.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(projectId, barrier);

    try {
      return await running;
    } finally {
      if (this.#tails.get(projectId) === barrier) {
        this.#tails.delete(projectId);
      }
    }
  }

  isBusy(projectId: string): boolean {
    return this.#tails.has(projectId);
  }
}
