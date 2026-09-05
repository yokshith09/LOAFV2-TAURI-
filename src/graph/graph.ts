/**
 * What Loaf remembers, and how the pieces connect.
 *
 * THE PROBLEM THIS SOLVES. Everything Loaf keeps today is a list: meetings in
 * one array, notes in another, screen time in a third. A list answers "what
 * happened" and nothing else. It cannot answer "what do I keep discussing with
 * Priya", or "every time I open Figma I end up in a two-hour call", because
 * those are questions about RELATIONSHIPS between things, and a list has none.
 *
 * So this is a graph: entities (a person, an app, a domain, a meeting, a
 * topic) joined by edges that say how they met. It is small, boring, and
 * deliberately not a database — see the note on persistence below.
 *
 * IT IS PURE, AND THAT IS THE POINT. No storage, no clock, no window. `now` is
 * passed in. The entire memory model can therefore be exercised in a
 * millisecond by tests, which matters more here than anywhere else in the app:
 * this is the part that accumulates for months, and a bug in it is a bug you
 * discover long after the data it corrupted is the only copy you have.
 *
 * WHAT IT DOES NOT DO, said plainly. It does not infer. It records that two
 * things co-occurred and how often; it does not conclude that one caused the
 * other, and it never invents an entity that was not named in something the
 * user wrote or an app they actually used. Everything in here is derived from
 * text the user typed or a transcript of their own voice — the same rule the
 * dashboard follows about measured time. See `extract.ts` for the honest
 * limits of the extraction step.
 */

/** The kinds of thing Loaf can hold a memory about. */
export const ENTITY_KINDS = ["person", "app", "domain", "meeting", "topic", "task"] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export function isEntityKind(v: unknown): v is EntityKind {
  return typeof v === "string" && (ENTITY_KINDS as readonly string[]).includes(v);
}

/**
 * How two entities are related.
 *
 * Kept to a handful, and each one has to be something Loaf OBSERVED rather
 * than concluded. "mentioned-in" is a fact about a transcript. "worked-on"
 * would be an interpretation, so it is not here.
 */
export const EDGE_KINDS = ["mentioned-in", "co-occurred", "followed-by", "about"] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export interface Entity {
  readonly id: string;
  readonly kind: EntityKind;
  /** As it was written, for showing. Matching uses the id. */
  readonly name: string;
  readonly firstSeen: number;
  readonly lastSeen: number;
  /** How many times Loaf has seen this named. Drives "what matters". */
  readonly mentions: number;
}

export interface Edge {
  readonly from: string;
  readonly to: string;
  readonly kind: EdgeKind;
  readonly lastSeen: number;
  /** How many times this pairing has been observed. */
  readonly weight: number;
}

/**
 * A stable id for an entity.
 *
 * Case and surrounding punctuation are dropped so that "Priya", "priya," and
 * "PRIYA" are one person rather than three. The KIND is part of the id because
 * a person called Chrome and the browser called Chrome are not the same thing,
 * and merging them would produce exactly the kind of nonsense that makes
 * people stop trusting a memory feature.
 */
export function entityId(kind: EntityKind, name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s.-]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return `${kind}:${slug}`;
}

/** One observation to fold in. */
export interface Observation {
  readonly kind: EntityKind;
  readonly name: string;
}

/**
 * The graph itself.
 *
 * Held in memory and serialised whole. That is a deliberate ceiling rather
 * than an oversight: this holds months of one person's meetings and notes, not
 * a social network, and at that size a JSON blob loads in a millisecond and
 * needs no schema migration, no native dependency, and no second process. If
 * it ever stops fitting, the shape here is already the shape of two tables.
 */
export class KnowledgeGraph {
  private readonly entities = new Map<string, Entity>();
  private readonly edges = new Map<string, Edge>();

  /**
   * Record that something was named, returning its id.
   *
   * Seeing the same thing again does not duplicate it — it raises the count
   * and moves `lastSeen`, which is what makes "who do I talk to most" a
   * question this can answer.
   */
  observe(o: Observation, now: number): string {
    const id = entityId(o.kind, o.name);
    const existing = this.entities.get(id);
    this.entities.set(id, {
      id,
      kind: o.kind,
      // The first spelling wins, so a name does not flicker between
      // capitalisations every time it is seen again.
      name: existing?.name ?? o.name,
      firstSeen: existing?.firstSeen ?? now,
      lastSeen: now,
      mentions: (existing?.mentions ?? 0) + 1,
    });
    return id;
  }

  /**
   * Record that two things were seen together.
   *
   * Undirected pairs — "co-occurred" and "followed-by" aside — are stored with
   * the endpoints sorted, so linking A to B and later B to A strengthens one
   * edge instead of creating two that each look half as important.
   */
  link(from: string, to: string, kind: EdgeKind, now: number): void {
    if (from === to) return;
    const directed = kind === "followed-by" || kind === "mentioned-in";
    const [a, b] = directed ? [from, to] : [from, to].sort();
    const key = `${kind}|${a}|${b}`;
    const existing = this.edges.get(key);
    this.edges.set(key, {
      from: a!,
      to: b!,
      kind,
      lastSeen: now,
      weight: (existing?.weight ?? 0) + 1,
    });
  }

  get(id: string): Entity | null {
    return this.entities.get(id) ?? null;
  }

  all(): readonly Entity[] {
    return [...this.entities.values()];
  }

  allEdges(): readonly Edge[] {
    return [...this.edges.values()];
  }

  /**
   * What a thing is connected to, strongest first.
   *
   * The answer to "what do I keep discussing with Priya" and "what does this
   * meeting touch", which is the entire reason for a graph over a list.
   */
  neighbours(id: string, limit = 10): ReadonlyArray<{ entity: Entity; weight: number }> {
    const scores = new Map<string, number>();
    for (const e of this.edges.values()) {
      const other = e.from === id ? e.to : e.to === id ? e.from : null;
      if (other === null) continue;
      scores.set(other, (scores.get(other) ?? 0) + e.weight);
    }
    return [...scores.entries()]
      .map(([otherId, weight]) => ({ entity: this.entities.get(otherId), weight }))
      .filter((r): r is { entity: Entity; weight: number } => r.entity !== undefined)
      .sort((a, b) => b.weight - a.weight || a.entity.name.localeCompare(b.entity.name))
      .slice(0, limit);
  }

  /**
   * Entities whose name contains the query.
   *
   * Substring rather than fuzzy, on purpose. A memory that answers a search
   * with something that merely looks similar is worse than one that answers
   * with nothing: the whole value here is that what comes back was actually
   * written down.
   */
  search(query: string, limit = 20): readonly Entity[] {
    const q = query.toLowerCase().trim();
    if (q.length === 0) return [];
    return this.all()
      .filter((e) => e.name.toLowerCase().includes(q))
      .sort((a, b) => b.mentions - a.mentions || b.lastSeen - a.lastSeen)
      .slice(0, limit);
  }

  /** The most-named things of a kind. Drives "what matters lately". */
  top(kind: EntityKind, limit = 5): readonly Entity[] {
    return this.all()
      .filter((e) => e.kind === kind)
      .sort((a, b) => b.mentions - a.mentions || b.lastSeen - a.lastSeen)
      .slice(0, limit);
  }

  /**
   * Forget everything last seen before the cutoff.
   *
   * The graph is derived from transcripts and notes, so it has to honour the
   * same retention window they do — otherwise deleting a transcript would
   * leave its people and topics behind, and "delete it" would be a promise
   * Loaf only half kept. Edges go with whichever endpoint went.
   */
  prune(before: number): number {
    let dropped = 0;
    for (const [id, e] of this.entities) {
      if (e.lastSeen < before) {
        this.entities.delete(id);
        dropped += 1;
      }
    }
    for (const [key, edge] of this.edges) {
      if (!this.entities.has(edge.from) || !this.entities.has(edge.to)) {
        this.edges.delete(key);
      }
    }
    return dropped;
  }

  toJSON(): { entities: Entity[]; edges: Edge[] } {
    return { entities: this.all() as Entity[], edges: this.allEdges() as Edge[] };
  }

  /**
   * Rebuild from what was saved, discarding anything malformed.
   *
   * Defended the same way every other stored thing in this codebase is: a file
   * that has been hand-edited, half-written by a crash, or produced by a later
   * version must cost the user their memory graph at worst, never their
   * launch.
   */
  static fromJSON(raw: unknown): KnowledgeGraph {
    const g = new KnowledgeGraph();
    if (typeof raw !== "object" || raw === null) return g;
    const o = raw as Record<string, unknown>;

    if (Array.isArray(o.entities)) {
      for (const item of o.entities) {
        if (typeof item !== "object" || item === null) continue;
        const e = item as Record<string, unknown>;
        if (typeof e.id !== "string" || !isEntityKind(e.kind)) continue;
        if (typeof e.name !== "string" || e.name.length === 0) continue;
        const first = typeof e.firstSeen === "number" ? e.firstSeen : 0;
        const last = typeof e.lastSeen === "number" ? e.lastSeen : first;
        const mentions = typeof e.mentions === "number" && e.mentions > 0 ? e.mentions : 1;
        g.entities.set(e.id, {
          id: e.id,
          kind: e.kind,
          name: e.name,
          firstSeen: first,
          lastSeen: last,
          mentions,
        });
      }
    }

    if (Array.isArray(o.edges)) {
      for (const item of o.edges) {
        if (typeof item !== "object" || item === null) continue;
        const e = item as Record<string, unknown>;
        if (typeof e.from !== "string" || typeof e.to !== "string") continue;
        if (typeof e.kind !== "string" || !(EDGE_KINDS as readonly string[]).includes(e.kind)) {
          continue;
        }
        // An edge to an entity that did not survive is not an edge.
        if (!g.entities.has(e.from) || !g.entities.has(e.to)) continue;
        const weight = typeof e.weight === "number" && e.weight > 0 ? e.weight : 1;
        const lastSeen = typeof e.lastSeen === "number" ? e.lastSeen : 0;
        g.edges.set(`${e.kind}|${e.from}|${e.to}`, {
          from: e.from,
          to: e.to,
          kind: e.kind as EdgeKind,
          lastSeen,
          weight,
        });
      }
    }
    return g;
  }
}
