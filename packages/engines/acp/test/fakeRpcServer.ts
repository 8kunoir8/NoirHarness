/**
 * A scripted stand-in for `omp --mode rpc`. It speaks only the frames the adapter understands, in
 * the order the real binary was observed to send them, so the adapter can be tested without a model
 * or a network.
 */
import { createInterface } from "node:readline";

const out = (frame: unknown): void => {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
};

const send = (type: string, extra: Record<string, unknown> = {}): void =>
  out({ type, ts: Date.now(), ...extra });

const write = (text: string, reasoning = false): void =>
  send("message_update", {
    messageId: "msg-2",
    assistantMessageEvent: { type: reasoning ? "thinking_delta" : "text_delta", contentIndex: 0, delta: text },
  });

const usage = {
  input: 11,
  output: 7,
  totalTokens: 18,
  cacheRead: 0,
  cacheWrite: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0025 },
};

send("ready", {
  protocolVersion: process.env.FAKE_RPC_VERSION === undefined ? 1 : Number(process.env.FAKE_RPC_VERSION),
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1_048_576,
  maxReassembledFrameBytes: 67_108_864,
});

const rd = createInterface({ input: process.stdin, crlfDelay: Infinity });
rd.on("line", (line) => {
  let frame: { type?: string; message?: string; id?: string; value?: string };
  try {
    frame = JSON.parse(line);
  } catch {
    return;
  }
  switch (frame.type) {
    case "prompt": {
      send("agent_start");
      send("turn_start");
      send("response", { command: "prompt", success: true });
      send("message_start", {
        messageId: "msg-1",
        message: { role: "user", content: [{ type: "text", text: frame.message ?? "" }], timestamp: 1 },
      });
      send("message_end", { messageId: "msg-1", message: { role: "user" } });
      send("message_start", {
        messageId: "msg-2",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "Considering it." }],
          model: "fake-1",
          provider: "fake",
          usage,
        },
      });
      write("Considering it.", true);
      send("tool_execution_start", {
        toolCallId: "call-1",
        toolName: "write",
        args: { path: "notes.txt", content: "hi" },
        intent: "Writing notes.txt",
      });
      send("extension_ui_request", {
        id: "ask-1",
        method: "select",
        title: "Allow tool: write\nPath: notes.txt\nContent:\nhi",
        options: ["Approve", "Approve write for this session", "Deny"],
      });
      return;
    }
    case "extension_ui_response": {
      write(`reply:${frame.value ?? "none"}`);
      send("tool_execution_end", {
        toolCallId: "call-1",
        toolName: "write",
        result: { content: [{ type: "text", text: "Successfully wrote 2 bytes" }], details: {} },
        isError: false,
      });
      // The tool-call model turn ends here, and the follow-up turn begins: a prompt that resolved on
      // `turn_end` would end the kernel's turn before the reply below ever arrived.
      send("message_end", { messageId: "msg-2", message: { role: "assistant", usage, stopReason: "toolUse" } });
      send("turn_end", { message: { role: "assistant", stopReason: "toolUse", usage } });
      send("turn_start");
      send("message_start", { messageId: "msg-3", message: { role: "assistant", content: [] } });
      write("All done.");
      send("message_end", { messageId: "msg-3", message: { role: "assistant", usage, stopReason: "stop" } });
      send("turn_end", { message: { role: "assistant", stopReason: "stop", usage } });
      send("prompt_result", { agentInvoked: true, status: "completed", sessionSettled: true });
      return;
    }
    case "abort": {
      write("aborted");
      return;
    }
    default:
      return;
  }
});
