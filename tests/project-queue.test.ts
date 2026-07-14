import { describe, expect, it } from "vitest";

import { ProjectQueue } from "../src/queue/project-queue.js";

describe("ProjectQueue", () => {
  it("never runs two tasks for the same project concurrently", async () => {
    const queue = new ProjectQueue();
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];

    const task = (name: string) =>
      queue.run("project-a", async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push(`start:${name}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push(`end:${name}`);
        active -= 1;
      });

    await Promise.all([task("one"), task("two")]);

    expect(maxActive).toBe(1);
    expect(order).toEqual(["start:one", "end:one", "start:two", "end:two"]);
  });

  it("does not impose a global lock across different projects", async () => {
    const queue = new ProjectQueue();
    let active = 0;
    let maxActive = 0;
    const task = (projectId: string) =>
      queue.run(projectId, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
      });

    await Promise.all([task("a"), task("b")]);
    expect(maxActive).toBe(2);
  });
});
