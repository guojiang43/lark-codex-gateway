import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { userAgent: "mock" } });
  } else if (message.method === "thread/start") {
    send({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "thread-1" } } });
  } else if (message.method === "thread/fork") {
    send({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "thread-fork-1" } } });
  } else if (message.method === "thread/resume") {
    if (message.params.threadId === "thread-empty") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32600, message: "no rollout found for thread id thread-empty" },
      });
    } else if (message.params.excludeTurns === true) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32600, message: "thread/resume.excludeTurns requires experimentalApi capability" },
      });
    } else {
      send({ jsonrpc: "2.0", id: message.id, result: { thread: { id: message.params.threadId } } });
    }
  } else if (message.method === "thread/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        data: [{
          id: "thread-existing",
          cwd: message.params.cwd,
          preview: "已有任务",
          name: null,
          createdAt: 10,
          updatedAt: 20,
        }],
        nextCursor: null,
      },
    });
  } else if (message.method === "turn/start") {
    const hasLocalImage = message.params?.input?.some((item) => item.type === "localImage");
    send({ jsonrpc: "2.0", id: message.id, result: { turn: { id: "turn-1" } } });
    send({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "commentary-1", type: "agentMessage", text: "", phase: "commentary" },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "commentary-1", delta: "正在检查" },
    });
    send({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "final-1", type: "agentMessage", text: "", phase: "final_answer" },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "final-1",
        delta: hasLocalImage ? "图片输入" : "你好",
      },
    });
    send({
      jsonrpc: "2.0",
      id: 900,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", command: "touch /tmp/nope" },
    });
    send({
      jsonrpc: "2.0",
      id: 901,
      method: "item/notActually/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
  } else if (message.id === 900) {
    send({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { turn: { id: "turn-1", status: message.result.decision === "decline" ? "failed" : "completed" } },
    });
  } else if (message.method === "turn/interrupt") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  }
});
