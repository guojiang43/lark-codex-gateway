import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { assertRunTransition, type RunState } from "../domain/run-state.js";

export interface ProjectInput {
  projectId: string;
  displayName: string;
  workspacePath: string;
  hostId: string;
}

export interface SessionInput {
  sessionId: string;
  codexThreadId: string;
  projectId: string;
  title: string;
  mode?: "write" | "read_only";
  now: number;
}

export interface InboundEventInput {
  eventId: string;
  messageId: string;
  chatId: string;
  senderId: string;
  receivedAt: number;
}

export interface RunRecord {
  runId: string;
  eventId: string;
  sessionId: string;
  state: RunState;
  turnId: string | null;
  cardId: string | null;
  createdAt: number;
  updatedAt: number;
  errorCode: string | null;
}

export interface SessionRecord {
  sessionId: string;
  codexThreadId: string;
  projectId: string;
  title: string;
  mode: "write" | "read_only";
  status: "ACTIVE" | "ARCHIVED";
  createdAt: number;
  updatedAt: number;
}

export interface SessionListRecord extends SessionRecord {
  runState: RunState | null;
}

export interface ActiveRunRecord {
  runId: string;
  sessionId: string;
  codexThreadId: string;
  turnId: string;
  state: "RUNNING" | "WAITING_APPROVAL";
}

export type ApprovalDecision = "accept" | "decline" | "cancel";

export interface ApprovalRecord {
  approvalId: string;
  runId: string;
  requestMethod: string;
  decision: ApprovalDecision | null;
  expiresAt: number;
  decidedAt: number | null;
}

export interface ApprovalRunContext {
  runId: string;
  state: RunState;
  messageId: string;
  chatId: string;
  reactionId: string | null;
}

export interface ReactionRecord {
  messageId: string;
  reactionId: string;
  runId: string;
  createdAt: number;
}

export interface StaleRunArtifact {
  runId: string;
  cardId: string | null;
  messageId: string;
  chatId: string;
}

export interface RunCardEventStats {
  updateCount: number;
  finishCount: number;
  maxSequence: number;
  firstEventAt: number | null;
  lastEventAt: number | null;
}

interface RunRow {
  run_id: string;
  event_id: string;
  session_id: string;
  state: RunState;
  turn_id: string | null;
  card_id: string | null;
  created_at: number;
  updated_at: number;
  error_code: string | null;
}

export class StateStore {
  readonly #db: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.#db = new DatabaseSync(databasePath);
    this.#db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        workspace_path TEXT NOT NULL UNIQUE,
        host_id TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        codex_thread_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        title TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'write' CHECK (mode IN ('write', 'read_only')),
        status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bindings (
        scope_key TEXT PRIMARY KEY,
        active_session_id TEXT NOT NULL REFERENCES sessions(session_id),
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS inbound_events (
        event_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL UNIQUE,
        chat_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        run_id TEXT UNIQUE
      );

      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE REFERENCES inbound_events(event_id),
        session_id TEXT NOT NULL REFERENCES sessions(session_id),
        turn_id TEXT,
        state TEXT NOT NULL CHECK (state IN ('QUEUED','RUNNING','WAITING_APPROVAL','COMPLETED','FAILED','CANCELLED')),
        card_id TEXT,
        error_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS reactions (
        message_id TEXT PRIMARY KEY,
        reaction_id TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        created_at INTEGER NOT NULL,
        cleared_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS run_cards (
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        card_id TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, card_id)
      );

      CREATE TABLE IF NOT EXISTS run_card_events (
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        card_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('update', 'finish')),
        content_bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (card_id, sequence, phase)
      );

      CREATE TABLE IF NOT EXISTS approvals (
        approval_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        request_method TEXT NOT NULL,
        decision TEXT,
        expires_at INTEGER NOT NULL,
        decided_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS interaction_events (
        event_id TEXT PRIMARY KEY,
        event_kind TEXT NOT NULL,
        operator_id TEXT NOT NULL,
        received_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS runs_state_idx ON runs(state);
      CREATE INDEX IF NOT EXISTS sessions_project_idx ON sessions(project_id, status, updated_at DESC);
    `);
    const sessionColumns = this.#db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    if (!sessionColumns.some((column) => column.name === "mode")) {
      this.#db.exec("ALTER TABLE sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'write' CHECK (mode IN ('write', 'read_only'))");
    }
  }

  upsertProject(project: ProjectInput): void {
    this.#db
      .prepare(`
        INSERT INTO projects(project_id, display_name, workspace_path, host_id)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET
          display_name = excluded.display_name,
          workspace_path = excluded.workspace_path,
          host_id = excluded.host_id
      `)
      .run(project.projectId, project.displayName, project.workspacePath, project.hostId);
  }

  createSession(session: SessionInput): void {
    this.#db
      .prepare(`
        INSERT INTO sessions(session_id, codex_thread_id, project_id, title, mode, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        session.sessionId,
        session.codexThreadId,
        session.projectId,
        session.title,
        session.mode ?? "write",
        session.now,
        session.now,
      );
  }

  ensureDiscoveredSession(session: SessionInput): SessionRecord {
    const existing = this.getSessionByCodexThreadId(session.codexThreadId);
    if (existing) {
      const discoveredTitle = session.title.trim();
      const title = isPlaceholderSessionTitle(existing.title) &&
        discoveredTitle.length > 0 &&
        !isSyntheticSessionTitle(discoveredTitle)
        ? discoveredTitle
        : existing.title;
      this.#db
        .prepare("UPDATE sessions SET title = ?, updated_at = MAX(updated_at, ?) WHERE session_id = ?")
        .run(title, session.now, existing.sessionId);
      return this.getSession(existing.sessionId)!;
    }
    this.createSession(session);
    return this.getSession(session.sessionId)!;
  }

  replaceSessionThread(sessionId: string, codexThreadId: string, now: number): void {
    const result = this.#db
      .prepare("UPDATE sessions SET codex_thread_id = ?, updated_at = ? WHERE session_id = ?")
      .run(codexThreadId, now, sessionId);
    if (result.changes !== 1) throw new Error(`session not found: ${sessionId}`);
  }

  bindScope(scopeKey: string, sessionId: string, now: number): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db
        .prepare(`
          INSERT INTO bindings(scope_key, active_session_id, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(scope_key) DO UPDATE SET
            active_session_id = excluded.active_session_id,
            updated_at = excluded.updated_at
        `)
        .run(scopeKey, sessionId, now);
      this.#db.prepare("UPDATE sessions SET updated_at = ? WHERE session_id = ?").run(now, sessionId);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  getActiveSessionId(scopeKey: string): string | null {
    const row = this.#db
      .prepare("SELECT active_session_id FROM bindings WHERE scope_key = ?")
      .get(scopeKey) as { active_session_id: string } | undefined;
    return row?.active_session_id ?? null;
  }

  getSession(sessionId: string): SessionRecord | null {
    const row = this.#db
      .prepare(`
        SELECT session_id, codex_thread_id, project_id, title, mode, status, created_at, updated_at
        FROM sessions WHERE session_id = ?
      `)
      .get(sessionId) as
      | {
          session_id: string;
          codex_thread_id: string;
          project_id: string;
          title: string;
          mode: "write" | "read_only";
          status: "ACTIVE" | "ARCHIVED";
          created_at: number;
          updated_at: number;
        }
      | undefined;
    return row
      ? {
          sessionId: row.session_id,
          codexThreadId: row.codex_thread_id,
          projectId: row.project_id,
          title: row.title,
          mode: row.mode,
          status: row.status,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
      : null;
  }

  getSessionByCodexThreadId(codexThreadId: string): SessionRecord | null {
    const row = this.#db
      .prepare("SELECT session_id FROM sessions WHERE codex_thread_id = ?")
      .get(codexThreadId) as { session_id: string } | undefined;
    return row ? this.getSession(row.session_id) : null;
  }

  listSessions(projectId: string, options: { includeArchived?: boolean; limit?: number; offset?: number } = {}): SessionListRecord[] {
    const includeArchived = options.includeArchived ?? false;
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const offset = Math.max(options.offset ?? 0, 0);
    const rows = this.#db
      .prepare(`
        SELECT
          s.session_id,
          s.codex_thread_id,
          s.project_id,
          s.title,
          s.mode,
          s.status,
          s.created_at,
          s.updated_at,
          (
            SELECT r.state FROM runs r
            WHERE r.session_id = s.session_id
              AND r.state IN ('QUEUED', 'RUNNING', 'WAITING_APPROVAL')
            ORDER BY r.updated_at DESC LIMIT 1
          ) AS run_state
        FROM sessions s
        WHERE s.project_id = ? AND (? = 1 OR s.status = 'ACTIVE')
        ORDER BY s.updated_at DESC, s.created_at DESC
        LIMIT ? OFFSET ?
      `)
      .all(projectId, includeArchived ? 1 : 0, limit, offset) as Array<{
        session_id: string;
        codex_thread_id: string;
        project_id: string;
        title: string;
        mode: "write" | "read_only";
        status: "ACTIVE" | "ARCHIVED";
        created_at: number;
        updated_at: number;
        run_state: RunState | null;
      }>;
    return rows.map((row) => ({
      sessionId: row.session_id,
      codexThreadId: row.codex_thread_id,
      projectId: row.project_id,
      title: row.title,
      mode: row.mode,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      runState: row.run_state,
    }));
  }

  renameSession(sessionId: string, title: string, now: number): void {
    const normalized = title.trim();
    if (!normalized || normalized.length > 80) {
      throw new Error("session title must be between 1 and 80 characters");
    }
    const result = this.#db
      .prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE session_id = ?")
      .run(normalized, now, sessionId);
    if (result.changes !== 1) throw new Error(`session not found: ${sessionId}`);
  }

  archiveSession(sessionId: string, now: number): void {
    const result = this.#db
      .prepare("UPDATE sessions SET status = 'ARCHIVED', updated_at = ? WHERE session_id = ? AND status = 'ACTIVE'")
      .run(now, sessionId);
    if (result.changes !== 1) throw new Error(`active session not found: ${sessionId}`);
  }

  hasActiveRunForSession(sessionId: string): boolean {
    const row = this.#db
      .prepare(`
        SELECT 1 FROM runs
        WHERE session_id = ?
          AND state IN ('QUEUED', 'RUNNING', 'WAITING_APPROVAL')
        LIMIT 1
      `)
      .get(sessionId);
    return row !== undefined;
  }

  hasAnyRunForSession(sessionId: string): boolean {
    const row = this.#db
      .prepare("SELECT 1 FROM runs WHERE session_id = ? LIMIT 1")
      .get(sessionId);
    return row !== undefined;
  }

  isSessionBound(sessionId: string): boolean {
    const row = this.#db
      .prepare("SELECT 1 FROM bindings WHERE active_session_id = ? LIMIT 1")
      .get(sessionId);
    return row !== undefined;
  }

  claimInteractionEvent(input: {
    eventId: string;
    eventKind: "menu" | "card";
    operatorId: string;
    receivedAt: number;
  }): boolean {
    const result = this.#db
      .prepare(`
        INSERT OR IGNORE INTO interaction_events(event_id, event_kind, operator_id, received_at)
        VALUES (?, ?, ?, ?)
      `)
      .run(input.eventId, input.eventKind, input.operatorId, input.receivedAt);
    return result.changes === 1;
  }

  getLatestChatForSender(senderId: string): string | null {
    const row = this.#db
      .prepare(`
        SELECT chat_id FROM inbound_events
        WHERE sender_id = ?
        ORDER BY received_at DESC LIMIT 1
      `)
      .get(senderId) as { chat_id: string } | undefined;
    return row?.chat_id ?? null;
  }

  getLatestActiveRunForChat(chatId: string): ActiveRunRecord | null {
    const row = this.#db
      .prepare(`
        SELECT r.run_id, r.session_id, s.codex_thread_id, r.turn_id, r.state
        FROM runs r
        JOIN sessions s ON s.session_id = r.session_id
        JOIN inbound_events e ON e.event_id = r.event_id
        WHERE e.chat_id = ?
          AND r.state IN ('RUNNING', 'WAITING_APPROVAL')
          AND r.turn_id IS NOT NULL
        ORDER BY r.updated_at DESC LIMIT 1
      `)
      .get(chatId) as
      | {
          run_id: string;
          session_id: string;
          codex_thread_id: string;
          turn_id: string;
          state: "RUNNING" | "WAITING_APPROVAL";
        }
      | undefined;
    return row
      ? {
          runId: row.run_id,
          sessionId: row.session_id,
          codexThreadId: row.codex_thread_id,
          turnId: row.turn_id,
          state: row.state,
        }
      : null;
  }

  getApprovalRunContext(threadId: string, turnId: string): ApprovalRunContext | null {
    const row = this.#db
      .prepare(`
        SELECT
          r.run_id,
          r.state,
          e.message_id,
          e.chat_id,
          reaction.reaction_id
        FROM runs r
        JOIN sessions s ON s.session_id = r.session_id
        JOIN inbound_events e ON e.event_id = r.event_id
        LEFT JOIN reactions reaction
          ON reaction.run_id = r.run_id AND reaction.cleared_at IS NULL
        WHERE s.codex_thread_id = ? AND r.turn_id = ?
        ORDER BY r.updated_at DESC LIMIT 1
      `)
      .get(threadId, turnId) as
      | {
          run_id: string;
          state: RunState;
          message_id: string;
          chat_id: string;
          reaction_id: string | null;
        }
      | undefined;
    return row
      ? {
          runId: row.run_id,
          state: row.state,
          messageId: row.message_id,
          chatId: row.chat_id,
          reactionId: row.reaction_id,
        }
      : null;
  }

  createApproval(input: {
    approvalId: string;
    runId: string;
    requestMethod: string;
    expiresAt: number;
  }): void {
    this.#db
      .prepare(`
        INSERT INTO approvals(approval_id, run_id, request_method, expires_at)
        VALUES (?, ?, ?, ?)
      `)
      .run(input.approvalId, input.runId, input.requestMethod, input.expiresAt);
  }

  getApproval(approvalId: string): ApprovalRecord | null {
    const row = this.#db
      .prepare(`
        SELECT approval_id, run_id, request_method, decision, expires_at, decided_at
        FROM approvals WHERE approval_id = ?
      `)
      .get(approvalId) as
      | {
          approval_id: string;
          run_id: string;
          request_method: string;
          decision: ApprovalDecision | null;
          expires_at: number;
          decided_at: number | null;
        }
      | undefined;
    return row
      ? {
          approvalId: row.approval_id,
          runId: row.run_id,
          requestMethod: row.request_method,
          decision: row.decision,
          expiresAt: row.expires_at,
          decidedAt: row.decided_at,
        }
      : null;
  }

  decideApproval(approvalId: string, decision: ApprovalDecision, now: number): boolean {
    const result = this.#db
      .prepare(`
        UPDATE approvals SET decision = ?, decided_at = ?
        WHERE approval_id = ? AND decision IS NULL
      `)
      .run(decision, now, approvalId);
    return result.changes === 1;
  }

  getUnclearedReactionForRun(runId: string): ReactionRecord | null {
    const row = this.#db
      .prepare(`
        SELECT message_id, reaction_id, run_id, created_at
        FROM reactions
        WHERE run_id = ? AND cleared_at IS NULL
        ORDER BY created_at DESC LIMIT 1
      `)
      .get(runId) as
      | { message_id: string; reaction_id: string; run_id: string; created_at: number }
      | undefined;
    return row
      ? {
          messageId: row.message_id,
          reactionId: row.reaction_id,
          runId: row.run_id,
          createdAt: row.created_at,
        }
      : null;
  }

  listUnclearedReactions(): ReactionRecord[] {
    const rows = this.#db
      .prepare(`
        SELECT message_id, reaction_id, run_id, created_at
        FROM reactions WHERE cleared_at IS NULL
        ORDER BY created_at
      `)
      .all() as Array<{ message_id: string; reaction_id: string; run_id: string; created_at: number }>;
    return rows.map((row) => ({
      messageId: row.message_id,
      reactionId: row.reaction_id,
      runId: row.run_id,
      createdAt: row.created_at,
    }));
  }

  listStaleRunArtifacts(): StaleRunArtifact[] {
    const rows = this.#db
      .prepare(`
        SELECT r.run_id, COALESCE(cards.card_id, r.card_id) AS card_id, e.message_id, e.chat_id
        FROM runs r
        JOIN inbound_events e ON e.event_id = r.event_id
        LEFT JOIN run_cards cards ON cards.run_id = r.run_id
        WHERE r.state IN ('QUEUED', 'RUNNING', 'WAITING_APPROVAL')
        ORDER BY r.created_at, cards.created_at
      `)
      .all() as Array<{ run_id: string; card_id: string | null; message_id: string; chat_id: string }>;
    return rows.map((row) => ({
      runId: row.run_id,
      cardId: row.card_id,
      messageId: row.message_id,
      chatId: row.chat_id,
    }));
  }

  expirePendingApprovals(now: number): number {
    const result = this.#db
      .prepare(`
        UPDATE approvals SET decision = 'decline', decided_at = ?
        WHERE decision IS NULL
      `)
      .run(now);
    return Number(result.changes);
  }

  claimInboundEvent(event: InboundEventInput): { claimed: true } | { claimed: false; runId: string | null } {
    const result = this.#db
      .prepare(`
        INSERT OR IGNORE INTO inbound_events(event_id, message_id, chat_id, sender_id, received_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(event.eventId, event.messageId, event.chatId, event.senderId, event.receivedAt);

    if (result.changes === 1) {
      return { claimed: true };
    }
    const existing = this.#db
      .prepare("SELECT run_id FROM inbound_events WHERE event_id = ? OR message_id = ? LIMIT 1")
      .get(event.eventId, event.messageId) as { run_id: string | null } | undefined;
    return { claimed: false, runId: existing?.run_id ?? null };
  }

  createRun(input: { runId: string; eventId: string; sessionId: string; now: number }): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db
        .prepare(`
          INSERT INTO runs(run_id, event_id, session_id, state, created_at, updated_at)
          VALUES (?, ?, ?, 'QUEUED', ?, ?)
        `)
        .run(input.runId, input.eventId, input.sessionId, input.now, input.now);
      this.#db
        .prepare("UPDATE inbound_events SET run_id = ? WHERE event_id = ? AND run_id IS NULL")
        .run(input.runId, input.eventId);
      this.#db
        .prepare("UPDATE sessions SET updated_at = ? WHERE session_id = ?")
        .run(input.now, input.sessionId);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  getRun(runId: string): RunRecord | null {
    const row = this.#db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as RunRow | undefined;
    return row ? mapRun(row) : null;
  }

  transitionRun(runId: string, state: RunState, now: number, errorCode: string | null = null): void {
    const current = this.getRun(runId);
    if (!current) {
      throw new Error(`run not found: ${runId}`);
    }
    assertRunTransition(current.state, state);
    this.#db
      .prepare("UPDATE runs SET state = ?, updated_at = ?, error_code = ? WHERE run_id = ?")
      .run(state, now, errorCode, runId);
  }

  attachTurn(runId: string, turnId: string, now: number): void {
    this.#db.prepare("UPDATE runs SET turn_id = ?, updated_at = ? WHERE run_id = ?").run(turnId, now, runId);
  }

  attachCard(runId: string, cardId: string, now: number): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("UPDATE runs SET card_id = ?, updated_at = ? WHERE run_id = ?").run(cardId, now, runId);
      this.#db
        .prepare("INSERT OR IGNORE INTO run_cards(run_id, card_id, created_at) VALUES (?, ?, ?)")
        .run(runId, cardId, now);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  attachRunCard(runId: string, cardId: string, now: number): void {
    this.#db
      .prepare("INSERT OR IGNORE INTO run_cards(run_id, card_id, created_at) VALUES (?, ?, ?)")
      .run(runId, cardId, now);
  }

  recordRunCardEvent(input: {
    runId: string;
    cardId: string;
    sequence: number;
    phase: "update" | "finish";
    contentBytes: number;
    now: number;
  }): void {
    this.#db
      .prepare(`
        INSERT OR IGNORE INTO run_card_events(
          run_id, card_id, sequence, phase, content_bytes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.runId,
        input.cardId,
        input.sequence,
        input.phase,
        input.contentBytes,
        input.now,
      );
  }

  getRunCardEventStats(runId: string): RunCardEventStats {
    const row = this.#db
      .prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN phase = 'update' THEN 1 ELSE 0 END), 0) AS update_count,
          COALESCE(SUM(CASE WHEN phase = 'finish' THEN 1 ELSE 0 END), 0) AS finish_count,
          COALESCE(MAX(sequence), 0) AS max_sequence,
          MIN(created_at) AS first_event_at,
          MAX(created_at) AS last_event_at
        FROM run_card_events WHERE run_id = ?
      `)
      .get(runId) as {
        update_count: number;
        finish_count: number;
        max_sequence: number;
        first_event_at: number | null;
        last_event_at: number | null;
      };
    return {
      updateCount: row.update_count,
      finishCount: row.finish_count,
      maxSequence: row.max_sequence,
      firstEventAt: row.first_event_at,
      lastEventAt: row.last_event_at,
    };
  }

  recordReaction(input: { messageId: string; reactionId: string; runId: string; now: number }): void {
    this.#db
      .prepare(`
        INSERT INTO reactions(message_id, reaction_id, run_id, created_at, cleared_at)
        VALUES (?, ?, ?, ?, NULL)
        ON CONFLICT(message_id) DO UPDATE SET
          reaction_id = excluded.reaction_id,
          run_id = excluded.run_id,
          created_at = excluded.created_at,
          cleared_at = NULL
      `)
      .run(input.messageId, input.reactionId, input.runId, input.now);
  }

  clearReaction(messageId: string, now: number): void {
    this.#db.prepare("UPDATE reactions SET cleared_at = ? WHERE message_id = ?").run(now, messageId);
  }

  failStaleRuns(now: number): string[] {
    const rows = this.#db
      .prepare("SELECT run_id FROM runs WHERE state IN ('QUEUED', 'RUNNING', 'WAITING_APPROVAL') ORDER BY created_at")
      .all() as Array<{ run_id: string }>;
    const ids = rows.map((row) => row.run_id);
    if (ids.length > 0) {
      this.#db
        .prepare(`
          UPDATE runs
          SET state = 'FAILED', updated_at = ?, error_code = 'gateway_restarted'
          WHERE state IN ('QUEUED', 'RUNNING', 'WAITING_APPROVAL')
        `)
        .run(now);
    }
    return ids;
  }

  close(): void {
    this.#db.close();
  }
}

function isPlaceholderSessionTitle(title: string): boolean {
  return title === "新会话" || title === "只读分析";
}

function isSyntheticSessionTitle(title: string): boolean {
  return isPlaceholderSessionTitle(title) || title.startsWith("Codex Session · ");
}

function mapRun(row: RunRow): RunRecord {
  return {
    runId: row.run_id,
    eventId: row.event_id,
    sessionId: row.session_id,
    state: row.state,
    turnId: row.turn_id,
    cardId: row.card_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    errorCode: row.error_code,
  };
}
