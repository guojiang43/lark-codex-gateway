import { describe, expect, it } from "vitest";

import {
  normalizeCardActionEvent,
  normalizeMenuEvent,
  normalizeMessageEvent,
} from "../src/feishu/feishu-ingress.js";

describe("normalizeMessageEvent", () => {
  it("normalizes a text message without trusting user-provided paths or commands", () => {
    const message = normalizeMessageEvent({
      event_id: "event-1",
      create_time: "1000",
      sender: { sender_type: "user", sender_id: { open_id: "allowed-user" } },
      message: {
        message_id: "message-1",
        create_time: "999",
        chat_id: "chat-1",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    });
    expect(message).toMatchObject({
      eventId: "event-1",
      messageId: "message-1",
      chatType: "p2p",
      senderId: "allowed-user",
      text: "hello",
    });
  });

  it("ignores unsupported message types and malformed content", () => {
    const base = {
      sender: { sender_type: "user", sender_id: { open_id: "allowed-user" } },
      message: {
        message_id: "message-1",
        create_time: "999",
        chat_id: "chat-1",
        chat_type: "p2p",
        message_type: "image",
        content: "{}",
      },
    };
    expect(normalizeMessageEvent(base)).toBeNull();
    expect(normalizeMessageEvent({ ...base, message: { ...base.message, message_type: "text", content: "not-json" } })).toBeNull();
  });

  it("normalizes image and file messages as server-owned attachments", () => {
    const base = {
      event_id: "event-attachment",
      create_time: "1000",
      sender: { sender_type: "user", sender_id: { open_id: "allowed-user" } },
      message: {
        message_id: "message-attachment",
        create_time: "999",
        chat_id: "chat-1",
        chat_type: "p2p",
        message_type: "image",
        content: JSON.stringify({ image_key: "img_v3_safe" }),
      },
    };

    expect(normalizeMessageEvent(base)).toMatchObject({
      text: "",
      attachments: [{ kind: "image", fileKey: "img_v3_safe" }],
    });
    expect(normalizeMessageEvent({
      ...base,
      message: {
        ...base.message,
        message_type: "file",
        content: JSON.stringify({ file_key: "file_v3_safe", file_name: "../../report.pdf" }),
      },
    })).toMatchObject({
      text: "",
      attachments: [{ kind: "file", fileKey: "file_v3_safe", displayName: "report.pdf" }],
    });
  });
});

describe("interactive event normalization", () => {
  it("normalizes a flattened menu event", () => {
    expect(normalizeMenuEvent({
      event_id: "menu-event-1",
      create_time: "1001",
      event_key: "session_select",
      operator: { operator_id: { open_id: "allowed-user" } },
    })).toEqual({
      eventId: "menu-event-1",
      operatorId: "allowed-user",
      eventKey: "session_select",
      receivedAt: 1001,
    });
  });

  it("normalizes the v2 card callback wrapper including form values", () => {
    expect(normalizeCardActionEvent({
      schema: "2.0",
      header: { event_id: "card-event-1", create_time: "1002" },
      event: {
        context: { open_message_id: "message-2", open_chat_id: "chat-2" },
        operator: { open_id: "allowed-user" },
        action: {
          value: { action: "session.rename", session_id: "session-1" },
          form_value: { title: "新的标题" },
        },
      },
    })).toEqual({
      eventId: "card-event-1",
      messageId: "message-2",
      chatId: "chat-2",
      operatorId: "allowed-user",
      actionValue: { action: "session.rename", session_id: "session-1" },
      formValue: { title: "新的标题" },
      receivedAt: 1002,
    });
  });

  it("rejects malformed interactive events", () => {
    expect(normalizeMenuEvent({ event_key: "help" })).toBeNull();
    expect(normalizeCardActionEvent({ action: { value: { action: "session.new" } } })).toBeNull();
  });
});
