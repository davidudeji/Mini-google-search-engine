// ══════════════════════════════════════════════════════════════════════
//  INVERTED INDEXER  —  src/engine/indexer.js
// ══════════════════════════════════════════════════════════════════════
//
//  ┌─ EXPLAIN-BEFORE-CODE: CONCEPTUAL 'WHY' ───────────────────────────┐
//  │                                                                    │
//  │  THE CORE DATA STRUCTURE: The Inverted Index                       │
//  │                                                                    │
//  │  A "forward index" maps documents → words. To find which docs      │
//  │  contain "javascript", you scan EVERY document and every word.     │
//  │  Cost per query = O(D × T) — linear in total corpus size.          │
//  │                                                                    │
//  │  An INVERTED index maps words → documents. Finding docs that       │
//  │  contain "javascript" is a single Map.get() call.                  │
//  │  Cost per exact query = O(1) lookup + O(d) scoring, where d is    │
//  │  the number of matching documents — usually much smaller than D.   │
//  │                                                                    │
//  │  Concrete structure after indexing two documents:                  │
//  │                                                                    │
//  │    invertedIndex = Map {                                            │
//  │      "javascript" → Map { 0 → 12, 1 → 3 },                        │
//  │      "closure"    → Map { 0 → 4 },                                 │
//  │      "comput"     → Map { 0 → 2, 2 → 8 }                          │
//  │    }                                                               │
//  │                                                                    │
//  │  This is EXACTLY the data structure used in real search engines    │
//  │  (Lucene, Elasticsearch) — just without disk-based compression     │
//  │  and distributed sharding.                                         │
//  │                                                                    │
//  │  TF-IDF SCORING:                                                   │
//  │  TF  = term frequency in THIS document, normalised by length       │
//  │  IDF = inverse document frequency = how RARE the term is globally  │
//  │  TF-IDF = TF × IDF — high score means: frequent here, rare there  │
//  │                                                                    │
//  │  OPTIMISATION: tokenCount cached on each document object           │
//  │  Old approach: call tokenizeAndStem(doc.text) inside tfidf()       │
//  │    → O(T_d) per tfidf() call                                       │
//  │  New approach: cache doc.tokenCount during buildIndex()            │
//  │    → O(1) per tfidf() call — critical since tfidf is called        │
//  │      once per (term, matching-document) pair during search.        │
//  └────────────────────────────────────────────────────────────────────┘
//
//  ┌─ EXPLAIN-BEFORE-CODE: COMPLEXITY ──────────────────────────────────┐
//  │  buildIndex():                                                     │
//  │    For D documents, each with T_avg tokens:                        │
//  │      Outer loop:      O(D)                                         │
//  │      Tokenize + stem: O(T_d) per doc                               │
//  │      Index each token: O(1) amortised (Map.get + Map.set)          │
//  │    Total: O(D × T_avg) = O(total corpus tokens)                    │
//  │                                                                    │
//  │  tfidf(stemToken, docId):                                          │
//  │    Map.get() lookups: O(1)                                         │
//  │    doc.tokenCount:    O(1) — cached                                │
//  │    log() computation: O(1)                                         │
//  │    Total: O(1)                                                     │
//  └────────────────────────────────────────────────────────────────────┘
//
//  ┌─ INTERVIEW DEFENCE ────────────────────────────────────────────────┐
//  │  Q: "Explain TF-IDF. What does each component measure?"            │
//  │  A: TF (Term Frequency) = how often a term appears in THIS doc,   │
//  │     normalised by document length. A doc mentioning "closure" 20  │
//  │     times out of 100 tokens has TF = 0.2. IDF (Inverse Document   │
//  │     Frequency) = log(N / df) where N = total docs and df = number │
//  │     of docs containing the term. Terms in EVERY doc (like "the")  │
//  │     have IDF ≈ 0. Terms in only 1 of 10 docs have high IDF —      │
//  │     they are discriminative. TF-IDF = TF × IDF.                   │
//  │                                                                    │
//  │  Q: "Why add +1 to both numerator and denominator of IDF?"         │
//  │  A: This is Laplace (add-1) smoothing. Without it, a term in every │
//  │     document gets log(N/N) = log(1) = 0, multiplying TF to zero.  │
//  │     Adding +1 shifts the range so even universal terms keep a small│
//  │     positive IDF, preventing zero-scores and division instability. │
//  └─────────────────────────────────────────────────────────────────────┘

/**
 * buildIndex() — Clears and rebuilds the entire inverted index from
 * the current contents of AppState.documents.
 *
 * Called ONCE after all files finish loading (via Promise.all in uploader),
 * NOT once per file — this prevents O(D²×T) rebuilds on batch upload.
 */
function buildIndex() {
  // ── Clear previous index state ────────────────────────────────────
  // We use .clear() rather than reassigning to new Map/Set so that any
  // external references (e.g., a cached reference in another module)
  // still point to the same live object and see the cleared state.
  AppState.invertedIndex.clear();
  AppState.vocabulary.clear();
  AppState.stemMap.clear();

  // ── Rebuild from scratch ──────────────────────────────────────────
  AppState.documents.forEach(doc => {
    // Get raw (unstemmed) tokens for the stemMap display words.
    const rawTokens     = tokenize(doc.text);
    // Get stemmed tokens — these become the index keys.
    const stemmedTokens = rawTokens.map(stem);

    // Cache token count on the document object right now, so tfidf()
    // can read it in O(1) instead of re-running tokenizeAndStem().
    doc.tokenCount = stemmedTokens.length;

    stemmedTokens.forEach((stemToken, idx) => {

      // ── 1. Add to vocabulary ──────────────────────────────────────
      // O(1) amortised for Set.add().
      AppState.vocabulary.add(stemToken);

      // ── 2. Record the first raw word seen for this stem ───────────
      // e.g., if "computers" is encountered before "computer", the
      // stemMap stores "comput" → "computers". This is the word shown
      // in the "Did you mean: X?" correction banner.
      if (!AppState.stemMap.has(stemToken)) {
        AppState.stemMap.set(stemToken, rawTokens[idx]);
      }

      // ── 3. Build the postings list ────────────────────────────────
      // Get or create the inner Map for this stem.
      if (!AppState.invertedIndex.has(stemToken)) {
        AppState.invertedIndex.set(stemToken, new Map());
      }
      const postings = AppState.invertedIndex.get(stemToken);

      // Increment the frequency counter for this document.
      // .get() returns undefined for a new docId, so we default to 0.
      postings.set(doc.id, (postings.get(doc.id) || 0) + 1);
    });
  });

  // ── Refresh all UI panels that depend on the index ────────────────
  updateStats();
  updateIndexView();
  updateDocChips();
}

/**
 * tfidf(stemToken, docId) — Scores a (term, document) pair using the
 * TF-IDF formula with Laplace smoothing on IDF.
 *
 * This function now runs in O(1) because it reads doc.tokenCount
 * (cached by buildIndex) instead of re-tokenising the document.
 *
 * @param  {string} stemToken — the indexed stem
 * @param  {number} docId     — the document to score
 * @returns {number}           — TF-IDF relevance score (≥ 0)
 */
function tfidf(stemToken, docId) {
  const doc = AppState.documents.find(d => d.id === docId);
  if (!doc) return 0;

  const postings  = AppState.invertedIndex.get(stemToken);
  const termFreq  = postings ? (postings.get(docId) || 0) : 0;

  // Normalise by total token count. Use cached value (O(1)) with a
  // fallback for any doc loaded before this optimisation was in place.
  const totalTokens = doc.tokenCount || tokenizeAndStem(doc.text).length;
  const tf = termFreq / (totalTokens || 1);

  // df = document frequency = number of documents containing this stem.
  // Using postings.size because Map.size is O(1) — no iteration needed.
  const df  = postings ? postings.size : 0;
  const N   = AppState.documents.length;

  // IDF with Laplace (+1) smoothing.
  // log((N+1) / (df+1)) + 1  ensures IDF is always ≥ 1 (never zero).
  const idf = df > 0 ? Math.log((N + 1) / (df + 1)) + 1 : 0;

  return tf * idf;
}
