 Complete Architecture Explainer

From User Keystroke to Search Result: Every Function, Every Algorithm, Every Decision

Table of Contents
The Big Picture — Module Map
How the Page Loads — Script Order Matters
Phase 1: File Upload — Getting Data In
Phase 2: Preprocessing — Cleaning the Text
Phase 3: Indexing — Building the Inverted Index
Phase 4: Searching — What Happens When You Type
Phase 5: Fuzzy Matching — Typo Tolerance
Phase 6: TF-IDF Scoring — Ranking the Results
Phase 7: Rendering — From Data to Screen
Key Optimization Decisions: Map vs Object, Set vs Array
Event Handling Architecture
Complete Flow Summary: A Worked Example
1. The Big Picture — Module Map
The project is split into 7 JavaScript files, each with one clear job. They are loaded in a strict dependency order:


index.html                      ← Structure + UI skeleton (HTML)
  │
  ├── src/styles/base.css       ← All styling (CSS)
  │
  ├── src/state/store.js        ← AppState: the single source of truth
  ├── src/utils/preprocessor.js ← tokenize(), stem(), STOP_WORDS
  ├── src/utils/fuzzy.js        ← levenshtein(), fuzzyMatch()
  ├── src/engine/indexer.js     ← buildIndex(), tfidf()
  ├── src/engine/search.js      ← search(), findMatches(), buildSnippet(), getSuggestions()
  ├── src/ui/renderer.js        ← renderResults(), updateStats(), openDocViewer()
  ├── src/ui/uploader.js        ← handleFileInput(), readFileAsText(), setupDrop()
  └── src/main.js (defer)       ← Event listeners + wiring harness
IMPORTANT

main.js is loaded with defer — this means the browser downloads it in parallel with parsing the HTML, but only executes it after the HTML is fully parsed. Since all other scripts load in <head> order before it, main.js is always guaranteed to run last, after every other module is defined.

2. How the Page Loads — Script Order Matters
When the browser opens index.html, here is the sequence:

HTML parses — the browser builds the DOM tree. It encounters the <script> tags.
Scripts 1–7 execute immediately (in order): store.js → preprocessor.js → fuzzy.js → indexer.js → search.js → renderer.js → uploader.js. Each one defines global functions and objects.
HTML finishes parsing.
main.js runs (defer fires after DOM is ready). It wires up all event listeners using the functions defined in steps 1–7.
This order is critical because main.js calls functions like renderHistory() (defined in renderer.js) and setupDrop() (defined in uploader.js). If those hadn't loaded first, you'd get ReferenceError: renderHistory is not defined.

3. Phase 1: File Upload — Getting Data In
Files: 
uploader.js
 | 
main.js

Two ways a user gets files in:
Method	How it works
Click "Upload Files"	Button triggers document.getElementById('fileInput').click() — opens the OS file picker
Drag & Drop	setupGlobalDrop() turns the entire page into a drop zone
Both paths eventually call the same function: handleFileInput(files).

The Old (Broken) Way vs. The New (Fixed) Way
The most important optimization in the entire codebase lives here.

❌ Old (naive) approach — O(N × D × T):

javascript

// This fires buildIndex() for EVERY file that finishes loading
files.forEach(file => {
  const reader = new FileReader();
  reader.onload = ev => {
    AppState.documents.push({ text: ev.target.result });
    buildIndex(); // ← CALLED N TIMES! Rebuilds entire index each time
  };
  reader.readAsText(file);
});
If you upload 5 files, buildIndex() runs 5 times. The 5th call rebuilds all 5 docs from scratch — wasted work.

✅ New (correct) approach — O(D × T):

javascript

// Wrap each FileReader in a Promise
function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = ev => resolve({ name: file.name, text: ev.target.result });
    reader.onerror = () => reject(new Error(`Failed to read "${file.name}"`));
    reader.readAsText(file);
  });
}
// Promise.all waits for ALL files, then calls buildIndex() ONCE
Promise.all(newFiles.map(readFileAsText))
  .then(loaded => {
    loaded.forEach(({ name, text }) => AppState.documents.push({ id: Date.now() + Math.random(), name, text, tokenCount: 0 }));
    buildIndex(); // ← Called ONCE, after everything is loaded
  });
Why FileReader needs a Promise wrapper: FileReader uses the old callback/event pattern (reader.onload = ...). Callbacks can't be composed — you can't easily say "wait for all these callbacks to finish, then do X." A Promise wraps the callback and gives you a value you can pass to Promise.all(), which automatically waits for every file.

Why the FileReaders run in parallel: Each new FileReader() is its own browser I/O operation. The browser reads multiple files from the OS simultaneously — they don't block each other. JavaScript itself is single-threaded, but file I/O is handled by the browser internals (via libuv-style event loops). So 5 files load in roughly the time it takes to load 1 file.

4. Phase 2: Preprocessing — Cleaning the Text
File: 
preprocessor.js

The Pipeline: Raw Text → Meaningful Tokens

"JavaScript is a powerful language!"
   ↓ toLowerCase()
"javascript is a powerful language!"
   ↓ .replace(/[^\w\s]/g, ' ')     ← strip punctuation
"javascript is a powerful language "
   ↓ .split(/\s+/)                  ← split on whitespace
["javascript", "is", "a", "powerful", "language"]
   ↓ .filter(w => w.length > 1 && !STOP_WORDS.has(w))   ← remove noise
["javascript", "powerful", "language"]
   ↓ .map(stem)                     ← reduce to root form
["javascript", "pow", "languag"]
Why a Set for Stop Words (NOT an Array)
The stop-word check runs once per token per document. With 10,000 tokens:

Data structure	Lookup cost	Total operations
Array.includes()	O(N) per call	10,000 × 150 = 1,500,000 ops
Set.has()	O(1) per call	10,000 × 1 = 10,000 ops
Set.has() is 150× faster here. This is why we write:

javascript

const STOP_WORDS = new Set(['the', 'is', 'a', 'and', ...]); // O(1) lookups
// NOT: const STOP_WORDS = ['the', 'is', 'a', 'and', ...]; // O(N) lookups
The Stemmer — Reducing Words to Their Root
The stem(word) function strips common English suffixes so that computer, computing, computed all become comput — the same index key.

javascript

function stem(word) {
  if (word.length < 5) return word;          // Guard: don't mangle short words
  if (word.endsWith('tion'))  return word.slice(0, -3); // "connection" → "connect"
  if (word.endsWith('ing'))   return word.slice(0, -3); // "running" → "runn"
  if (word.endsWith('ed') && word.length > 5) return word.slice(0, -2); // "connected" → "connect"
  // ...12 rules total, ordered longest suffix first
  return word;
}
Why longest suffix first? Consider "connections":

If we check s first → "connection" (correct stem so far, but not done)
If we check tion first → "connect" (correct!)
Ordering by longest suffix prevents partial, incorrect stripping.

Symmetric Stemming — The Golden Rule: The exact same stem() function is applied to documents at index time AND to queries at search time. So:

Document: "computer" → indexed as "comput"
Query: "computing" → searched as "comput" ✓ — they match!
5. Phase 3: Indexing — Building the Inverted Index
File: 
indexer.js

What is an Inverted Index?
A regular (forward) index maps document → words. To find which docs contain "javascript", you scan every doc and every word: O(D × T) per query.

An inverted index maps word → documents. Finding docs with "javascript" is a single lookup: O(1) per query.


invertedIndex = Map {
  "comput"  → Map { docId:0 → 12,  docId:2 → 3  },
  "closur"  → Map { docId:0 → 4              },
  "react"   → Map { docId:1 → 9,  docId:0 → 1  }
}
This says: the stem "comput" appears 12 times in doc 0 and 3 times in doc 2.

buildIndex() — Step by Step
javascript

function buildIndex() {
  AppState.invertedIndex.clear();  // wipe old state
  AppState.vocabulary.clear();
  AppState.stemMap.clear();
  AppState.documents.forEach(doc => {
    const rawTokens    = tokenize(doc.text);    // ["computer", "computing", ...]
    const stemmedTokens = rawTokens.map(stem);  // ["comput",   "comput",   ...]
    doc.tokenCount = stemmedTokens.length;      // CACHE this — avoids O(T) work later
    stemmedTokens.forEach((stemToken, idx) => {
      AppState.vocabulary.add(stemToken);                      // Step 1: track all stems
      if (!AppState.stemMap.has(stemToken)) {
        AppState.stemMap.set(stemToken, rawTokens[idx]);       // Step 2: save display word
      }
      if (!AppState.invertedIndex.has(stemToken)) {
        AppState.invertedIndex.set(stemToken, new Map());      // Step 3a: create postings entry
      }
      const postings = AppState.invertedIndex.get(stemToken);
      postings.set(doc.id, (postings.get(doc.id) || 0) + 1);  // Step 3b: count frequency
    });
  });
  updateStats(); updateIndexView(); updateDocChips(); // refresh UI panels
}
Three data structures built simultaneously:

Structure	Type	Purpose
invertedIndex	Map<stem, Map<docId, frequency>>	The core search structure
vocabulary	Set<stem>	Fast iteration for fuzzy matching
stemMap	Map<stem, displayWord>	Converts "comput" → "computer" for UI
The tokenCount cache: TF-IDF scoring needs to know how many tokens are in each document. Without caching, every tfidf() call would re-run tokenizeAndStem() — that's O(T) per call. By storing it once during buildIndex(), every tfidf() call reads it in O(1).

6. Phase 4: Searching — What Happens When You Type
Files: 
search.js
 | 
main.js

The Event Chain: Keystroke → Results

User types "closure" in the search bar
  ↓
input event fires on #homeInput
  ↓
debouncedSuggest("closure", "homeSuggestions")   ← suggestions after 180ms pause
debouncedSearch("closure")                        ← auto-search after 320ms pause (results page only)
  ↓
[User presses Enter or submits form]
  ↓
homeForm "submit" event fires
  ↓
e.preventDefault()   ← stop browser from reloading the page
triggerSearch("closure")
  ↓
goToResults("closure")
  ↓
search("closure")    ← the engine runs
  ↓
renderResults(...)   ← DOM updates
Debouncing — Why We Don't Search on Every Keystroke
javascript

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);       // cancel the previous scheduled call
    timer = setTimeout(() => fn(...args), ms);  // reschedule
  };
}
const debouncedSuggest = debounce((q, boxId) => renderSuggestions(q, boxId), 180);
const debouncedSearch  = debounce((q) => { if (q.trim()) goToResults(q); }, 320);
Without debouncing, typing "closure" (7 characters) would trigger 7 separate searches. With debouncing, the search only fires if the user pauses for 320ms. This prevents the engine from running mid-word like "closu".

search(query) — The Query Processor
javascript

function search(query) {
  const t0 = performance.now();     // start the clock
  const rawTokens  = tokenize(query);   // ["closure"]
  const stemTokens = rawTokens.map(stem); // ["closur"]
  const scores = {};          // { docId: cumulativeTfIdfScore }
  const matchedTerms = {};    // { docId: [{ stemToken, type }] }
  let correction = null;
  stemTokens.forEach((stemToken, i) => {
    if (AppState.invertedIndex.has(stemToken)) {
      // ── EXACT PATH: O(1) lookup + O(d) scoring ────────────────────
      AppState.invertedIndex.get(stemToken).forEach((freq, docId) => {
        scores[docId] = (scores[docId] || 0) + tfidf(stemToken, docId);
        matchedTerms[docId].push({ stemToken, type: 'exact' });
      });
    } else {
      // ── FUZZY PATH: No exact match → find closest vocabulary word ──
      const { best } = fuzzyMatch(stemToken, AppState.vocabulary);
      if (best !== null) {
        correction = AppState.stemMap.get(best); // "comput" → "computer"
        AppState.invertedIndex.get(best).forEach((freq, docId) => {
          scores[docId] = (scores[docId] || 0) + tfidf(best, docId) * 0.7; // 30% penalty
          matchedTerms[docId].push({ stemToken: best, type: 'fuzzy', corrected: correction });
        });
      }
    }
  });
  // Sort by score (highest first)
  const results = Object.entries(scores)
    .map(([idStr, score]) => ({ doc: findDoc(idStr), score, pct: Math.round((score / maxScore) * 100) }))
    .filter(r => r.doc)
    .sort((a, b) => b.score - a.score);
  return { results, time: (performance.now() - t0).toFixed(1), correction };
}
The 0.7× fuzzy penalty: If a document has a raw TF-IDF score of 0.5 for an exact match, another document with the same raw score but reached via fuzzy matching gets 0.5 × 0.7 = 0.35. An exact match always ranks above a typo-corrected match with the same raw relevance. This mirrors how Google shows "Did you mean: X?" — fuzzy results are visible but ranked lower.

7. Phase 5: Fuzzy Matching — Typo Tolerance
File: 
fuzzy.js

Levenshtein Distance — The Algorithm
Levenshtein distance counts the minimum number of single-character edits (insert / delete / substitute) to transform string A into string B.


"computr" → "computer"  =  1 insertion ('e')       = distance 1  ✓
"algorthm" → "algorithm" =  1 insertion ('i')       = distance 1  ✓
"recieve"  → "receive"   =  1 substitution (i↔e)   = distance 2  ✓
The algorithm builds a 2D grid (dynamic programming table):


Comparing "cat" vs "cut":
       ""  c  u  t
  ""  [ 0  1  2  3 ]  ← to build "" into "cut" you need 3 insertions
  c   [ 1  0  1  2 ]  ← 'c'='c': free; inherit diagonal
  a   [ 2  1  1  2 ]  ← 'a'≠'u': cheapest of delete/insert/substitute + 1
  t   [ 3  2  2  1 ]  ← 't'='t': free; inherit diagonal
dp[3][3] = 1  → edit distance is 1 (substitute 'a' → 'u')
javascript

function levenshtein(a, b) {
  if (Math.abs(a.length - b.length) > 3) return 99; // ← FAST PATH: impossible match
  const dp = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) =>
      i === 0 ? j : j === 0 ? i : 0   // base case: row 0 = [0,1,2,3...], col 0 = [0,1,2,3...]
    )
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i-1] === b[j-1]) {
        dp[i][j] = dp[i-1][j-1];                                         // characters match: free
      } else {
        dp[i][j] = 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]); // delete / insert / substitute
      }
    }
  }
  return dp[a.length][b.length];
}
The Critical Optimization — Length Pre-Filter
Naïve approach: Compare the query stem against every word in the vocabulary using the full DP table.

Cost: O(V × A × B), where V = vocabulary size, A and B = word lengths
With V = 5,000, A = B = 8: 320,000 operations per query token
Optimized approach: Before running the expensive DP table, check if the lengths are too different:

javascript

function fuzzyMatch(stemToken, vocabulary, threshold = 2) {
  vocabulary.forEach(vocabWord => {
    // If length difference > threshold, DP distance CANNOT be ≤ threshold
    // (you'd need at least |lenA - lenB| insertions/deletions)
    if (Math.abs(vocabWord.length - stemToken.length) > threshold) return; // skip ~90%!
    const dist = levenshtein(stemToken, vocabWord); // only run on ~10% survivors
    if (dist < bestDist) { best = vocabWord; bestDist = dist; }
  });
}
This single O(1) integer comparison eliminates approximately 90% of vocabulary candidates before any DP work is done.

8. Phase 6: TF-IDF Scoring — Ranking the Results
File: 
indexer.js

The Formula
TF-IDF = TF × IDF

Component	Formula	What it measures
TF (Term Frequency)	termFrequency / totalTokensInDoc	How often this term appears in this document
IDF (Inverse Document Frequency)	log((N+1) / (df+1)) + 1	How rare this term is across all documents
TF-IDF	TF × IDF	Combined relevance score
javascript

function tfidf(stemToken, docId) {
  const doc      = AppState.documents.find(d => d.id === docId);
  const postings = AppState.invertedIndex.get(stemToken);
  const termFreq = postings ? (postings.get(docId) || 0) : 0;
  const totalTokens = doc.tokenCount;           // O(1) — cached by buildIndex()
  const tf = termFreq / (totalTokens || 1);     // normalise by doc length
  const df  = postings ? postings.size : 0;     // O(1) — Map.size is instant
  const N   = AppState.documents.length;
  // Laplace (+1) smoothing prevents log(0) and zero-scores
  const idf = df > 0 ? Math.log((N + 1) / (df + 1)) + 1 : 0;
  return tf * idf;
}
Why Laplace (+1) Smoothing?
Without it: a term in every document gets log(N/N) = log(1) = 0. Multiplying TF by 0 would give every document a score of 0 for common terms — those docs would never appear in results. Adding +1 to both numerator and denominator shifts the range so even universal terms keep a small positive IDF.

Worked Example
Suppose you search "closure" and there are 4 documents:

Doc 0 has "closure" 4 times, 150 total tokens
Doc 1 has "closure" 1 time, 200 total tokens
Only docs 0 and 1 contain "closure" (df = 2)
Total docs: N = 4
Doc 0:

TF = 4/150 = 0.0267
IDF = log((4+1)/(2+1)) + 1 = log(1.667) + 1 = 0.511 + 1 = 1.511
TF-IDF = 0.0267 × 1.511 = 0.0403
Doc 1:

TF = 1/200 = 0.005
IDF = same = 1.511
TF-IDF = 0.005 × 1.511 = 0.00756
Doc 0 ranks first ✓ — it mentions "closure" more frequently relative to its length.

9. Phase 7: Rendering — From Data to Screen
File: 
renderer.js

DocumentFragment — One Repaint Instead of N
A DocumentFragment is an invisible, in-memory DOM container. Elements added to it don't trigger any browser layout reflow. Only when you flush the fragment to the live DOM does a single repaint occur.

javascript

function renderResults(query, { results }) {
  const fragment = document.createDocumentFragment(); // ← invisible container
  results.forEach(r => {
    const card = document.createElement('div');
    card.innerHTML = `...`;       // builds HTML for one result card
    fragment.appendChild(card);   // ← NO repaint yet, still in memory
  });
  listEl.replaceChildren(fragment); // ← ONE repaint: all cards appear simultaneously
}
Without DocumentFragment:

javascript

results.forEach(r => {
  listEl.innerHTML += `<div>...</div>`; // ← N repaints, N layout recalculations
});
For 10 results, the fragment approach triggers 1 repaint. The naive approach triggers 10 repaints — each one forces the browser to recalculate styles and layout for the entire page.

XSS Protection with escHtml()
Any file a user uploads could contain malicious HTML like <script>alert('hacked')</script>. Before any text from documents is inserted into innerHTML, it passes through escHtml():

javascript

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
This converts <script> into the literal text &lt;script&gt; — it displays as text on screen, never executes.

Snippet Building — Finding the Right Window
buildSnippet() extracts a ~280-character excerpt centered around the first match:

javascript

function buildSnippet(text, terms) {
  const positions = findMatches(text, terms); // find all match positions
  if (positions.length === 0) return escHtml(text.slice(0, 180)) + '…';
  const anchor = positions[0].start;
  const start  = Math.max(0, anchor - 60);   // 60 chars before first match
  const end    = Math.min(text.length, anchor + 220); // 220 chars after
  // ... walk through matches, wrap in <mark> or <span class="fuzzy-hl">
}
Reverse-Order Highlight Application in the Document Viewer
When you click "View full document", openDocViewer() applies highlights line-by-line in reverse order:

javascript

const sortedReverse = [...matchesOnLine].sort((a, b) => b.localStart - a.localStart);
sortedReverse.forEach(m => {
  const before  = highlightedLine.slice(0, m.localStart);
  const word    = highlightedLine.slice(m.localStart, m.localEnd);
  const after   = highlightedLine.slice(m.localEnd);
  highlightedLine = escHtml(before) + `<mark>${escHtml(word)}</mark>` + escHtml(after);
});
Why reverse? When you inject <mark>word</mark> into a string, you add ~13 extra characters. Every subsequent match's position (which was calculated on the original string) is now wrong by +13. By processing from end to start, earlier positions in the string are never affected by later insertions.

10. Key Optimization Decisions: Map vs Object, Set vs Array
This is a critical section for interviews. Here is every data structure decision and why it was made:

Map vs. Plain Object {} for the Inverted Index
Property	Plain Object {}	Map
Prototype risk	YES — keys like "__proto__", "constructor" shadow prototype properties	None — Maps have no prototype keys
.size	Object.keys(obj).length → O(N)	map.size → O(1)
Iteration order	Insertion order (ES2015+)	Guaranteed insertion order
Key types	Strings only	Any value (strings, numbers, objects)
Dynamic user data	Unsafe — user document could contain the word "constructor"	Safe
Verdict: Use Map when keys come from user-supplied data. A document containing the word "constructor" used as a key on a plain object would silently shadow Object.prototype.constructor.

Set vs. Array for Stop Words
Operation	Array	Set
includes("the") lookup	O(N) — scans from start	O(1) — hash lookup
Memory	Array of strings	Hash-set of strings
Use case	Ordered, indexed access	Membership testing
With 150 stop words and 10,000 tokens per document, the Set saves ~1,490,000 operations per document indexed.

Set for vocabulary
AppState.vocabulary is a Set<string> separate from invertedIndex. Why not just call invertedIndex.keys()?

Because fuzzyMatch() iterates the entire vocabulary on every query token that misses the index. Calling invertedIndex.keys() returns an iterator that must be consumed each time. A Set allows a single .forEach() with O(1) .add() and .has().

Cached doc.tokenCount vs. Re-computing
tfidf() is called once per (term, matching_document) pair per query. For a query with 3 terms and 10 matching documents, that's up to 30 calls.

Without cache: each call runs tokenizeAndStem(doc.text) → O(T) work → 30 × O(T) = expensive
With cache: doc.tokenCount is a number stored on the object → O(1) read → 30 × O(1) = instant
11. Event Handling Architecture
File: 
main.js

Event Delegation — One Listener Instead of Many
Instead of attaching a click listener to every result card, suggestion item, history entry, and button, the entire app uses one click listener on document:

javascript

document.addEventListener('click', e => {
  const t = e.target;
  if (t.closest('#resultsLogoLink'))    { goHome(); return; }
  if (t.closest('.suggestion-item'))    { selectSuggestion(t.dataset.suggestion); return; }
  if (t.closest('.history-item'))       { triggerSearch(t.dataset.query); return; }
  if (t.closest('.result-title'))       { openDocViewer(parseInt(t.dataset.docid)); return; }
  if (t.closest('#headerResetBtn'))     { resetSession(); return; }
  // ... etc.
});
How it works: Every click event on any element bubbles up through the DOM tree to document. This single listener intercepts all of them. It uses t.closest(selector) to check if the clicked element (or any of its ancestors) matches a target.

Why delegation is essential here: Result cards, suggestion items, and history entries are created dynamically after the page loads. You cannot attach listeners to elements that don't exist yet. A delegated listener on document handles them automatically because it was attached before they existed.

data-* Attributes as a Communication Layer
Renderer functions store all needed context in HTML data-* attributes:

html

<a class="result-title" data-docid="3" data-query="closure">JavaScript Fundamentals</a>
The delegation listener reads these:

javascript

const docId = parseInt(t.dataset.docid, 10);
const query = t.dataset.query;
openDocViewer(docId, query);
This separates what to render (renderer.js) from what to do when clicked (main.js) — they never need to directly call each other.

12. Complete Flow Summary: A Worked Example
Let's trace exactly what happens when a user types "computr" (a typo for "computer") and presses Enter:


1. USER TYPES "computr" + presses Enter
2. homeForm "submit" event fires
   → e.preventDefault()  (no page reload)
   → triggerSearch("computr")
3. goToResults("computr")
   → hides #homePage, shows #resultsPage
   → AppState.searchHistory.unshift("computr")
   → calls search("computr")
4. search("computr")
   → tokenize("computr")       → ["computr"]      (no stop words, no punctuation to strip)
   → stem("computr")           → "computr"         (no suffix rule matches)
   → AppState.invertedIndex.has("computr") → FALSE  (it's not in the index!)
5. Fuzzy path activated
   → fuzzyMatch("computr", AppState.vocabulary, threshold=2)
   → vocabulary.forEach(vocabWord => {
       if (Math.abs(vocabWord.length - "computr".length) > 2) return; // skip 90%!
       const dist = levenshtein("computr", vocabWord);
       // levenshtein("computr", "comput") = 1  ← WINNER
     })
   → returns { best: "comput", dist: 1 }
6. correction = AppState.stemMap.get("comput") → "computer"
   (The stemMap stored "computer" when it was indexed, as the first raw word for stem "comput")
7. Score fuzzy results
   → invertedIndex.get("comput") → Map { doc0 → 12, doc2 → 3 }
   → tfidf("comput", doc0)   → 0.0562
   → scores[doc0] = 0 + 0.0562 × 0.7 = 0.0393   (30% penalty applied)
   → tfidf("comput", doc2)   → 0.0211
   → scores[doc2] = 0 + 0.0211 × 0.7 = 0.0148
8. Sort results: [ {doc0, score:0.0393}, {doc2, score:0.0148} ]
9. return { results: [...], time: "0.4", correction: "computer" }
10. renderResults("computr", { results, correction: "computer" })
    → Shows banner: "Showing results for: computer"
    → Creates DocumentFragment with 2 result cards
    → Each card gets snippet via buildSnippet() with <span class="fuzzy-hl"> highlights
    → listEl.replaceChildren(fragment) → ONE DOM repaint
11. updateStats()
    → sQueryTime.textContent = "0.4ms"
    → sResultCount.textContent = "2"
12. USER SEES: 2 result cards, yellow underlines on "computer" in snippets,
               orange "~ Fuzzy match" badges, "Showing results for: computer" banner
Total time from Enter key to rendered results: < 1ms on a modern browser.

TIP

Interview Cheat Sheet — The 5 Key Points

Map over Object → no prototype key collision risk with user data; O(1) .size
Set over Array → O(1) .has() for stop-word checks, ~150× faster per document
Promise.all over callback counter → buildIndex() runs exactly once; race-condition-free
DocumentFragment over innerHTML += → 1 repaint instead of N repaints
Length pre-filter before Levenshtein → eliminates ~90% of candidates before O(A×B) DP work
