// ══════════════════════════════════════════════════════════════════════
//  SEARCH ENGINE  —  src/engine/search.js
// ══════════════════════════════════════════════════════════════════════
//
//  ┌─ EXPLAIN-BEFORE-CODE: CONCEPTUAL 'WHY' ───────────────────────────┐
//  │                                                                    │
//  │  The search function is the "query processor." It connects the     │
//  │  user's raw input to the inverted index and produces a ranked list.│
//  │                                                                    │
//  │  QUERY PROCESSING PIPELINE:                                        │
//  │    Raw query string                                                │
//  │      → tokenize + stem (symmetric: same pipeline as indexing)     │
//  │      → for each stem token:                                        │
//  │          exact hit in invertedIndex → accumulate TF-IDF score     │
//  │          no hit → fuzzyMatch in vocabulary → accumulate 0.7× score │
//  │      → sort candidates by total score (descending)                │
//  │      → return results with match metadata for rendering            │
//  │                                                                    │
//  │  WHY A 0.7× PENALTY FOR FUZZY RESULTS?                             │
//  │  A fuzzy result is uncertain — we corrected the user's typo, so   │
//  │  we're less confident the result is relevant. The 30% penalty     │
//  │  ensures an exact-match document always outranks a fuzzy-match     │
//  │  document with the same raw TF-IDF score. This mirrors Google's   │
//  │  "did you mean?" UX: fuzzy results are shown but ranked lower.    │
//  │                                                                    │
//  │  WHY SYMMETRIC STEMMING?                                           │
//  │  We stem both the query AND the indexed tokens. This means the     │
//  │  user typing "computing" matches the stem "comput" in the index,   │
//  │  which was created from the word "computer". Without stemming the  │
//  │  query, "computing" would fail to hit "comput" even though both   │
//  │  descend from the same root word.                                  │
//  └────────────────────────────────────────────────────────────────────┘
//
//  ┌─ EXPLAIN-BEFORE-CODE: COMPLEXITY ──────────────────────────────────┐
//  │  search(query) for Q query tokens, V vocab size, d matching docs:  │
//  │    Tokenize + stem:        O(Q)                                    │
//  │    Exact lookup per token: O(1) Map.get + O(d) scoring             │
//  │    Fuzzy per missed token: O(V) filter + O(k×A×B) DP, k ≪ V       │
//  │    Sort results:           O(R log R) where R = result count       │
//  │    Total: O(Q × (d + V)) — for Q=3, V=5000: ~15,000 ops           │
//  │    This completes in < 1ms on a modern browser.                    │
//  └────────────────────────────────────────────────────────────────────┘
//
//  ┌─ INTERVIEW DEFENCE ────────────────────────────────────────────────┐
//  │  Q: "Your engine ranks globally. How would you support phrase       │
//  │     search ('javascript closures' must be adjacent)?"              │
//  │  A: Store POSITIONS in the postings: Map<docId, Array<position>>  │
//  │     instead of Map<docId, frequency>. For phrase queries, after   │
//  │     collecting candidates, verify that positions of token A and   │
//  │     token B are consecutive (posB = posA + 1). This is called     │
//  │     "positional indexing" and grows index size by ~2-3× but       │
//  │     enables proximity and phrase queries.                          │
//  │                                                                    │
//  │  Q: "How would you add query-time caching?"                        │
//  │  A: A Map<queryString, resultSet> LRU cache. Since our search is  │
//  │     deterministic, identical queries always produce identical      │
//  │     results until the document set changes. On cache hit: O(1)    │
//  │     return. Invalidate the entire cache inside buildIndex() — the  │
//  │     single source of truth means one invalidation point.          │
//  └─────────────────────────────────────────────────────────────────────┘

/**
 * search(query) — Main entry point for the search engine.
 *
 * @param  {string} query — raw user input
 * @returns {{ results: Array, time: string, correction: string|null }}
 */
function search(query) {
  const t0 = performance.now(); // high-resolution timer for query time display

  if (!query.trim() || AppState.documents.length === 0) {
    return { results: [], time: '0.0', correction: null };
  }

  // ── SYMMETRIC STEMMING ────────────────────────────────────────────
  // Stem the query tokens with the SAME pipeline used at index time.
  // This ensures "computing" → "comput" matches the index key "comput".
  const rawTokens  = tokenize(query);
  const stemTokens = rawTokens.map(stem);

  // scores[docId]       = cumulative TF-IDF score for this query
  // matchedTerms[docId] = array of match descriptors for highlighting
  const scores       = {};
  const matchedTerms = {};
  // Track which stems had to be fuzzy-corrected (to show the banner).
  const fuzzyMappings = {};
  let correction = null;

  stemTokens.forEach((stemToken, i) => {
    const rawToken = rawTokens[i];

    if (AppState.invertedIndex.has(stemToken)) {
      // ── EXACT MATCH PATH ──────────────────────────────────────────
      // The stem exists in the index. Score every document that contains it.
      // This is an O(1) Map.get() followed by O(d) iteration over postings.
      AppState.invertedIndex.get(stemToken).forEach((freq, docId) => {
        scores[docId] = (scores[docId] || 0) + tfidf(stemToken, docId);

        if (!matchedTerms[docId]) matchedTerms[docId] = [];
        matchedTerms[docId].push({ stemToken, rawToken, type: 'exact' });
      });

    } else {
      // ── FUZZY MATCH PATH ──────────────────────────────────────────
      // The stem is NOT in the index. Find the closest vocabulary word.
      // fuzzyMatch() applies the length pre-filter before running DP.
      const { best } = fuzzyMatch(stemToken, AppState.vocabulary);

      if (best !== null) {
        fuzzyMappings[stemToken] = best;
        // Record the first correction for the "Showing results for: X" banner.
        if (!correction) correction = AppState.stemMap.get(best) || best;

        AppState.invertedIndex.get(best).forEach((freq, docId) => {
          // 0.7× penalty: fuzzy results ranked below exact matches.
          scores[docId] = (scores[docId] || 0) + tfidf(best, docId) * 0.7;

          if (!matchedTerms[docId]) matchedTerms[docId] = [];
          matchedTerms[docId].push({
            stemToken: best,
            rawToken,
            type: 'fuzzy',
            corrected: AppState.stemMap.get(best) || best
          });
        });
      }
    }
  });

  // ── NORMALISE & SORT ──────────────────────────────────────────────
  // maxScore is used to convert raw TF-IDF values to a 0–100% relevance
  // bar. We use a small epsilon (0.0001) to avoid division by zero when
  // all scores are 0 (edge case: fuzzy returned no results).
  const maxScore = Math.max(...Object.values(scores), 0.0001);

  const results = Object.entries(scores)
    .map(([idStr, score]) => {
      const docId = Number(idStr);
      const doc   = AppState.documents.find(d => d.id === docId);
      const terms = matchedTerms[docId] || [];
      return {
        doc,
        score,
        pct:     Math.round((score / maxScore) * 100),
        terms,
        isFuzzy: terms.some(t => t.type === 'fuzzy')
      };
    })
    // Guard: a document could have been removed mid-search (race condition
    // in async upload). Filter out any result where .find() returned undefined.
    .filter(r => r.doc)
    .sort((a, b) => b.score - a.score); // descending relevance

  const time = (performance.now() - t0).toFixed(1);
  return {
    results,
    time,
    correction: Object.keys(fuzzyMappings).length > 0 ? correction : null
  };
}

// ══════════════════════════════════════════════════════════════════════
//  MATCH FINDING & SNIPPET BUILDING
// ══════════════════════════════════════════════════════════════════════

/**
 * escHtml(s) — Escapes HTML special characters before inserting user
 * content into innerHTML. This prevents XSS attacks from malicious
 * file content (e.g., a .txt file containing <script>).
 *
 * Placement: in search.js because buildSnippet() and all render
 * functions use it — it is the layer closest to raw content.
 *
 * @param  {string|any} s
 * @returns {string} — HTML-safe string
 */
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * findMatches(text, terms) — Returns all character-position spans where
 * query terms appear in the raw document text.
 *
 * This is used by BOTH buildSnippet() (for card highlights) and
 * openDocViewer() (for line-by-line navigation) — single source of truth
 * for match positions.
 *
 * @param  {string} text   — raw document text
 * @param  {Array}  terms  — matchedTerms array from search()
 * @returns {Array<{start, end, word, type}>} — sorted by start position
 */
function findMatches(text, terms) {
  // Collect the raw words to search for, separated by match type.
  const exactTerms = terms
    .filter(t => t.type === 'exact')
    // Include both the raw query token AND the display word from stemMap.
    // e.g., query "closure" AND indexed raw "closures" should both highlight.
    .flatMap(t => [t.rawToken, AppState.stemMap.get(t.stemToken)])
    .filter(Boolean);

  const fuzzyTerms = terms
    .filter(t => t.type === 'fuzzy')
    .map(t => t.corrected || AppState.stemMap.get(t.stemToken))
    .filter(Boolean);

  const allTerms = [...new Set([...exactTerms, ...fuzzyTerms])];
  const positions = [];

  allTerms.forEach(term => {
    // Escape any regex special characters in the term itself.
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // \b = word boundary; \w* = allow partial root match to extend to
    // the full word. e.g., "compute" also highlights "computers".
    const re = new RegExp(`\\b${escaped}\\w*\\b`, 'gi');
    let m;
    while ((m = re.exec(text)) !== null) {
      positions.push({
        start: m.index,
        end:   m.index + m[0].length,
        word:  m[0],
        type:  fuzzyTerms.includes(term) ? 'fuzzy' : 'exact'
      });
    }
  });

  // Sort ascending by start position so snippet builder walks linearly.
  return positions.sort((a, b) => a.start - b.start);
}

/**
 * buildSnippet(text, terms) — Extracts a ~280-char window around the
 * first match and returns HTML with exact/fuzzy highlights applied.
 *
 * Context window strategy:
 *   - 60 chars before the first match  (context leading into match)
 *   - 220 chars after the first match  (shows following content)
 * This gives a natural sentence-length snippet similar to Google's.
 *
 * @param  {string} text  — raw document text
 * @param  {Array}  terms — matchedTerms from search()
 * @returns {string}       — HTML string with <mark> and <span class="fuzzy-hl">
 */
function buildSnippet(text, terms) {
  const positions = findMatches(text, terms);

  // No matches found: return the first 180 chars as a plain preview.
  if (positions.length === 0) return escHtml(text.slice(0, 180)) + '…';

  const anchor = positions[0].start;
  const start  = Math.max(0, anchor - 60);
  const end    = Math.min(text.length, anchor + 220);

  // Extract the snippet window and adjust match offsets to be relative
  // to the window start so they can be applied to the sliced string.
  const snippetText  = text.slice(start, end);
  const adjPositions = positions
    .map(p => ({ ...p, start: p.start - start, end: p.end - start }))
    // Keep only matches that fall fully within the snippet window.
    .filter(p => p.start >= 0 && p.end <= snippetText.length);

  let result = '';
  let cursor = 0;

  adjPositions.forEach(p => {
    // Skip if this match overlaps the previous one (shouldn't happen
    // with non-overlapping regexes but guard defensively).
    if (p.start < cursor) return;

    // Append unmatched text between cursor and this match (HTML-escaped).
    result += escHtml(snippetText.slice(cursor, p.start));

    // Wrap the matched word in the appropriate highlight element.
    if (p.type === 'fuzzy') {
      // Fuzzy matches: dashed yellow underline (defined in base.css)
      result += `<span class="fuzzy-hl">${escHtml(p.word)}</span>`;
    } else {
      // Exact matches: solid accent underline via <mark>
      result += `<mark>${escHtml(p.word)}</mark>`;
    }

    cursor = p.end;
  });

  // Append any remaining text after the last match.
  result += escHtml(snippetText.slice(cursor));

  // Add ellipsis indicators if the snippet is a mid-document window.
  return (start > 0 ? '…' : '') + result + (end < text.length ? '…' : '');
}

/**
 * getSuggestions(q) — Returns up to 6 autocomplete suggestions for the
 * partial query string q.
 *
 * Sources (in priority order):
 *   1. Search history: queries containing q as a substring
 *   2. Vocabulary prefix matches: stems that START with stem(q)
 *   3. Vocabulary fuzzy matches: stems within Levenshtein distance 1
 *
 * @param  {string} q — the current partial query
 * @returns {string[]} — up to 6 display-word suggestions
 */
function getSuggestions(q) {
  if (!q || q.length < 2) return [];

  const stemQ = stem(q.toLowerCase().trim());
  const exact = [];
  const fuzzy = [];

  AppState.vocabulary.forEach(v => {
    if (v.startsWith(stemQ) && v !== stemQ) {
      // Prefix match: "compu" → "computer" (stem "comput")
      exact.push(AppState.stemMap.get(v) || v);
    } else if (levenshtein(stemQ, v) <= 1) {
      // Close fuzzy match for the partial input.
      fuzzy.push(AppState.stemMap.get(v) || v);
    }
  });

  // History suggestions: personalised — queries this user already ran.
  const histSug = AppState.searchHistory
    .filter(h => h.toLowerCase().includes(q.toLowerCase()))
    .slice(0, 2);

  // Merge: history first, then prefix, then fuzzy. Deduplicate. Cap at 6.
  return [...new Set([...histSug, ...exact.slice(0, 3), ...fuzzy.slice(0, 2)])].slice(0, 6);
}
