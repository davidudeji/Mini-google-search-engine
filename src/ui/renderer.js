// ══════════════════════════════════════════════════════════════════════
//  UI RENDERER  —  src/ui/renderer.js
// ══════════════════════════════════════════════════════════════════════
//
//  ┌─ EXPLAIN-BEFORE-CODE: CONCEPTUAL 'WHY' ───────────────────────────┐
//  │                                                                    │
//  │  Separating rendering from data logic implements the VIEW layer   │
//  │  of a Model-View pattern. Benefits:                               │
//  │                                                                    │
//  │  1. The search/index engine has no DOM dependency — it could run   │
//  │     in a Web Worker or Node.js environment without modification.  │
//  │  2. All innerHTML construction happens here, so there is exactly  │
//  │     ONE place to audit for XSS vulnerabilities.                   │
//  │  3. If we ever replace the UI framework (e.g., move to React),    │
//  │     only this file changes — the engine is untouched.            │
//  │                                                                    │
//  │  PERFORMANCE NOTE — innerHTML vs. DOM API:                        │
//  │  We use innerHTML for result cards because building 10–20 cards   │
//  │  via DOM API (createElement, appendChild) would require ~50–100   │
//  │  individual DOM calls. Constructing a single HTML string and      │
//  │  setting innerHTML once is faster for batch updates because the   │
//  │  browser only needs to parse and paint the DOM tree once.        │
//  │  The trade-off: HTML strings are harder to unit-test. Acceptable  │
//  │  for a single-developer portfolio project.                        │
//  └────────────────────────────────────────────────────────────────────┘
//
//  ┌─ INTERVIEW DEFENCE ────────────────────────────────────────────────┐
//  │  Q: "Why is document viewer content built line-by-line in reverse  │
//  │     order when applying highlights?"                               │
//  │  A: When you inject a highlight span into a string, it changes the │
//  │     character offsets of everything that comes AFTER it. By        │
//  │     applying highlights from the END of the string backwards, each │
//  │     replacement doesn't affect the indices of the earlier          │
//  │     (unprocessed) matches. Processing forwards would require        │
//  │     offset-adjustment tracking after every replacement, which is   │
//  │     error-prone. Reverse order is the canonical solution.          │
//  │                                                                    │
//  │  Q: "How would you virtualise the result list for very large       │
//  │     result sets (e.g., 10,000 results)?"                           │
//  │  A: Implement windowed rendering — only render cards for the       │
//  │     ~10 items currently visible in the viewport. Use an           │
//  │     IntersectionObserver or scroll listener to load the next batch │
//  │     of cards as the user scrolls. Libraries like react-window do  │
//  │     this. For our corpus constraint (< 25MB, typical < 30 docs),  │
//  │     full rendering is fine.                                        │
//  └─────────────────────────────────────────────────────────────────────┘

// ── MATCH NAVIGATION STATE ────────────────────────────────────────────
// These are tightly coupled to rendered cards, so they live here.
const matchCursors = {}; // { docId: currentMatchIndex } for inline card nav

// Document viewer state
let viewerMatches  = []; // array of line indices that have matches
let viewerMatchIdx = 0;  // which match line we are currently at

// ── CORE RENDER FUNCTIONS ─────────────────────────────────────────────

/**
 * renderResults(query, searchResult) — Populates the results page
 * with ranked result cards. Called by goToResults() in main.js.
 *
 * @param {string} query        — the raw user query (for display)
 * @param {Object} searchResult — { results, time, correction } from search()
 */
function renderResults(query, { results, time, correction }) {
  // Persist last results on AppState for report download and doc removal.
  AppState.lastQuery   = query;
  AppState.lastResults = results;

  // ── Update stats sidebar ──────────────────────────────────────────
  document.getElementById('sQueryTime').textContent    = time + 'ms';
  document.getElementById('sResultCount').textContent  = results.length;

  // ── Meta row ─────────────────────────────────────────────────────
  document.getElementById('resultsMeta').textContent =
    `About ${results.length} result${results.length !== 1 ? 's' : ''} (${time} ms)`;

  // ── Fuzzy correction banner ───────────────────────────────────────
  const banner = document.getElementById('correctionBanner');
  if (correction) {
    banner.style.display = 'inline-flex';
    document.getElementById('correctionWord').textContent = correction;
  } else {
    banner.style.display = 'none';
  }

  // ── No results state ─────────────────────────────────────────────
  if (results.length === 0) {
    document.getElementById('resultsList').innerHTML = `
      <div class="no-results">
        <div style="font-size:48px;margin-bottom:12px">🔍</div>
        <h2>No results for "<strong>${escHtml(query)}</strong>"</h2>
        <p style="margin-top:6px;font-size:14px;color:var(--text-muted)">
          Try a different keyword, check spelling, or upload more documents.
        </p>
      </div>`;
    return;
  }

  // ── Result cards ─────────────────────────────────────────────────
  document.getElementById('resultsList').innerHTML = results.map((r, i) => {
    const matchPositions = findMatches(r.doc.text, r.terms);
    const matchCount     = matchPositions.length;
    const fileName       = r.doc.name.replace(/\.[^.]+$/, ''); // strip extension

    return `
    <div class="result-card" style="animation-delay:${i * 0.05}s">
      <div class="result-url-row">
        <div class="result-favicon">📄</div>
        <span class="result-url">${escHtml(r.doc.name)}</span>
      </div>
      <div class="result-title" onclick="openDocViewer(${r.doc.id}, '${escHtml(query).replace(/'/g, "\\'")}')">
        ${escHtml(fileName)}
      </div>
      <div class="result-badges">
        ${i === 0 ? '<span class="badge-sm badge-top">⭐ Top result</span>' : ''}
        ${r.isFuzzy
          ? '<span class="badge-sm badge-fuzzy">~ Fuzzy match</span>'
          : '<span class="badge-sm badge-exact">✓ Exact match</span>'}
      </div>
      <div class="result-score-row">
        <div class="score-track">
          <div class="score-fill" style="width:${r.pct}%"></div>
        </div>
        <span class="score-pct">TF-IDF ${r.score.toFixed(4)} · ${r.pct}% relevance</span>
      </div>
      <div class="result-snippet">${buildSnippet(r.doc.text, r.terms)}</div>
      ${matchCount > 0 ? `
      <div class="match-navigator" data-docid="${r.doc.id}">
        <span style="font-size:13px">📍</span>
        <span class="match-count" id="mc-${r.doc.id}">1 of ${matchCount} matches</span>
        <button class="match-nav-btn" onclick="navigateMatch(${r.doc.id},-1,${matchCount})"
          id="mprev-${r.doc.id}" disabled>↑</button>
        <button class="match-nav-btn" onclick="navigateMatch(${r.doc.id},1,${matchCount})"
          id="mnext-${r.doc.id}" ${matchCount <= 1 ? 'disabled' : ''}>↓</button>
        <span style="color:var(--text-dim);font-size:12px">·</span>
        <span class="view-all-link"
          onclick="openDocViewer(${r.doc.id},'${escHtml(query).replace(/'/g, "\\'")}')">
          View all →
        </span>
      </div>` : ''}
    </div>`;
  }).join('');

  // Initialise per-card match cursors at position 0.
  results.forEach(r => { matchCursors[r.doc.id] = 0; });
}

/**
 * navigateMatch(docId, dir, total) — Increments/decrements the match
 * cursor for a specific result card and updates its counter display.
 * This is a UI-only function — no engine logic.
 */
function navigateMatch(docId, dir, total) {
  matchCursors[docId] = Math.max(0, Math.min((matchCursors[docId] || 0) + dir, total - 1));
  const current = matchCursors[docId] + 1;
  document.getElementById(`mc-${docId}`).textContent = `${current} of ${total} matches`;
  document.getElementById(`mprev-${docId}`).disabled = current === 1;
  document.getElementById(`mnext-${docId}`).disabled = current === total;
}

// ── DOCUMENT VIEWER ───────────────────────────────────────────────────

/**
 * openDocViewer(docId, query) — Opens the full-document modal with
 * syntax-highlighted matches and line-by-line navigation.
 *
 * ALGORITHM: To highlight matches within lines without corrupting
 * offsets, we apply substitutions in REVERSE ORDER within each line.
 * (See interview defence at top of file for explanation.)
 */
function openDocViewer(docId, query) {
  const doc    = AppState.documents.find(d => d.id === docId);
  if (!doc) return;

  // Retrieve the match terms from the last search result for this doc.
  const result = AppState.lastResults.find(r => r.doc.id === docId);
  const terms  = result?.terms || [];

  const lines      = doc.text.split('\n');
  const allMatches = findMatches(doc.text, terms);

  // ── Map character-position matches → line indices ─────────────────
  // We walk through the document character by character to know which
  // line each match position falls on.
  let charCount    = 0;
  const lineMatchMap = {};

  lines.forEach((line, lineIdx) => {
    const lineStart = charCount;
    const lineEnd   = charCount + line.length;

    allMatches.forEach((m, matchIdx) => {
      if (m.start >= lineStart && m.start < lineEnd) {
        if (!lineMatchMap[lineIdx]) lineMatchMap[lineIdx] = [];
        lineMatchMap[lineIdx].push({
          ...m,
          // Convert to line-local offsets for in-line string surgery.
          localStart: m.start - lineStart,
          localEnd:   m.end   - lineStart,
          matchIndex: matchIdx
        });
      }
    });

    // +1 accounts for the '\n' character that .split() consumed.
    charCount += line.length + 1;
  });

  // Collect all line indices that have at least one match.
  viewerMatches  = Object.keys(lineMatchMap).map(Number);
  viewerMatchIdx = 0;

  // ── Populate viewer header ────────────────────────────────────────
  document.getElementById('viewerTitle').textContent = doc.name;
  document.getElementById('viewerMatchInfo').textContent =
    viewerMatches.length
      ? `${viewerMatchIdx + 1} of ${allMatches.length} matches`
      : 'No matches';

  document.getElementById('viewerPrev').disabled = true;
  document.getElementById('viewerNext').disabled = viewerMatches.length <= 1;

  // ── Render line-by-line content ───────────────────────────────────
  const body = document.getElementById('viewerBody');
  body.innerHTML = lines.map((line, lineIdx) => {
    const matchesOnLine = lineMatchMap[lineIdx] || [];
    const hasMatch      = matchesOnLine.length > 0;
    const isFirstMatch  = viewerMatches[0] === lineIdx;

    // Apply highlights in REVERSE ORDER to preserve offset correctness.
    // (Inserting HTML forward shifts all subsequent character positions.)
    const sortedReverse = [...matchesOnLine].sort((a, b) => b.localStart - a.localStart);
    let highlightedLine = line;

    sortedReverse.forEach(m => {
      const before  = highlightedLine.slice(0, m.localStart);
      const word    = highlightedLine.slice(m.localStart, m.localEnd);
      const after   = highlightedLine.slice(m.localEnd);
      const cls     = m.type === 'fuzzy' ? 'fuzzy-hl' : '';
      const wrapped = cls
        ? `<span class="${cls}">${escHtml(word)}</span>`
        : `<mark>${escHtml(word)}</mark>`;
      // NOTE: before/after are raw; they will be escHtml'd in the final join.
      // We store the raw string and escape only non-highlighted segments.
      highlightedLine = escHtml(before) + wrapped + escHtml(after);
    });

    // If no matches on this line, escape the entire line for safety.
    if (matchesOnLine.length === 0) {
      highlightedLine = escHtml(line);
    }

    return `<div class="doc-line ${hasMatch ? 'has-match' : ''} ${isFirstMatch ? 'active-match' : ''}"
      id="vline-${lineIdx}">
      <span class="line-num">${lineIdx + 1}</span>
      <span class="line-content">${highlightedLine || '&nbsp;'}</span>
    </div>`;
  }).join('');

  // Show the overlay.
  document.getElementById('docViewerOverlay').classList.add('show');

  // Scroll to first matched line after the DOM has painted.
  if (viewerMatches.length > 0) {
    setTimeout(() => scrollToViewerLine(viewerMatches[0]), 50);
  }
}

function scrollToViewerLine(lineIdx) {
  const el = document.getElementById(`vline-${lineIdx}`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/**
 * navigateViewerMatch(dir) — Moves the active highlight in the document
 * viewer forward (+1) or backward (-1) through matched lines.
 */
function navigateViewerMatch(dir) {
  // Remove active class from the current line.
  document.querySelectorAll('.doc-line.active-match')
    .forEach(el => el.classList.remove('active-match'));

  viewerMatchIdx = Math.max(0, Math.min(viewerMatchIdx + dir, viewerMatches.length - 1));
  const nextLineIdx = viewerMatches[viewerMatchIdx];

  document.getElementById(`vline-${nextLineIdx}`)?.classList.add('active-match');
  document.getElementById('viewerMatchInfo').textContent =
    `${viewerMatchIdx + 1} of ${viewerMatches.length} lines with matches`;

  document.getElementById('viewerPrev').disabled = viewerMatchIdx === 0;
  document.getElementById('viewerNext').disabled = viewerMatchIdx === viewerMatches.length - 1;

  scrollToViewerLine(nextLineIdx);
}

/**
 * closeViewer(e) — Closes the document viewer modal.
 * Only closes if the click was on the overlay backdrop itself
 * (not on the inner viewer card), or if called with no event.
 */
function closeViewer(e) {
  if (!e || e.target === document.getElementById('docViewerOverlay')) {
    document.getElementById('docViewerOverlay').classList.remove('show');
  }
}

// ── SIDEBAR PANELS ────────────────────────────────────────────────────

/**
 * updateStats() — Refreshes the 4-box stats grid in the sidebar.
 */
function updateStats() {
  document.getElementById('sDocCount').textContent   = AppState.documents.length;
  document.getElementById('sVocabCount').textContent = AppState.vocabulary.size;
  document.getElementById('indexTermCount').textContent =
    AppState.vocabulary.size + ' terms';
}

/**
 * updateIndexView() — Shows the first 20 entries of the live inverted
 * index in the sidebar panel. This is a portfolio "wow factor" feature
 * that lets recruiters see the data structure update in real time.
 */
function updateIndexView() {
  const body    = document.getElementById('indexBody');
  // Convert Map entries to an array and take the first 20.
  const entries = [...AppState.invertedIndex.entries()].slice(0, 20);

  body.innerHTML = entries.map(([term, postings]) => {
    const postingChips = [...postings.entries()]
      .map(([id, freq]) => `<span class="idx-ref">doc:${id}×${freq}</span>`)
      .join('');
    return `<div class="idx-row">
      <span class="idx-key">"${escHtml(term)}"</span>
      ${postingChips}
    </div>`;
  }).join('');
}

/**
 * updateDocChips() — Renders the list of currently-indexed document
 * chips with individual remove buttons.
 */
function updateDocChips() {
  const container = document.getElementById('docChips');
  if (!container) return; // guard for cases where HTML hasn't loaded yet

  if (AppState.documents.length === 0) {
    container.innerHTML = '<p class="no-docs-hint">No documents indexed yet.</p>';
    return;
  }

  container.innerHTML = AppState.documents.map(d => `
    <div class="doc-chip">
      <span class="dot"></span>
      ${escHtml(d.name)}
      <span class="rm" onclick="removeDoc(${d.id})" title="Remove document">×</span>
    </div>`).join('');
}

/**
 * removeDoc(id) — Removes a single document and rebuilds the index.
 * After removal, re-runs the last query so results stay fresh.
 */
function removeDoc(id) {
  AppState.documents = AppState.documents.filter(d => d.id !== id);
  buildIndex();
  // Re-run the last query so the results page reflects the removal.
  if (AppState.lastQuery) goToResults(AppState.lastQuery);
}

// ── HISTORY SIDEBAR ───────────────────────────────────────────────────

/**
 * renderHistory() — Renders the recent-searches list in the sidebar.
 */
function renderHistory() {
  const el = document.getElementById('historyList');
  if (!el) return;

  if (AppState.searchHistory.length === 0) {
    el.innerHTML = '<div style="font-size:13px;color:var(--text-dim)">No searches yet</div>';
    return;
  }

  el.innerHTML = AppState.searchHistory.map((h, i) => `
    <div class="history-item" onclick="triggerSearch('${escHtml(h).replace(/'/g, "\\'")}')">
      <span class="h-icon">🕐</span>
      <span>${escHtml(h)}</span>
      <span class="h-remove" onclick="event.stopPropagation();removeHistory(${i})">×</span>
    </div>`).join('');
}

/**
 * removeHistory(i) — Removes a single entry from the search history.
 */
function removeHistory(i) {
  AppState.searchHistory.splice(i, 1);
  renderHistory();
}

// ── AUTOCOMPLETE SUGGESTIONS ──────────────────────────────────────────

/**
 * renderSuggestions(q, boxId) — Populates a suggestions dropdown.
 * Called by the debounced input handler in main.js.
 */
function renderSuggestions(q, boxId) {
  const box   = document.getElementById(boxId);
  const items = getSuggestions(q);

  if (!q || items.length === 0) {
    box.classList.remove('show');
    return;
  }

  box.innerHTML = items.map(s => `
    <div class="suggestion-item" onclick="selectSuggestion('${escHtml(s).replace(/'/g, "\\'")}')">
      <span class="sug-icon">${AppState.searchHistory.includes(s) ? '🕐' : '🔍'}</span>
      <span>${escHtml(q)}<mark>${escHtml(s.slice(q.length))}</mark></span>
      <span class="sug-right">↵</span>
    </div>`).join('');

  box.classList.add('show');
}

/**
 * selectSuggestion(text) — Fires when a suggestion dropdown item is clicked.
 */
function selectSuggestion(text) {
  document.getElementById('homeInput').value    = text;
  document.getElementById('resultsInput').value = text;
  document.querySelectorAll('.suggestions-box').forEach(b => b.classList.remove('show'));
  triggerSearch(text);
}

// ── DOWNLOAD REPORT ───────────────────────────────────────────────────

/**
 * downloadReport() — Generates a plain-text search report and triggers
 * a browser download via a temporary Blob URL.
 *
 * Blob + URL.createObjectURL is the correct browser-native way to
 * trigger a file download without a server round-trip.
 */
function downloadReport() {
  if (!AppState.lastQuery) { alert('Run a search first.'); return; }

  const lines = [
    `DavSearch Report`,
    `════════════════════════════════`,
    `Query:             "${AppState.lastQuery}"`,
    `Date:              ${new Date().toLocaleString()}`,
    `Results returned:  ${AppState.lastResults.length}`,
    `Documents indexed: ${AppState.documents.length}`,
    `Vocabulary size:   ${AppState.vocabulary.size} unique stems`,
    ``,
    `───── RESULTS ─────`,
    ...AppState.lastResults.map((r, i) => `
[${i + 1}] ${r.doc.name}
    Relevance:  ${r.pct}%  |  TF-IDF score: ${r.score.toFixed(6)}
    Match type: ${r.isFuzzy ? 'Fuzzy (typo-corrected)' : 'Exact'}
    Preview:    ${r.doc.text.slice(0, 140).replace(/\n/g, ' ')}…
`)
  ];

  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = `davsearch-${AppState.lastQuery.replace(/\s+/g, '-')}.txt`;
  a.click();
  // Revoke the object URL after a short delay to free browser memory.
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
