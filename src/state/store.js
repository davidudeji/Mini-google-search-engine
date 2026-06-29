// ══════════════════════════════════════════════════════════════════════
//  STATE MODULE  —  src/state/store.js
// ══════════════════════════════════════════════════════════════════════
//
//  ┌─ EXPLAIN-BEFORE-CODE: CONCEPTUAL 'WHY' ───────────────────────────┐
//  │                                                                    │
//  │  Problem: the original engine.js used loose `let` variables at     │
//  │  the top of the file. Any function anywhere could overwrite them   │
//  │  silently. This is called "implicit global state" and it makes     │
//  │  bugs nearly impossible to trace.                                  │
//  │                                                                    │
//  │  Solution: a single, explicitly-named AppState object — the        │
//  │  "single source of truth." Every module reads and writes the        │
//  │  SAME object, so there is never ambiguity about where data lives.  │
//  │                                                                    │
//  │  DATA STRUCTURE CHOICE — Map vs. Plain Object for invertedIndex:   │
//  │  ┌────────────────┬─────────────────┬───────────────────────────┐ │
//  │  │ Property       │ Plain Object {} │ Map                       │ │
//  │  ├────────────────┼─────────────────┼───────────────────────────┤ │
//  │  │ Prototype risk │ YES ("__proto__")│ None                     │ │
//  │  │ .size          │ Object.keys() O(n)│ Built-in O(1)           │ │
//  │  │ Iteration order│ ES2015 insertion │ Guaranteed insertion order│ │
//  │  │ Dynamic keys   │ Unsafe for user  │ Safe — no prototype clash │ │
//  │  │                │ data ("__proto__")│                         │ │
//  │  └────────────────┴─────────────────┴───────────────────────────┘ │
//  │  Verdict: Map is correct when keys are dynamic, user-supplied data.│
//  └────────────────────────────────────────────────────────────────────┘
//
//  ┌─ EXPLAIN-BEFORE-CODE: SPACE COMPLEXITY ────────────────────────────┐
//  │  O(D + V + T) where:                                               │
//  │    D = number of documents                                         │
//  │    V = vocabulary size (unique stems)                              │
//  │    T = total tokens across all documents (invertedIndex postings)  │
//  │  The invertedIndex is SPARSE — each word appears in a small subset │
//  │  of documents — so T ≪ D×V in practice.                          │
//  └────────────────────────────────────────────────────────────────────┘
//
//  ┌─ INTERVIEW DEFENCE ────────────────────────────────────────────────┐
//  │  Q: "Why use Map over a plain object for the inverted index?"       │
//  │  A: Plain objects inherit from Object.prototype. If a document      │
//  │     contains the word "constructor" or "__proto__", using it as a   │
//  │     key on a plain object would shadow a prototype property, causing │
//  │     subtle, hard-to-diagnose bugs. Maps have no prototype key        │
//  │     collisions. Their .get()/.set() API also makes intent explicit. │
//  │                                                                     │
//  │  Q: "How would you scale this to support multiple independent       │
//  │     search sessions on the same page?"                              │
//  │  A: The single-source-of-truth pattern makes this straightforward:  │
//  │     create a factory function `createStore()` that returns a fresh  │
//  │     object with the same shape. Each session gets its own store     │
//  │     reference. The current design requires only wrapping AppState   │
//  │     in a factory — no other module code needs to change.           │
//  └─────────────────────────────────────────────────────────────────────┘

/**
 * AppState — the single source of truth for the entire application.
 * All modules (indexer, search, renderer, uploader) read/write this object.
 * It is attached to `window` so non-module scripts can access it freely.
 */
const AppState = {

  // ── DOCUMENT STORE ────────────────────────────────────────────────
  // Array<{ id: number, name: string, text: string, tokenCount: number }>
  // tokenCount is cached by buildIndex() so tfidf() runs in O(1).
  documents: [],

  // ── INVERTED INDEX ────────────────────────────────────────────────
  // Map<stemToken: string, Map<docId: number, frequency: number>>
  //
  // Example after indexing two docs:
  //   "comput" → Map { 0 → 12, 2 → 3 }
  //   "closur" → Map { 0 → 4 }
  //
  // Meaning: the stem "comput" appears 12× in doc 0 and 3× in doc 2.
  // This is the exact same data structure used in production search
  // engines — just without compression and distributed sharding.
  invertedIndex: new Map(),

  // ── VOCABULARY ────────────────────────────────────────────────────
  // Set<stemToken: string>
  // Maintained separately from invertedIndex so fuzzy search can iterate
  // over it with a single .forEach() without constructing an iterator
  // from invertedIndex.keys() on every call.
  vocabulary: new Set(),

  // ── STEM → DISPLAY WORD MAP ───────────────────────────────────────
  // Map<stemToken: string, displayWord: string>
  // Bridges the gap between index-land (stems) and display-land (words).
  // e.g., "comput" → "computer"  so the fuzzy correction banner shows
  // "Did you mean: computer?" not "Did you mean: comput?"
  stemMap: new Map(),

  // ── TRANSIENT UI STATE ────────────────────────────────────────────
  searchHistory: [],   // Array<string> — most-recent first, max 8 entries
  lastQuery:     '',   // string — used to re-run search after doc removal
  lastResults:   [],   // Array<ResultObject> — for the report download
};
