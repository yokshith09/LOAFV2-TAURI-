import type { Observation } from "./graph";

/**
 * Pulling names and topics out of something the user wrote or said.
 *
 * NO MODEL, AND THIS FILE IS HONEST ABOUT WHAT THAT COSTS. Proper entity
 * recognition wants a language model, and the decision on this project is that
 * a model is the user's choice and never a hidden dependency. So this is
 * deliberately dumb: capitalisation, a few sentence shapes, and word frequency
 * against a stop list. Nothing here is clever and nothing here pretends to be.
 *
 * WHAT THAT MEANS IN PRACTICE, so nobody is surprised by it:
 *
 *  - It finds people when they are capitalised in a normal sentence. "spoke to
 *    Priya" works; "spoke to priya" does not.
 *  - It will occasionally catch a capitalised word that is not a name — the
 *    first word of a sentence is excluded for that reason, but "Thursday" in
 *    the middle of one is not a person and this cannot always tell.
 *  - It finds topics by frequency, which means it finds what was talked about
 *    a lot rather than what mattered.
 *
 * THAT IS WHY EVERY ENTITY IS SHOWN WITH ITS SOURCE and can be deleted. A
 * memory built from guesses has to be inspectable, or it is just a system that
 * confidently misremembers. When a local model is wired up, this becomes the
 * fallback rather than the only path — the graph does not care where an
 * observation came from.
 */

/**
 * Words that are capitalised mid-sentence without being names.
 *
 * Short and specific rather than exhaustive: a long list starts excluding real
 * names, and a person called May or a colleague called Mark is more likely
 * than either word mattering as a topic.
 */
const NOT_NAMES = new Set([
  "i",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "january",
  "february",
  "march",
  "april",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
  "ok",
  "okay",
  "yes",
  "no",
  "loaf",
  // Pronouns, which sit in exactly the same sentence positions a name does:
  // "We agreed", "They will review", "asked Him". Without these the graph
  // fills up with people called We and They.
  "we",
  "they",
  "he",
  "she",
  "it",
  "you",
  "him",
  "her",
  "them",
  "us",
  "there",
  "this",
  "that",
  "the",
]);

/** Words too common to be a topic. */
const STOPWORDS = new Set([
  "the","a","an","and","or","but","if","so","then","than","that","this","these","those",
  "is","are","was","were","be","been","being","am","do","does","did","have","has","had",
  "i","you","he","she","it","we","they","me","him","her","us","them","my","your","our",
  "to","of","in","on","at","for","with","about","from","by","as","into","over","after",
  "before","up","down","out","off","just","very","really","quite","some","any","all",
  "not","no","yes","can","could","will","would","should","shall","may","might","must",
  "there","here","what","which","who","when","where","why","how","also","because",
  "going","get","got","go","make","made","take","took","think","thought","know","like",
  "one","two","three","first","next","last","now","today","tomorrow","yesterday",
  "meeting","call","okay","ok","right","well","sure","thanks","thank","please",
]);

/**
 * People named in a piece of text.
 *
 * Two shapes, both chosen because they are how people actually write meeting
 * notes: a capitalised word after a preposition or verb that takes a person
 * ("with Priya", "asked Sam"), and a capitalised word immediately before a
 * reporting verb ("Priya said").
 *
 * The FIRST word of a sentence is never taken, because every sentence starts
 * capitalised and taking those would fill the graph with "The" and "We".
 */
function startsASentence(text: string, at: number): boolean {
  for (let i = at - 1; i >= 0; i--) {
    const c = text[i]!;
    // Whitespace and quotation marks do not end a sentence; a full stop,
    // exclamation or question mark does.
    if (/[\s"\x27]/.test(c)) continue;
    return c === "." || c === "!" || c === "?";
  }
  // Nothing but whitespace before it: this is the very start of the text.
  return true;
}

export function peopleIn(text: string): readonly string[] {
  const found = new Set<string>();
  const cap = "([A-Z][\\p{L}'-]{1,20})";

  const afterCue = new RegExp(
    `\\b(?:with|to|from|and|told|asked|met|saw|spoke to|thanks|cc)\\s+${cap}`,
    "gu",
  );
  const beforeCue = new RegExp(`${cap}\\s+(?:said|says|asked|thinks|will|agreed|owns)\\b`, "gu");

  // The two patterns get different treatment at a sentence boundary, and the
  // difference is where the evidence comes from.
  //
  // For `afterCue` the evidence is the word BEFORE the name — "spoke to X" —
  // so a capitalised word that opens a sentence has nothing behind it and is
  // just a capital letter. Those are dropped.
  //
  // For `beforeCue` the evidence is the word AFTER — "X said" — which is
  // exactly as strong at the start of a note as in the middle of one. Notes
  // routinely open with the person's name, and dropping those would miss the
  // most common way anybody writes this down. The pronoun list is what stops
  // "We agreed" and "They will" getting through.
  for (const [re, dropAtSentenceStart] of [
    [afterCue, true],
    [beforeCue, false],
  ] as const) {
    for (const m of text.matchAll(re)) {
      const name = m[1];
      if (name === undefined || m.index === undefined) continue;
      if (NOT_NAMES.has(name.toLowerCase())) continue;
      if (dropAtSentenceStart && startsASentence(text, text.indexOf(name, m.index))) {
        continue;
      }
      found.add(name);
    }
  }
  return [...found];
}

/**
 * What a piece of text was mostly about.
 *
 * Frequency over a stop list, lowercased, requiring a word to appear more than
 * once so that a single passing mention does not become a topic. Longer than
 * three letters for the same reason.
 */
export function topicsIn(text: string, limit = 5): readonly string[] {
  const counts = new Map<string, number>();
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}'-]+/u)) {
    const w = raw.replace(/^['-]+|['-]+$/g, "");
    if (w.length < 4 || STOPWORDS.has(w)) continue;
    if (/^\d+$/.test(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([w]) => w);
}

/**
 * Everything worth remembering from one piece of text.
 *
 * Returns observations rather than touching a graph, so the decision about
 * what to keep stays with the caller and this stays testable on strings alone.
 */
export function observationsIn(text: string): readonly Observation[] {
  const out: Observation[] = [];
  for (const name of peopleIn(text)) out.push({ kind: "person", name });
  for (const topic of topicsIn(text)) out.push({ kind: "topic", name: topic });
  return out;
}
