import assert from "node:assert/strict";
import { test } from "node:test";
import { TdbApiError, TdbClient } from "../dist/client/tdbClient.js";
import { startMockServer } from "../dist/mock/server.js";

function createClient(port, token = "") {
  return new TdbClient({
    host: `127.0.0.1:${port}`,
    token,
    timeout: 5000,
    pollInterval: 50,
  });
}

test("完整流程：列文件 → 写复读点 → 合成 → 取消", async (t) => {
  const server = await startMockServer(0);
  t.after(() => server.close());
  const client = createClient(server.port);

  const capabilities = await client.capabilities();
  assert.equal(capabilities.apiVersion, 1);
  assert.ok(capabilities.abilities.includes("repeats.write"));

  const all = await client.listFiles();
  assert.equal(all.items.length, 5);

  const folder = await client.listFiles({ folder: "/BBC" });
  assert.equal(folder.items.length, 2);

  const keyword = await client.listFiles({ keyword: "englishpod" });
  assert.equal(keyword.items.length, 2);

  const fileId = all.items[0].fileId;
  const repeats = await client.getRepeats(fileId);
  assert.equal(repeats.items.length, 20);

  const replaced = await client.setRepeats(fileId, {
    mode: "replace",
    items: [{ start: 0, end: 2, text: "hello", translation: "你好" }],
  });
  assert.deepEqual(replaced, { fileId, mode: "replace", written: 1, total: 1 });

  const appended = await client.setRepeats(fileId, {
    mode: "append",
    items: [{ start: 2, end: 4 }],
  });
  assert.equal(appended.written, 1);
  assert.equal(appended.total, 2);

  await assert.rejects(
    () => client.setRepeats(fileId, { mode: "replace", items: [{ start: 5, end: 1 }] }),
    (error) => error instanceof TdbApiError && error.code === "VALIDATION_FAILED",
  );

  const created = await client.make({ fileId, repeatCount: 2 });
  assert.equal(created.status, "pending");

  // 同时只能跑一个任务
  await assert.rejects(
    () => client.make({ fileId }),
    (error) => error instanceof TdbApiError && error.code === "TASK_RUNNING" && Boolean(error.details?.taskId),
  );

  const task = await client.waitForTask(created.taskId, { pollInterval: 100, timeout: 10000 });
  assert.equal(task.status, "succeeded");
  assert.equal(task.progress, 1);
  assert.ok(task.output?.audioPath.endsWith(".m4a"));

  const cancelTarget = await client.make({ fileId });
  const cancelled = await client.cancelTask(cancelTarget.taskId);
  assert.equal(cancelled.status, "cancelled");

  await assert.rejects(
    () => client.getRepeats("no-such-file"),
    (error) => error instanceof TdbApiError && error.code === "NOT_FOUND",
  );
});

test("开启 token 校验后，没有 Bearer 就 401", async (t) => {
  const server = await startMockServer(0, { requireToken: true });
  t.after(() => server.close());

  await assert.rejects(
    () => createClient(server.port).capabilities(),
    (error) => error instanceof TdbApiError && error.code === "UNAUTHORIZED",
  );

  const capabilities = await createClient(server.port, "mock").capabilities();
  assert.equal(capabilities.apiVersion, 1);
});

test("连不上设备时报 NETWORK", async () => {
  const client = new TdbClient({ host: "127.0.0.1:1", token: "", timeout: 500, pollInterval: 50 });
  await assert.rejects(
    () => client.capabilities(),
    (error) => error instanceof TdbApiError && error.code === "NETWORK",
  );
});
