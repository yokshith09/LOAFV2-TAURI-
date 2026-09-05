import { describe, it, expect } from "vitest";
import {
  KnowledgeGraph,
  entityId,
  ENTITY_KINDS,
  isEntityKind,
} from "../src/graph/graph";
import { peopleIn, topicsIn, observationsIn } from "../src/graph/extract";

const T0 = new Date("2026-09-01T10:00:00").getTime();
const day = 24 * 60 * 60 * 1000;

describe("entity identity", () => {
  // "Priya", "priya," and "PRIYA" are one person. Three would make every
  // count wrong and every connection weaker than it really is.
  it("folds case and punctuation into one id", () => {
    expect(entityId("person", "Priya")).toBe(entityId("person", "  priya, "));
    expect(entityId("person", "PRIYA")).toBe(entityId("person", "Priya"));
  });

  // A person called Chrome and the browser called Chrome are not the same
  // thing, and merging them is exactly the nonsense that makes people stop
  // trusting a memory feature.
  it("keeps the kind in the id, so a person and an app never merge", () => {
    expect(entityId("person", "Chrome")).not.toBe(entityId("app", "Chrome"));
  });

  it("accepts only the kinds it knows", () => {
    for (const k of ENTITY_KINDS) expect(isEntityKind(k)).toBe(true);
    for (const junk of ["", "thing", null, 7]) expect(isEntityKind(junk)).toBe(false);
  });
});

describe("remembering things", () => {
  it("counts a second sighting instead of duplicating it", () => {
    const g = new KnowledgeGraph();
    const id = g.observe({ kind: "person", name: "Priya" }, T0);
    g.observe({ kind: "person", name: "priya" }, T0 + day);

    expect(g.all()).toHaveLength(1);
    const e = g.get(id)!;
    expect(e.mentions).toBe(2);
    expect(e.firstSeen).toBe(T0);
    expect(e.lastSeen).toBe(T0 + day);
  });

  // Otherwise a name flickers between capitalisations every time it is seen.
  it("keeps the first spelling it was given", () => {
    const g = new KnowledgeGraph();
    const id = g.observe({ kind: "person", name: "Priya" }, T0);
    g.observe({ kind: "person", name: "PRIYA" }, T0 + 1);
    expect(g.get(id)!.name).toBe("Priya");
  });
});

describe("connections", () => {
  const withPair = (): KnowledgeGraph => {
    const g = new KnowledgeGraph();
    const a = g.observe({ kind: "person", name: "Priya" }, T0);
    const b = g.observe({ kind: "topic", name: "pricing" }, T0);
    g.link(a, b, "co-occurred", T0);
    return g;
  };

  // Linking A to B and later B to A must strengthen ONE edge, or each looks
  // half as important as it is.
  it("treats an undirected pair as the same edge either way round", () => {
    const g = new KnowledgeGraph();
    const a = g.observe({ kind: "person", name: "Priya" }, T0);
    const b = g.observe({ kind: "topic", name: "pricing" }, T0);
    g.link(a, b, "co-occurred", T0);
    g.link(b, a, "co-occurred", T0 + 1);
    expect(g.allEdges()).toHaveLength(1);
    expect(g.allEdges()[0]!.weight).toBe(2);
  });

  it("keeps direction where direction is the meaning", () => {
    const g = new KnowledgeGraph();
    const a = g.observe({ kind: "app", name: "Figma" }, T0);
    const b = g.observe({ kind: "app", name: "Zoom" }, T0);
    g.link(a, b, "followed-by", T0);
    g.link(b, a, "followed-by", T0);
    // Figma→Zoom and Zoom→Figma are different claims about a day.
    expect(g.allEdges()).toHaveLength(2);
  });

  it("refuses to link a thing to itself", () => {
    const g = new KnowledgeGraph();
    const a = g.observe({ kind: "person", name: "Priya" }, T0);
    g.link(a, a, "co-occurred", T0);
    expect(g.allEdges()).toHaveLength(0);
  });

  // The entire reason for a graph rather than a list.
  it("answers what a thing is connected to, strongest first", () => {
    const g = withPair();
    const priya = entityId("person", "Priya");
    const roadmap = g.observe({ kind: "topic", name: "roadmap" }, T0);
    g.link(priya, roadmap, "co-occurred", T0);
    g.link(priya, roadmap, "co-occurred", T0 + 1);

    const near = g.neighbours(priya);
    expect(near[0]!.entity.name).toBe("roadmap");
    expect(near[0]!.weight).toBe(2);
    expect(near[1]!.entity.name).toBe("pricing");
  });

  it("returns nothing for something it has never heard of", () => {
    expect(withPair().neighbours("person:nobody")).toEqual([]);
  });
});

describe("finding things again", () => {
  const seeded = (): KnowledgeGraph => {
    const g = new KnowledgeGraph();
    g.observe({ kind: "topic", name: "pricing" }, T0);
    g.observe({ kind: "topic", name: "pricing" }, T0);
    g.observe({ kind: "topic", name: "roadmap" }, T0);
    g.observe({ kind: "person", name: "Priya" }, T0);
    return g;
  };

  it("matches on a substring of the name", () => {
    expect(seeded().search("pric").map((e) => e.name)).toEqual(["pricing"]);
  });

  // A memory that answers with something merely similar is worse than one
  // that answers with nothing: the value is that it was actually written down.
  it("returns nothing rather than something close", () => {
    expect(seeded().search("priciest")).toEqual([]);
    expect(seeded().search("")).toEqual([]);
  });

  it("puts what is talked about most at the top", () => {
    const top = seeded().top("topic");
    expect(top[0]!.name).toBe("pricing");
    expect(top.map((e) => e.kind)).toEqual(["topic", "topic"]);
  });
});

describe("forgetting", () => {
  // Deleting a transcript has to take its people and topics with it, or
  // "delete it" is a promise Loaf only half keeps.
  it("drops entities last seen before the cutoff", () => {
    const g = new KnowledgeGraph();
    g.observe({ kind: "topic", name: "old" }, T0);
    g.observe({ kind: "topic", name: "recent" }, T0 + 30 * day);

    expect(g.prune(T0 + 10 * day)).toBe(1);
    expect(g.all().map((e) => e.name)).toEqual(["recent"]);
  });

  it("takes the edges of anything it forgot", () => {
    const g = new KnowledgeGraph();
    const old = g.observe({ kind: "topic", name: "old" }, T0);
    const recent = g.observe({ kind: "topic", name: "recent" }, T0 + 30 * day);
    g.link(old, recent, "co-occurred", T0);

    g.prune(T0 + 10 * day);
    expect(g.allEdges()).toEqual([]);
  });
});

describe("surviving what is on disk", () => {
  it("round-trips everything it holds", () => {
    const g = new KnowledgeGraph();
    const a = g.observe({ kind: "person", name: "Priya" }, T0);
    const b = g.observe({ kind: "topic", name: "pricing" }, T0);
    g.link(a, b, "co-occurred", T0);

    const back = KnowledgeGraph.fromJSON(JSON.parse(JSON.stringify(g.toJSON())));
    expect(back.all()).toHaveLength(2);
    expect(back.allEdges()).toHaveLength(1);
    expect(back.neighbours(a)[0]!.entity.name).toBe("pricing");
  });

  // A file hand-edited, half-written by a crash, or made by a later version
  // must cost the memory graph at worst, never the launch.
  it("survives junk instead of throwing", () => {
    for (const junk of [null, 7, "nope", {}, { entities: "no", edges: 3 }]) {
      expect(KnowledgeGraph.fromJSON(junk).all()).toEqual([]);
    }
  });

  it("discards entries that are the wrong shape, keeping the rest", () => {
    const back = KnowledgeGraph.fromJSON({
      entities: [
        { id: "person:priya", kind: "person", name: "Priya", firstSeen: 1, lastSeen: 2, mentions: 3 },
        { id: "x", kind: "not-a-kind", name: "X", firstSeen: 1, lastSeen: 2, mentions: 1 },
        { id: "y", kind: "person", name: "", firstSeen: 1, lastSeen: 2, mentions: 1 },
        null,
      ],
      edges: [],
    });
    expect(back.all().map((e) => e.name)).toEqual(["Priya"]);
  });

  it("drops an edge whose endpoints did not survive", () => {
    const back = KnowledgeGraph.fromJSON({
      entities: [
        { id: "person:priya", kind: "person", name: "Priya", firstSeen: 1, lastSeen: 2, mentions: 1 },
      ],
      edges: [{ from: "person:priya", to: "topic:gone", kind: "co-occurred", weight: 2, lastSeen: 2 }],
    });
    expect(back.allEdges()).toEqual([]);
  });
});

describe("reading a transcript", () => {
  // Every sentence starts capitalised; taking those would fill the graph with
  // "The" and "We".
  it("never takes the first word of a sentence as a name", () => {
    expect(peopleIn("We agreed to ship it. They will review on Thursday.")).toEqual([]);
  });

  it("finds a person named the way people write notes", () => {
    expect(peopleIn("Spoke to Priya about pricing")).toContain("Priya");
    expect(peopleIn("Sam said the build is green")).toContain("Sam");
    expect(peopleIn("met Ravi and Anita yesterday")).toEqual(
      expect.arrayContaining(["Ravi", "Anita"]),
    );
  });

  // Lowercase names are missed, and that is stated rather than papered over.
  it("misses a name that was not capitalised, by design", () => {
    expect(peopleIn("spoke to priya about pricing")).toEqual([]);
  });

  it("does not take a weekday for a person", () => {
    expect(peopleIn("moved it to Thursday")).toEqual([]);
  });

  it("finds what was talked about more than once", () => {
    const topics = topicsIn(
      "We discussed pricing at length. The pricing model needs work, and pricing " +
        "is blocking the roadmap. The roadmap slips otherwise.",
    );
    expect(topics).toContain("pricing");
    expect(topics).toContain("roadmap");
  });

  // A single passing mention is not a topic.
  it("ignores a word said only once", () => {
    expect(topicsIn("we mentioned kubernetes exactly once here")).not.toContain("kubernetes");
  });

  it("ignores filler however often it appears", () => {
    expect(topicsIn("the the the and and and that that that")).toEqual([]);
  });

  it("returns people and topics together, ready for the graph", () => {
    const obs = observationsIn("Spoke to Priya about pricing. The pricing model needs work.");
    expect(obs.some((o) => o.kind === "person" && o.name === "Priya")).toBe(true);
    expect(obs.some((o) => o.kind === "topic" && o.name === "pricing")).toBe(true);
  });
});
