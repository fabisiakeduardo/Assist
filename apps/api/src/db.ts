import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";

// ─── Persistência ───────────────────────────────────────────────────────────
// SQLite embutido do Node (node:sqlite): zero dependências nativas, arquivo
// único em disco — conversas, chamados e estado sobrevivem a reinícios.

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  mkdirSync(path.dirname(config.databaseFile), { recursive: true });
  db = new DatabaseSync(config.databaseFile);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

/** Para testes: banco em memória. */
export function openMemoryDb(): DatabaseSync {
  const mem = new DatabaseSync(":memory:");
  mem.exec("PRAGMA foreign_keys = ON");
  migrate(mem);
  return mem;
}

function migrate(d: DatabaseSync): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('employee','analyst')),
      team TEXT NOT NULL DEFAULT '',
      support_level TEXT CHECK (support_level IN ('N1','N2')),
      avatar_bg TEXT NOT NULL DEFAULT '#DCE9F7',
      avatar_fg TEXT NOT NULL DEFAULT '#0062C4',
      password_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      analyst_id TEXT REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'with_agent'
        CHECK (status IN ('with_agent','waiting_analyst','with_analyst','closed')),
      queue TEXT CHECK (queue IN ('N1','N2')),
      handoff_summary TEXT,
      handoff_reason TEXT,
      handoff_at TEXT,
      ticket_id TEXT,
      agent_context TEXT,
      unread_for_analyst INTEGER NOT NULL DEFAULT 0,
      last_message_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      closed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id);
    CREATE INDEX IF NOT EXISTS idx_conv_status ON conversations(status);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender TEXT NOT NULL CHECK (sender IN ('user','agent','analyst','system')),
      sender_id TEXT,
      text TEXT NOT NULL,
      steps TEXT,
      card TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at);

    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('INC','REQ')),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      subcategory TEXT,
      priority TEXT NOT NULL CHECK (priority IN ('critica','alta','media','baixa')),
      status TEXT NOT NULL,
      requester_id TEXT NOT NULL REFERENCES users(id),
      conversation_id TEXT REFERENCES conversations(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,
      due_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_requester ON tickets(requester_id, status);

    CREATE TABLE IF NOT EXISTS ticket_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      actor TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tevent_ticket ON ticket_events(ticket_id);

    CREATE TABLE IF NOT EXISTS drafts (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('INC','REQ')),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      priority TEXT NOT NULL,
      affected TEXT NOT NULL,
      due_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','cancelled')),
      ticket_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_draft_conv ON drafts(conversation_id, status);

    CREATE TABLE IF NOT EXISTS help_articles (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      keywords TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS usage_counters (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day)
    );

    CREATE TABLE IF NOT EXISTS ticket_seq (
      prefix TEXT PRIMARY KEY,
      next INTEGER NOT NULL
    );
  `);

  // migração incremental: bancos antigos não tinham password_hash
  const userCols = d.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  if (!userCols.some((c) => c.name === "password_hash")) {
    d.exec("ALTER TABLE users ADD COLUMN password_hash TEXT");
  }
}
