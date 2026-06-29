// ══════════════════════════════════════════════════════════════════════
//  FUZZY MATCHER  —  src/utils/fuzzy.js
// ══════════════════════════════════════════════════════════════════════
//
//  ┌─ EXPLAIN-BEFORE-CODE: CONCEPTUAL 'WHY' ───────────────────────────┐
//  │                                                                    │
//  │  Users make typos. "computr" instead of "computer". The inverted   │
//  │  index returns ZERO results for "computr" because no document was  │
//  │  indexed under that spelling. Fuzzy matching bridges this gap by   │
//  │  finding the closest REAL word in the vocabulary.                  │
//  │                                                                    │
//  │  ALGORITHM CHOICE — Levenshtein Distance:                          │
//  │  Counts the minimum number of single-character EDITS               │
//  │  (insert / delete / substitute) to transform string A into B.     │
//  │                                                                    │
//  │    "computr"  → "computer" = 1 insertion  ('e')     = distance 1  │
//  │    "algorthm" → "algorithm" = 1 insertion  ('i')    = distance 1  │
//  │    "mashine"  → "machine"  = 1 substitution (s→c)  = distance 1  │
//  │    "recieve"  → "receive"  = 1 transposition (ie→ei)= distance 2  │
//  │                                                                    │
//  │  Why Levenshtein over Dice's Coefficient?                          │
//  │  Dice works on bigram overlap (O(A+B) time) but is less precise  │
//  │  — it conflates transpositions with substitutions. Levenshtein     │
//  │  is the gold standard for single-word typo correction and is       │
//  │  fully explainable with a 3×3 DP table on a whiteboard.           │
//  │                                                                    │
//  │  THE CRITICAL OPTIMISATION (spec requirement):                     │
//  │  Naïve: compare query token against EVERY word in vocabulary.      │
//  │    Cost = O(V × A × B) — for V=5,000, A=B=8: ~320,000 ops       │
//  │  Optimised: LENGTH PRE-FILTER eliminates ~90% of candidates.       │
//  │    If |len(a) - len(b)| > threshold, edit distance CANNOT be ≤    │
//  │    threshold (you'd need at least that many insertions/deletions). │
//  │    Cost = O(V) filter + O(k × A × B) DP, k ≪ V (typically < 50) │
//  └────────────────────────────────────────────────────────────────────┘
//
//  ┌─ EXPLAIN-BEFORE-CODE: LEVENSHTEIN DP TABLE ────────────────────────┐
//  │  Comparing "cat" vs "cut":                                         │
//  │                                                                    │
//  │       ""  c  u  t                                                  │
//  │  ""  [ 0  1  2  3 ]  ← base case: "" → "cut" needs 3 insertions   │
//  │  c   [ 1  0  1  2 ]  ← 'c'='c': free; 'c'≠'u': 1+min(0,1,1)=1   │
//  │  a   [ 2  1  1  2 ]  ← 'a'≠'u': 1+min(0,1,1)=1 (substitute)      │
//  │  t   [ 3  2  2  1 ]  ← 't'='t': free → dp[2][2]=1                 │
//  │                                                                    │
//  │  dp[3][3] = 1 → "cat" needs 1 substitution ('a'→'u') to become    │
//  │  "cut". Levenshtein distance = 1.                                  │
//  │                                                                    │
//  │  Time:  O(A × B)   Space: O(A × B) (reducible to O(min(A,B)))     │
//  └────────────────────────────────────────────────────────────────────┘
//
//  ┌─ INTERVIEW DEFENCE ────────────────────────────────────────────────┐
//  │  Q: "Your fuzzy search iterates over the vocabulary on every query. │
//  │     How would you scale this to 100,000 vocabulary terms?"         │
//  │  A: Two approaches:                                                │
//  │     1. BK-Trees: a metric-space tree that prunes branches where    │
//  │        the triangle inequality guarantees no match exists within   │
//  │        the threshold. Reduces fuzzy search to O(log V) expected.  │
//  │     2. N-gram indexing: pre-build a Map of character bigrams to   │
//  │        vocabulary words. At query time, intersect bigram sets to  │
//  │        generate candidates before running Levenshtein only on them.│
//  │     For our portfolio corpus (< 5,000 stems after stemming), the  │
//  │     length pre-filter achieves the same practical speedup.         │
//  │                                                                    │
//  │  Q: "What is Damerau-Levenshtein and when would you prefer it?"   │
//  │  A: It adds a 4th edit operation: transposition (swapping two      │
//  │     adjacent chars). "teh"→"the" costs 1 in Damerau-Levenshtein  │
//  │     but 2 in standard (delete 'e' + insert 'e'). Since adjacent-  │
//  │     key transpositions are the most common typing mistake, D-L is  │
//  │     more accurate for autocorrect. We use standard Levenshtein    │
//  │     here because it's simpler to explain under interview pressure. │
//  └─────────────────────────────────────────────────────────────────────┘

/**
 * levenshtein(a, b) — Computes the edit distance between two strings.
 *
 * @param  {string} a
 * @param  {string} b
 * @returns {number} — edit distance, or 99 if trivially beyond threshold
 */
function levenshtein(a, b) {
  // ── FAST PATH: length gate ────────────────────────────────────────
  // If the length difference alone exceeds 3, the strings CANNOT be
  // within our tolerance of 2, regardless of their content.
  // This O(1) check prevents O(A×B) DP work on hopeless pairs.
  if (Math.abs(a.length - b.length) > 3) return 99;

  // ── DP TABLE INITIALISATION ───────────────────────────────────────
  // Build an (a.length+1) × (b.length+1) grid.
  // Row 0: cost to delete j characters from b to reach "".
  // Col 0: cost to insert i characters to reach a from "".
  const dp = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) =>
      i === 0 ? j : j === 0 ? i : 0
    )
  );

  // ── FILL DP TABLE ─────────────────────────────────────────────────
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        // Characters match — no edit cost, inherit diagonal value.
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        // Characters differ — take the cheapest of three operations:
        dp[i][j] = 1 + Math.min(
          dp[i - 1][j],     // deletion  (move up in table)
          dp[i][j - 1],     // insertion (move left in table)
          dp[i - 1][j - 1]  // substitution (move diagonally)
        );
      }
    }
  }

  return dp[a.length][b.length];
}

/**
 * fuzzyMatch(stemToken, vocabulary, threshold) — Finds the closest word
 * in the vocabulary to stemToken within edit distance ≤ threshold.
 *
 * OPTIMISATION SEQUENCE applied per candidate:
 *   1. Length pre-filter: O(1) integer comparison — skips ~90% of vocab
 *   2. Levenshtein DP:    O(A×B) — only runs on the ~10% survivors
 *
 * @param  {string} stemToken — the query stem to find a match for
 * @param  {Set<string>} vocabulary — the full set of indexed stems
 * @param  {number} threshold — maximum edit distance to consider (default 2)
 * @returns {{ best: string|null, dist: number }}
 */
function fuzzyMatch(stemToken, vocabulary, threshold = 2) {
  let best     = null;
  // Initialise one above the threshold so the first valid match wins.
  let bestDist = threshold + 1;

  vocabulary.forEach(vocabWord => {
    // ── OPTIMISATION: Length pre-filter ──────────────────────────────
    // The minimum edit distance between two strings can never be LESS
    // than the absolute difference of their lengths. So if the lengths
    // differ by more than threshold, skip the expensive DP entirely.
    if (Math.abs(vocabWord.length - stemToken.length) > threshold) return;

    const dist = levenshtein(stemToken, vocabWord);

    // Keep the closest match found so far.
    // On a tie, we keep the first word encountered (Map insertion order).
    if (dist < bestDist) {
      best     = vocabWord;
      bestDist = dist;
    }
  });

  return { best, dist: bestDist };
}
