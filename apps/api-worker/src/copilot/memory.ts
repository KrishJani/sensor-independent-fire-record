/**
 * Long-term memory (SPEC §4.3) in the agent's own Durable Object SQLite.
 * Table: memories(id, kind, content, created_at). Deduped, capped at 50 rows.
 */

export const MEMORY_KINDS = ["aoi", "preference", "finding"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface Memory {
  id: number;
  kind: MemoryKind;
  content: string;
  created_at: string;
}

/** The agent's `this.sql` tagged template. */
export type SqlTag = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

export const MAX_MEMORIES = 50;
export const MAX_MEMORY_CHARS = 500;

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export class MemoryStore {
  constructor(private readonly sql: SqlTag) {}

  init(): void {
    this.sql`CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK (kind IN ('aoi', 'preference', 'finding')),
      content TEXT NOT NULL,
      norm TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )`;
    this.sql`CREATE UNIQUE INDEX IF NOT EXISTS memories_kind_norm ON memories (kind, norm)`;
  }

  /** Insert or refresh (dedupe on kind + normalized text), then trim to the cap. */
  remember(kind: MemoryKind, content: string): { saved: Memory; duplicate: boolean } {
    const text = content.trim().slice(0, MAX_MEMORY_CHARS);
    if (!text) throw new Error("empty memory");
    const norm = normalize(text);
    const existing = this.sql<Memory>`SELECT id, kind, content, created_at FROM memories
      WHERE kind = ${kind} AND norm = ${norm}`;
    if (existing[0]) {
      // Bump recency so a re-confirmed fact survives trimming.
      this.sql`UPDATE memories SET created_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), content = ${text}
        WHERE id = ${existing[0].id}`;
      return { saved: { ...existing[0], content: text }, duplicate: true };
    }
    this.sql`INSERT INTO memories (kind, content, norm) VALUES (${kind}, ${text}, ${norm})`;
    this.sql`DELETE FROM memories WHERE id NOT IN (
      SELECT id FROM memories ORDER BY created_at DESC, id DESC LIMIT ${MAX_MEMORIES})`;
    const saved = this.sql<Memory>`SELECT id, kind, content, created_at FROM memories
      WHERE kind = ${kind} AND norm = ${norm}`;
    return { saved: saved[0]!, duplicate: false };
  }

  list(): Memory[] {
    return this.sql<Memory>`SELECT id, kind, content, created_at FROM memories
      ORDER BY created_at DESC, id DESC`;
  }

  /** Keyword search: rank by number of query terms (≥2 chars) found. */
  search(query: string, limit = 10): Memory[] {
    const terms = [...new Set(normalize(query).split(/[^\p{L}\p{N}]+/u))].filter((t) => t.length >= 2);
    const all = this.list();
    if (terms.length === 0) return all.slice(0, limit);
    return all
      .map((m) => {
        const hay = normalize(`${m.kind} ${m.content}`);
        return { m, score: terms.filter((t) => hay.includes(t)).length };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.m);
  }
}
