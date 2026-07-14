import type { FeishuPort } from "./gateway-service.js";

interface CardPage {
  cardId: string;
  sequence: number;
  sentContent: string;
  closed: boolean;
}

export class CardStreamWriter {
  readonly #feishu: FeishuPort;
  readonly #intervalMs: number;
  readonly #chatId: string | undefined;
  readonly #maxPageBytes: number;
  readonly #onCardCreated: ((cardId: string) => void) | undefined;
  readonly #onCardEvent:
    | ((event: { cardId: string; sequence: number; phase: "update" | "finish"; contentBytes: number }) => void)
    | undefined;
  readonly #cards: CardPage[];
  #content = "";
  #timer: NodeJS.Timeout | undefined;
  #pending: Promise<void> = Promise.resolve();

  constructor(
    feishu: FeishuPort,
    cardId: string,
    intervalMs: number,
    options: {
      chatId?: string;
      maxPageBytes?: number;
      onCardCreated?: (cardId: string) => void;
      onCardEvent?: (event: {
        cardId: string;
        sequence: number;
        phase: "update" | "finish";
        contentBytes: number;
      }) => void;
    } = {},
  ) {
    this.#feishu = feishu;
    this.#intervalMs = Math.max(intervalMs, 100);
    this.#chatId = options.chatId;
    this.#maxPageBytes = Math.max(1, options.maxPageBytes ?? 22_000);
    this.#onCardCreated = options.onCardCreated;
    this.#onCardEvent = options.onCardEvent;
    this.#cards = [{ cardId, sequence: 0, sentContent: "", closed: false }];
  }

  append(delta: string): void {
    if (!delta) return;
    this.#content += delta;
    this.#scheduleUpdate();
  }

  replace(content: string): void {
    this.#content = content;
    this.#scheduleUpdate();
  }

  #scheduleUpdate(): void {
    if (!this.#timer) {
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        this.#enqueueUpdate();
      }, this.#intervalMs);
    }
  }

  get content(): string {
    return this.#content;
  }

  async finish(status: string): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#enqueueUpdate();
    await this.#pending;
    for (const card of this.#cards) {
      if (card.closed) continue;
      card.sequence += 1;
      await this.#feishu.finishAnswerCard(
        card.cardId,
        card.sentContent,
        card.sequence,
        status,
      );
      this.#onCardEvent?.({
        cardId: card.cardId,
        sequence: card.sequence,
        phase: "finish",
        contentBytes: Buffer.byteLength(card.sentContent, "utf8"),
      });
      card.closed = true;
    }
  }

  #enqueueUpdate(): void {
    const snapshot = this.#content;
    this.#pending = this.#pending.then(() => this.#syncPages(snapshot));
  }

  async #syncPages(snapshot: string): Promise<void> {
    const pages = splitUtf8(snapshot, this.#maxPageBytes);
    for (let index = 0; index < pages.length; index += 1) {
      if (!this.#cards[index]) {
        const previous = this.#cards[index - 1];
        if (previous && !previous.closed) {
          previous.sequence += 1;
          await this.#feishu.finishAnswerCard(
            previous.cardId,
            previous.sentContent,
            previous.sequence,
            "continued",
          );
          this.#onCardEvent?.({
            cardId: previous.cardId,
            sequence: previous.sequence,
            phase: "finish",
            contentBytes: Buffer.byteLength(previous.sentContent, "utf8"),
          });
          previous.closed = true;
        }
        if (!this.#chatId) throw new Error("chatId is required for continuation cards");
        const cardId = await this.#feishu.createAnswerCard(this.#chatId);
        this.#onCardCreated?.(cardId);
        this.#cards.push({ cardId, sequence: 0, sentContent: "", closed: false });
      }
      const card = this.#cards[index];
      const page = pages[index] ?? "";
      if (!card || card.closed || card.sentContent === page) continue;
      card.sentContent = page;
      card.sequence += 1;
      await this.#feishu.updateAnswerCard(card.cardId, page, card.sequence);
      this.#onCardEvent?.({
        cardId: card.cardId,
        sequence: card.sequence,
        phase: "update",
        contentBytes: Buffer.byteLength(page, "utf8"),
      });
    }
  }
}

export function splitUtf8(value: string, maxBytes: number): string[] {
  if (!value) return [""];
  const pages: string[] = [];
  let page = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (page && bytes + characterBytes > maxBytes) {
      pages.push(page);
      page = "";
      bytes = 0;
    }
    page += character;
    bytes += characterBytes;
  }
  if (page || pages.length === 0) pages.push(page);
  return pages;
}
