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
//  │  PERFORMANCE NOTE — DocumentFragment (spec §5):                   │
//  │  Result cards are built into a DocumentFragment and inserted      │
//  │  with a single replaceChildren() call. This triggers exactly ONE  │
//  │  layout reflow instead of N reflows for N cards. The browser      │
//  │  batches the entire paint into one repaint cycle.                 │
//  │                                                                    │
//  │  EVENT DELEGATION NOTE:                                           │
//  │  Result cards use data-* attributes (data-docid, data-query,      │
//  │  data-dir, data-total, data-suggestion, data-query) instead of    │
//  │  inline onclick handlers. The single delegated listener in        │
//  │  main.js reads these attributes to dispatch actions.             │
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
//  │     as the user scrolls. For our corpus (<25MB, <30 docs),        │
//  │     full rendering is fine.                                        │
//  └─────────────────────────────────────────────────────────────────────┘

// ── MATCH NAVIGATION STATE ────────────────────────────────────────────
const matchCursors = {}; // { docId: currentMatchIndex } for inline card nav

// Document viewer state
let viewerMatches  = []; // array of line indices that have matches
let viewerMatchIdx = 0;  // which match line we are currently at

// ── CORE RENDER FUNCTIONS ─────────────────────────────────────────────

/**
 * renderResults(query, searchResult) — Populates the results page with
 * ranked result cards, using DocumentFragment for a single-repaint DOM
 * update (spec §5).
 *
 * @param {string} query        — the raw user query (for display)
 * @param {Object} searchResult — { results, time, correction } from search()
 */
function renderResults(query, { results, time, correction }) {
  // Persist last results on AppState for report download and doc removal.
  AppState.lastQuery   = query;
  AppState.lastResults = results;

  // ── Update stats sidebar ──────────────────────────────────────────
  document.getElementById('sQueryTime').textContent   = time + 'ms';
  document.getElementById('sResultCount').textContent = results.length;

  // ── Meta row — Google style: "About N results (X ms)" ────────────
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

  const listEl = document.getElementById('resultsList');

  // ── No results state ─────────────────────────────────────────────
  if (results.length === 0) {
    listEl.innerHTML = `
      <div class="no-results">
        <p style="font-size:16px;color:#202124;margin-bottom:8px">
          Your search — <strong>${escHtml(query)}</strong> — did not match any documents.
        </p>
        <p style="font-size:14px;color:#70757a;line-height:1.6">
          Suggestions:<br>
          • Make sure all words are spelled correctly.<br>
          • Try different keywords.<br>
          • Upload more documents and try again.
        </p>
      </div>`;
    return;
  }

  // ── Build result cards into a DocumentFragment (spec §5) ─────────
  //  A DocumentFragment is an in-memory, lightweight DOM container.
  //  Elements appended to it are NOT part of the live document, so no
  //  reflows are triggered. A single replaceChildren() call inserts the
  //  entire batch into the live DOM in one repaint.
  const fragment = document.createDocumentFragment();

  results.forEach((r, i) => {
    const matchPositions = findMatches(r.doc.text, r.terms);
    const matchCount     = matchPositions.length;
    const fileName       = r.doc.name.replace(/\.[^.]+$/, ''); // strip extension

    // Create the card element — safer than bulk innerHTML on the live list
    const card = document.createElement('div');
    card.className = 'result-card';
    card.setAttribute('role', 'listitem');
    card.style.animationDelay = `${i * 0.05}s`;

    // Build card HTML — data-* attributes power event delegation in main.js
    card.innerHTML = `
      <div class="result-url-row">
        <div class="result-favicon" aria-hidden="true">📄</div>
        <div>
          <div class="result-site-name">${escHtml(fileName)}</div>
          <span class="result-breadcrumb">${escHtml(r.doc.name)}</span>
        </div>
      </div>

      <a class="result-title"
         data-docid="${r.doc.id}"
         data-query="${escHtml(query)}"
         role="button"
         tabindex="0"
         aria-label="View ${escHtml(fileName)}">
        ${escHtml(fileName)}
      </a>

      <div class="result-badges">
        ${i === 0 ? '<span class="badge-sm badge-top">⭐ Top result</span>' : ''}
        ${r.isFuzzy
          ? '<span class="badge-sm badge-fuzzy">~ Fuzzy match</span>'
          : '<span class="badge-sm badge-exact">✓ Exact match</span>'}
      </div>



      <div class="result-snippet">${buildSnippet(r.doc.text, r.terms)}</div>

      ${matchCount > 0 ? `
      <div class="match-navigator" data-docid="${r.doc.id}">
        <span aria-hidden="true">📍</span>
        <span class="match-count" id="mc-${r.doc.id}">1 of ${matchCount} match${matchCount !== 1 ? 'es' : ''}</span>
        <button class="match-nav-btn"
          data-docid="${r.doc.id}" data-dir="-1" data-total="${matchCount}"
          id="mprev-${r.doc.id}" disabled aria-label="Previous match">↑</button>
        <button class="match-nav-btn"
          data-docid="${r.doc.id}" data-dir="1" data-total="${matchCount}"
          id="mnext-${r.doc.id}" ${matchCount <= 1 ? 'disabled' : ''}
          aria-label="Next match">↓</button>
        <span aria-hidden="true" style="color:#dadce0">·</span>
        <span class="view-all-link" data-docid="${r.doc.id}" role="button"
          tabindex="0">View full document →</span>
      </div>` : ''}
    `;

    fragment.appendChild(card);
  });

  // Single DOM write — one repaint (spec §5)
  listEl.replaceChildren(fragment);

  // Initialise per-card match cursors at position 0.
  results.forEach(r => { matchCursors[r.doc.id] = 0; });
}

/**
 * navigateMatch(docId, dir, total) — Increments/decrements the match
 * cursor for a specific result card and updates its counter display.
 */
function navigateMatch(docId, dir, total) {
  matchCursors[docId] = Math.max(0, Math.min((matchCursors[docId] || 0) + dir, total - 1));
  const current = matchCursors[docId] + 1;
  document.getElementById(`mc-${docId}`).textContent =
    `${current} of ${total} match${total !== 1 ? 'es' : ''}`;
  document.getElementById(`mprev-${docId}`).disabled = current === 1;
  document.getElementById(`mnext-${docId}`).disabled = current === total;
}

// ── DOCUMENT VIEWER ───────────────────────────────────────────────────

/**
 * openDocViewer(docId, query) — Opens the full-document modal with
 * syntax-highlighted matches and line-by-line navigation.
 *
 * ALGORITHM: Highlights are applied in REVERSE ORDER within each line.
 * (See interview defence at top of file for explanation.)
 */
function openDocViewer(docId, query) {
  const doc    = AppState.documents.find(d => d.id === docId);
  if (!doc) return;

  const result = AppState.lastResults.find(r => r.doc.id === docId);
  const terms  = result?.terms || [];

  const lines      = doc.text.split('\n');
  const allMatches = findMatches(doc.text, terms);

  // ── Map character-position matches → line indices ─────────────────
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
          localStart: m.start - lineStart,
          localEnd:   m.end   - lineStart,
          matchIndex: matchIdx
        });
      }
    });

    charCount += line.length + 1; // +1 for the '\n' that .split() consumed
  });

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

  // ── Render line-by-line into a DocumentFragment ───────────────────
  const bodyFragment = document.createDocumentFragment();

  lines.forEach((line, lineIdx) => {
    const matchesOnLine = lineMatchMap[lineIdx] || [];
    const hasMatch      = matchesOnLine.length > 0;
    const isFirstMatch  = viewerMatches[0] === lineIdx;

    // Apply highlights in REVERSE ORDER to preserve offset correctness.
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
      highlightedLine = escHtml(before) + wrapped + escHtml(after);
    });

    if (matchesOnLine.length === 0) {
      highlightedLine = escHtml(line);
    }

    const lineEl = document.createElement('div');
    lineEl.className = `doc-line${hasMatch ? ' has-match' : ''}${isFirstMatch ? ' active-match' : ''}`;
    lineEl.id = `vline-${lineIdx}`;
    lineEl.innerHTML = `
      <span class="line-num">${lineIdx + 1}</span>
      <span class="line-content">${highlightedLine || '&nbsp;'}</span>
    `;
    bodyFragment.appendChild(lineEl);
  });

  const body = document.getElementById('viewerBody');
  body.replaceChildren(bodyFragment);

  document.getElementById('docViewerOverlay').classList.add('show');

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
 * updateIndexView() — Shows the first 20 entries of the live inverted index.
 */
function updateIndexView() {
  const body    = document.getElementById('indexBody');
  const entries = [...AppState.invertedIndex.entries()].slice(0, 20);

  // Use DocumentFragment for sidebar index view too (spec §5 consistency)
  const frag = document.createDocumentFragment();
  entries.forEach(([term, postings]) => {
    const row = document.createElement('div');
    row.className = 'idx-row';
    const chips = [...postings.entries()]
      .map(([id, freq]) => `<span class="idx-ref">doc:${id}×${freq}</span>`)
      .join('');
    row.innerHTML = `<span class="idx-key">"${escHtml(term)}"</span>${chips}`;
    frag.appendChild(row);
  });
  body.replaceChildren(frag);
}

/**
 * updateDocChips() — Renders the list of currently-indexed document chips
 * with individual remove buttons. Uses data-docid for delegation.
 */
function updateDocChips() {
  const container = document.getElementById('docChips');
  if (!container) return;

  if (AppState.documents.length === 0) {
    container.innerHTML = '<p class="no-docs-hint">No documents indexed yet.</p>';
    return;
  }

  const frag = document.createDocumentFragment();
  AppState.documents.forEach(d => {
    const chip = document.createElement('div');
    chip.className = 'doc-chip';
    chip.innerHTML = `
      <span class="dot"></span>
      ${escHtml(d.name)}
      <span class="rm" data-docid="${d.id}" title="Remove document"
        role="button" tabindex="0" aria-label="Remove ${escHtml(d.name)}">×</span>
    `;
    frag.appendChild(chip);
  });
  container.replaceChildren(frag);
}

/**
 * removeDoc(id) — Removes a single document and rebuilds the index.
 */
function removeDoc(id) {
  AppState.documents = AppState.documents.filter(d => d.id !== id);
  buildIndex();
  if (AppState.lastQuery) goToResults(AppState.lastQuery);
}

// ── HISTORY SIDEBAR ───────────────────────────────────────────────────

/**
 * renderHistory() — Renders the recent-searches list. Uses data-query
 * and data-index attributes for event delegation in main.js.
 */
function renderHistory() {
  const el = document.getElementById('historyList');
  if (!el) return;

  if (AppState.searchHistory.length === 0) {
    el.innerHTML = '<div style="font-size:13px;color:#9aa0a6">No searches yet</div>';
    return;
  }

  const frag = document.createDocumentFragment();
  AppState.searchHistory.forEach((h, i) => {
    const item = document.createElement('div');
    item.className = 'history-item';
    item.dataset.query = h;
    item.innerHTML = `
      <span class="h-icon" aria-hidden="true">🕐</span>
      <span>${escHtml(h)}</span>
      <span class="h-remove" data-index="${i}"
        role="button" tabindex="0" aria-label="Remove search: ${escHtml(h)}">×</span>
    `;
    frag.appendChild(item);
  });
  el.replaceChildren(frag);
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
 * Uses data-suggestion for event delegation in main.js.
 */
function renderSuggestions(q, boxId) {
  const box   = document.getElementById(boxId);
  const items = getSuggestions(q);

  if (!q || items.length === 0) {
    box.classList.remove('show');
    return;
  }

  const frag = document.createDocumentFragment();
  items.forEach(s => {
    const item = document.createElement('div');
    item.className = 'suggestion-item';
    item.dataset.suggestion = s;
    item.setAttribute('role', 'option');
    item.innerHTML = `
      <span class="sug-icon" aria-hidden="true">
        ${AppState.searchHistory.includes(s)
          ? '<svg focusable="false" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"><path fill="#9aa0a6" d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/></svg>'
          : '<svg focusable="false" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"><path fill="#9aa0a6" d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>'}
      </span>
      <span>${escHtml(q)}<mark>${escHtml(s.slice(q.length))}</mark></span>
      <span class="sug-right" aria-hidden="true">↵</span>
    `;
    frag.appendChild(item);
  });
  box.replaceChildren(frag);
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
 */
function downloadReport() {
  if (!AppState.lastQuery) {
    showToast('Run a search first.', 'info');
    return;
  }

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
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
