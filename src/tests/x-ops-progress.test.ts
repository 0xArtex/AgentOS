import { test } from "node:test";
import assert from "node:assert/strict";
import { db, initDatabase } from "../db";
import { createXOpJob, getXOpJob, getXOpJobProgress } from "../services/x-ops-jobs";

test("X operation jobs expose real-time setup progress", async () => {
  initDatabase();
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const progressReported = new Promise<void>((resolve) => { started = resolve; });

  const job = createXOpJob(
    {
      op: "avatar",
      account_id: `progress_${Date.now()}`,
      owner: "progress-test-owner",
      paymentSignature: null,
      paymentChain: null,
      chargedUsdc: null,
    },
    async (reportProgress) => {
      reportProgress("avatar", "Changing profile photo");
      started();
      await gate;
      return { success: true, data: { applied: ["avatar"] } };
    },
  );

  try {
    assert.equal(getXOpJobProgress(job.id)?.message, "Warming up account");
    await progressReported;
    assert.deepEqual(getXOpJobProgress(job.id), {
      step: "avatar",
      message: "Changing profile photo",
      updated_at: getXOpJobProgress(job.id)?.updated_at,
    });

    release();
    const deadline = Date.now() + 2_000;
    while (getXOpJob(job.id)?.status !== "done" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(getXOpJob(job.id)?.status, "done");
    assert.equal(getXOpJobProgress(job.id)?.step, "ready");
    assert.equal(getXOpJobProgress(job.id)?.message, "Account ready");
  } finally {
    release();
    db.prepare("DELETE FROM x_op_jobs WHERE id = ?").run(job.id);
  }
});
