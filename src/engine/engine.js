
// ══════════════════════════════════════════════
//  ENGINE
// ══════════════════════════════════════════════

const STOP_WORDS = new Set(['the', 'is', 'at', 'which', 'on', 'a', 'an', 'and', 'or', 'for', 'in', 'of', 'to', 'it', 'be', 'was', 'are', 'by', 'that', 'this', 'with', 'from', 'as', 'not', 'but', 'we', 'you', 'i', 'he', 'she', 'they', 'have', 'had', 'has', 'do', 'did', 'does', 'can', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'shall', 'very', 'just', 'more', 'also', 'than', 'into', 'about', 'so', 'if', 'up', 'out', 'there', 'then', 'when', 'where', 'who', 'how', 'what', 'all', 'been', 'their', 'its', 'our', 'your', 'his', 'her', 'them', 'these', 'those', 'some', 'any', 'each', 'no', 'only', 'such', 'same', 'other', 'over', 'after', 'before', 'between', 'through', 'during', 'without', 'within', 'along', 'following', 'across', 'behind', 'beyond', 'plus', 'except', 'up', 'out', 'around', 'down', 'off', 'above', 'below', 'use', 'used', 'using', 'get', 'got', 'new', 'one', 'two', 'three', 'time', 'way']);

// Simple suffix stemmer — strips common English suffixes
function stem(word) {
    if (word.length < 5) return word;
    if (word.endsWith('ing')) return word.slice(0, -3);
    if (word.endsWith('tion')) return word.slice(0, -3);
    if (word.endsWith('ness')) return word.slice(0, -4);
    if (word.endsWith('ment')) return word.slice(0, -4);
    if (word.endsWith('able') || word.endsWith('ible')) return word.slice(0, -4);
    if (word.endsWith('ive') || word.endsWith('ous') || word.endsWith('ful')) return word.slice(0, -3);
    if (word.endsWith('ed') && word.length > 5) return word.slice(0, -2);
    if (word.endsWith('er') && word.length > 5) return word.slice(0, -2);
    if (word.endsWith('ly') && word.length > 5) return word.slice(0, -2);
    if (word.endsWith('es') && word.length > 4) return word.slice(0, -2);
    if (word.endsWith('s') && word.length > 4) return word.slice(0, -1);
    return word;
}

function tokenize(text) {
    return text.toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 1 && !STOP_WORDS.has(w));
}

function tokenizeAndStem(text) {
    return tokenize(text).map(stem);
}

// Levenshtein distance
function levenshtein(a, b) {
    if (Math.abs(a.length - b.length) > 3) return 99;
    const dp = Array.from({ length: a.length + 1 }, (_, i) =>
        Array.from({ length: b.length + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
    for (let i = 1; i <= a.length; i++)
        for (let j = 1; j <= b.length; j++)
            dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    return dp[a.length][b.length];
}

// ── STATE ──
let documents = [];
let invertedIndex = {};        // stemmed token → { docId: frequency }
let vocabulary = new Set();    // all stemmed tokens
let stemMap = {};              // stemmed → original word (for display)
let searchHistory = [];
let lastQuery = '';
let lastResults = [];
let currentMode = 'fuzzy';

// ── BUILD INDEX ──
function buildIndex() {
    invertedIndex = {};
    vocabulary = new Set();
    stemMap = {};
    documents.forEach(doc => {
        const rawTokens = tokenize(doc.text);
        rawTokens.forEach(raw => {
            const s = stem(raw);
            vocabulary.add(s);
            stemMap[s] = stemMap[s] || raw;
            if (!invertedIndex[s]) invertedIndex[s] = {};
            invertedIndex[s][doc.id] = (invertedIndex[s][doc.id] || 0) + 1;
        });
    });
    updateStats();
    updateIndexView();
    updateDocChips();
}

// TF-IDF
function tfidf(stemToken, docId) {
    const doc = documents.find(d => d.id === docId);
    if (!doc) return 0;
    const totalTokens = tokenizeAndStem(doc.text).length;
    const tf = (invertedIndex[stemToken]?.[docId] || 0) / (totalTokens || 1);
    const df = Object.keys(invertedIndex[stemToken] || {}).length;
    const idf = df > 0 ? Math.log((documents.length + 1) / (df + 1)) + 1 : 0;
    return tf * idf;
}

// ── SEARCH ──
function search(query) {
    const t0 = performance.now();
    if (!query.trim() || documents.length === 0) return { results: [], time: 0, correction: null };

    const rawTokens = tokenize(query);
    const stemTokens = rawTokens.map(stem);
    const scores = {};
    const matchedTerms = {};
    const fuzzyMappings = {};   // original stem → matched stem
    let correction = null;

    stemTokens.forEach((stemToken, i) => {
        const rawToken = rawTokens[i];

        if (invertedIndex[stemToken]) {
            // Exact (stem) match
            Object.keys(invertedIndex[stemToken]).forEach(docId => {
                const id = +docId;
                scores[id] = (scores[id] || 0) + tfidf(stemToken, id);
                (matchedTerms[id] = matchedTerms[id] || []).push({ stemToken, rawToken, type: 'exact' });
            });
        } else {
            // Fuzzy: find closest word in vocab
            let best = null, bestDist = 3;
            vocabulary.forEach(v => {
                if (Math.abs(v.length - stemToken.length) > 3) return;
                const dist = levenshtein(stemToken, v);
                if (dist < bestDist) { best = v; bestDist = dist; }
            });
            if (best) {
                fuzzyMappings[stemToken] = best;
                if (!correction) correction = stemMap[best] || best;
                Object.keys(invertedIndex[best] || {}).forEach(docId => {
                    const id = +docId;
                    scores[id] = (scores[id] || 0) + tfidf(best, id) * 0.7;
                    (matchedTerms[id] = matchedTerms[id] || []).push({ stemToken: best, rawToken, type: 'fuzzy', corrected: stemMap[best] || best });
                });
            }
        }
    });

    const maxScore = Math.max(...Object.values(scores), 0.0001);
    const results = Object.entries(scores)
        .map(([id, score]) => ({
            doc: documents.find(d => d.id === +id),
            score,
            pct: Math.round((score / maxScore) * 100),
            terms: matchedTerms[+id] || [],
            isFuzzy: (matchedTerms[+id] || []).some(t => t.type === 'fuzzy')
        }))
        .filter(r => r.doc)
        .sort((a, b) => b.score - a.score);

    const time = (performance.now() - t0).toFixed(1);
    return { results, time, correction: Object.keys(fuzzyMappings).length ? correction : null };
}

// Find all match positions in text for a list of raw terms
function findMatches(text, terms) {
    const exactTerms = terms.filter(t => t.type === 'exact').flatMap(t => [t.rawToken, stemMap[t.stemToken] || t.stemToken]).filter(Boolean);
    const fuzzyTerms = terms.filter(t => t.type === 'fuzzy').map(t => t.corrected || stemMap[t.stemToken]);
    const all = [...new Set([...exactTerms, ...fuzzyTerms])];
    const positions = [];
    all.forEach(term => {
        if (!term) return;
        const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\w*\\b`, 'gi');
        let m;
        while ((m = re.exec(text)) !== null)
            positions.push({
                start: m.index, end: m.index + m[0].length, word: m[0],
                type: fuzzyTerms.includes(term) ? 'fuzzy' : 'exact'
            });
    });
    return positions.sort((a, b) => a.start - b.start);
}

// ── SNIPPET ──
function buildSnippet(text, terms) {
    const positions = findMatches(text, terms);
    if (positions.length === 0) return text.slice(0, 180) + '…';
    const anchor = positions[0].start;
    const start = Math.max(0, anchor - 60);
    const end = Math.min(text.length, anchor + 200);
    let snippet = (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');

    // Rebuild with highlights (adjust offsets)
    const offset = start > 0 ? start - 1 : 0;
    let out = '', last = start > 0 ? 1 : 0;
    const snipText = start > 0 ? '…' + text.slice(start, end) : text.slice(0, end);

    // simpler: highlight in the snippet string
    let s = text.slice(start, end);
    const adjPositions = positions.map(p => ({ ...p, start: p.start - start, end: p.end - start }))
        .filter(p => p.start >= 0 && p.end <= s.length);
    let result = '', cursor = 0;
    adjPositions.forEach(p => {
        if (p.start < cursor) return;
        result += escHtml(s.slice(cursor, p.start));
        const cls = p.type === 'fuzzy' ? 'fuzzy-hl' : '';
        result += cls ? `<span class="${cls}">${escHtml(p.word)}</span>` : `<mark>${escHtml(p.word)}</mark>`;
        cursor = p.end;
    });
    result += escHtml(s.slice(cursor));
    return (start > 0 ? '…' : '') + result + (end < text.length ? '…' : '');
}

function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── RENDER RESULTS ──
function renderResults(query, { results, time, correction }) {
    lastQuery = query;
    lastResults = results;

    document.getElementById('sQueryTime').textContent = time + 'ms';
    document.getElementById('sResultCount').textContent = results.length;

    const meta = document.getElementById('resultsMeta');
    meta.textContent = `About ${results.length} result${results.length !== 1 ? 's' : ''} (${time} ms)`;

    const banner = document.getElementById('correctionBanner');
    if (correction) {
        banner.style.display = 'inline-flex';
        document.getElementById('correctionWord').textContent = correction;
    } else {
        banner.style.display = 'none';
    }

    if (results.length === 0) {
        document.getElementById('resultsList').innerHTML = `
      <div class="no-results">
        <div style="font-size:48px;margin-bottom:12px">🔍</div>
        <h2>No results for "<strong>${escHtml(query)}</strong>"</h2>
        <p style="margin-top:6px;font-size:14px;">Try a different keyword, check spelling, or upload more documents.</p>
      </div>`;
        return;
    }

    document.getElementById('resultsList').innerHTML = results.map((r, i) => {
        const matchPositions = findMatches(r.doc.text, r.terms);
        const matchCount = matchPositions.length;
        return `
    <div class="result-card" style="animation-delay:${i * 0.04}s">
      <div class="result-url-row">
        <div class="result-favicon">📄</div>
        <span class="result-url">${escHtml(r.doc.name)}</span>
      </div>
      <div class="result-title" onclick="openDocViewer(${r.doc.id}, '${escHtml(query)}')">
        ${escHtml(r.doc.name.replace(/\.[^.]+$/, ''))}
      </div>
      <div class="result-badges">
        ${i === 0 ? '<span class="badge-sm badge-top">⭐ Top result</span>' : ''}
        ${r.isFuzzy ? '<span class="badge-sm badge-fuzzy">~ Fuzzy match</span>' : '<span class="badge-sm badge-exact">✓ Exact match</span>'}
      </div>
      <div class="result-score-row">
        <div class="score-track"><div class="score-fill" style="width:${r.pct}%"></div></div>
        <span class="score-pct">TF-IDF ${r.score.toFixed(4)} · ${r.pct}% relevance</span>
      </div>
      <div class="result-snippet">${buildSnippet(r.doc.text, r.terms)}</div>
      ${matchCount > 0 ? `
      <div class="match-navigator" data-docid="${r.doc.id}">
        <span style="font-size:13px">📍</span>
        <span class="match-count" id="mc-${r.doc.id}">1 of ${matchCount} matches</span>
        <button class="match-nav-btn" onclick="navigateMatch(${r.doc.id},-1,${matchCount})" id="mprev-${r.doc.id}" disabled>↑</button>
        <button class="match-nav-btn" onclick="navigateMatch(${r.doc.id},1,${matchCount})" id="mnext-${r.doc.id}" ${matchCount <= 1 ? 'disabled' : ''}>↓</button>
        <span style="color:var(--text-dim);font-size:12px">·</span>
        <span style="font-size:12px;color:var(--accent);cursor:pointer" onclick="openDocViewer(${r.doc.id},'${escHtml(query)}')">View all →</span>
      </div>` : ''}
    </div>`;
    }).join('');

    // init match counters per card
    results.forEach(r => { matchCursors[r.doc.id] = 0; });
}

// ── MATCH NAVIGATION (inline cards) ──
const matchCursors = {};
function navigateMatch(docId, dir, total) {
    matchCursors[docId] = Math.max(0, Math.min((matchCursors[docId] || 0) + dir, total - 1));
    const cur = matchCursors[docId] + 1;
    document.getElementById(`mc-${docId}`).textContent = `${cur} of ${total} matches`;
    document.getElementById(`mprev-${docId}`).disabled = cur === 1;
    document.getElementById(`mnext-${docId}`).disabled = cur === total;
}

// ── DOCUMENT VIEWER ──
let viewerMatches = [];
let viewerMatchIdx = 0;

function openDocViewer(docId, query) {
    const doc = documents.find(d => d.id === docId);
    if (!doc) return;
    const result = lastResults.find(r => r.doc.id === docId);
    const terms = result?.terms || [];

    // Build line-by-line view
    const lines = doc.text.split('\n');
    const allMatches = findMatches(doc.text, terms);

    // Map matches to lines
    let charCount = 0;
    const lineMatchMap = {};
    lines.forEach((line, li) => {
        const lineStart = charCount;
        const lineEnd = charCount + line.length;
        allMatches.forEach((m, mi) => {
            if (m.start >= lineStart && m.start < lineEnd) {
                if (!lineMatchMap[li]) lineMatchMap[li] = [];
                lineMatchMap[li].push({ ...m, localStart: m.start - lineStart, localEnd: m.end - lineStart, matchIndex: mi });
            }
        });
        charCount += line.length + 1;
    });

    viewerMatches = Object.keys(lineMatchMap).map(Number);
    viewerMatchIdx = 0;

    document.getElementById('viewerTitle').textContent = doc.name;
    document.getElementById('viewerMatchInfo').textContent =
        viewerMatches.length ? `${viewerMatchIdx + 1} of ${allMatches.length} matches` : 'No matches';

    document.getElementById('viewerPrev').disabled = true;
    document.getElementById('viewerNext').disabled = viewerMatches.length <= 1;

    const body = document.getElementById('viewerBody');
    body.innerHTML = lines.map((line, li) => {
        const matchesOnLine = lineMatchMap[li] || [];
        const hasMatch = matchesOnLine.length > 0;
        let lineHtml = escHtml(line);

        // Apply highlights (reverse order to preserve positions)
        const sorted = [...matchesOnLine].reverse();
        let rawLine = line;
        sorted.forEach(m => {
            const before = rawLine.slice(0, m.localStart);
            const word = rawLine.slice(m.localStart, m.localEnd);
            const after = rawLine.slice(m.localEnd);
            const cls = m.type === 'fuzzy' ? 'fuzzy-hl' : '';
            rawLine = escHtml(before) + (cls ? `<span class="${cls}">${escHtml(word)}</span>` : `<mark>${escHtml(word)}</mark>`) + escHtml(after);
            lineHtml = rawLine;
        });
        if (matchesOnLine.some(m => escHtml)) {
            // already replaced, use rawLine result
        }

        const isFirst = viewerMatches[0] === li;
        return `<div class="doc-line ${hasMatch ? 'has-match' : ''} ${isFirst ? 'active-match' : ''}" id="vline-${li}">
      <span class="line-num">${li + 1}</span>
      <span class="line-content">${lineHtml || '&nbsp;'}</span>
    </div>`;
    }).join('');

    document.getElementById('docViewerOverlay').classList.add('show');

    // Scroll to first match
    if (viewerMatches.length > 0) {
        setTimeout(() => scrollToViewerLine(viewerMatches[0]), 50);
    }
}

function scrollToViewerLine(lineIdx) {
    const el = document.getElementById(`vline-${lineIdx}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function navigateViewerMatch(dir) {
    const prev = viewerMatches[viewerMatchIdx];
    viewerMatchIdx = Math.max(0, Math.min(viewerMatchIdx + dir, viewerMatches.length - 1));

    // Update active class
    document.querySelectorAll('.doc-line.active-match').forEach(el => el.classList.remove('active-match'));
    const nextLine = viewerMatches[viewerMatchIdx];
    document.getElementById(`vline-${nextLine}`)?.classList.add('active-match');

    const allMatchCount = document.querySelectorAll('.doc-line.has-match').length;
    document.getElementById('viewerMatchInfo').textContent =
        `${viewerMatchIdx + 1} of ${viewerMatches.length} lines with matches`;
    document.getElementById('viewerPrev').disabled = viewerMatchIdx === 0;
    document.getElementById('viewerNext').disabled = viewerMatchIdx === viewerMatches.length - 1;

    scrollToViewerLine(nextLine);
}

function closeViewer(e) {
    if (!e || e.target === document.getElementById('docViewerOverlay')) {
        document.getElementById('docViewerOverlay').classList.remove('show');
    }
}

// ── SUGGESTIONS ──
function getSuggestions(q) {
    if (!q || q.length < 2) return [];
    const stemQ = stem(q.toLowerCase().trim());
    const exact = [], fuzzy = [];
    vocabulary.forEach(v => {
        if (v.startsWith(stemQ) && v !== stemQ) exact.push(stemMap[v] || v);
        else if (levenshtein(stemQ, v) <= 1) fuzzy.push(stemMap[v] || v);
    });
    // also suggest history
    const histSug = searchHistory.filter(h => h.toLowerCase().includes(q.toLowerCase())).slice(0, 2);
    return [...new Set([...histSug, ...exact.slice(0, 3), ...fuzzy.slice(0, 2)])].slice(0, 6);
}

function renderSuggestions(q, boxId) {
    const box = document.getElementById(boxId);
    const items = getSuggestions(q);
    if (!q || items.length === 0) { box.classList.remove('show'); return; }
    box.innerHTML = items.map((s, i) => `
    <div class="suggestion-item" onclick="selectSuggestion('${escHtml(s)}')">
      <span class="sug-icon">${searchHistory.includes(s) ? '🕐' : '🔍'}</span>
      <span>${escHtml(q)}<mark>${escHtml(s.slice(q.length))}</mark></span>
      <span class="sug-right">↵</span>
    </div>`).join('');
    box.classList.add('show');
}

function selectSuggestion(text) {
    document.getElementById('homeInput').value = text;
    document.getElementById('resultsInput').value = text;
    document.querySelectorAll('.suggestions-box').forEach(b => b.classList.remove('show'));
    triggerSearch(text);
}

// ── DEBOUNCE ──
function debounce(fn, ms) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
}

const debouncedSuggest = debounce((q, boxId) => renderSuggestions(q, boxId), 180);
const debouncedSearch = debounce((q) => {
    if (q.trim()) { goToResults(q); }
}, 320);

// ── SEARCH BAR ACTIVE STATE ──
function setupInput(inputId, barId, sugBoxId) {
    const input = document.getElementById(inputId);
    const bar = document.getElementById(barId);
    const clearBtn = document.getElementById(inputId === 'homeInput' ? 'homeClear' : 'resultsClear');

    input.addEventListener('focus', () => {
        bar.classList.remove('focused-solo');
        if (input.value) {
            bar.classList.add('is-active');
        } else {
            bar.classList.add('focused-solo');
        }
    });

    input.addEventListener('blur', () => {
        setTimeout(() => {
            bar.classList.remove('is-active', 'focused-solo');
            document.getElementById(sugBoxId).classList.remove('show');
        }, 150);
    });

    input.addEventListener('input', () => {
        const v = input.value;
        clearBtn.style.display = v ? 'flex' : 'none';

        if (v) {
            bar.classList.remove('focused-solo');
            bar.classList.add('is-active');
        } else {
            bar.classList.remove('is-active');
            bar.classList.add('focused-solo');
        }

        debouncedSuggest(v, sugBoxId);
        if (isResultsPage()) debouncedSearch(v);
    });

    clearBtn.addEventListener('click', () => {
        input.value = '';
        clearBtn.style.display = 'none';
        document.getElementById(sugBoxId).classList.remove('show');
        bar.classList.remove('is-active');
        input.focus();
    });

    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { triggerSearch(input.value); }
        if (e.key === 'Escape') {
            document.getElementById(sugBoxId).classList.remove('show');
            input.blur();
        }
    });
}

// ── NAVIGATION ──
function isResultsPage() {
    return document.getElementById('resultsPage').classList.contains('show');
}

function triggerSearch(query) {
    const q = query || document.getElementById(isResultsPage() ? 'resultsInput' : 'homeInput').value;
    if (q.trim()) goToResults(q.trim());
}

function goToResults(query) {
    document.getElementById('homePage').classList.add('hidden');
    document.getElementById('resultsPage').classList.add('show');

    document.getElementById('homeInput').value = query;
    document.getElementById('resultsInput').value = query;
    document.getElementById('resultsClear').style.display = 'flex';
    document.querySelectorAll('.suggestions-box').forEach(b => b.classList.remove('show'));

    // Add to history
    if (!searchHistory.includes(query)) {
        searchHistory.unshift(query);
        if (searchHistory.length > 8) searchHistory.pop();
        renderHistory();
    }

    const res = search(query);
    renderResults(query, res);
}

function goHome() {
    document.getElementById('homePage').classList.remove('hidden');
    document.getElementById('resultsPage').classList.remove('show');
    document.getElementById('homeInput').focus();
}

// ── HISTORY ──
function renderHistory() {
    const el = document.getElementById('historyList');
    if (searchHistory.length === 0) {
        el.innerHTML = '<div style="font-size:13px;color:var(--text-dim)">No searches yet</div>';
        return;
    }
    el.innerHTML = searchHistory.map((h, i) => `
    <div class="history-item" onclick="triggerSearch('${escHtml(h)}')">
      <span class="h-icon">🕐</span>
      <span>${escHtml(h)}</span>
      <span class="h-remove" onclick="event.stopPropagation();removeHistory(${i})">×</span>
    </div>`).join('');
}

function removeHistory(i) {
    searchHistory.splice(i, 1);
    renderHistory();
}

// ── STATS & INDEX VIEW ──
function updateStats() {
    document.getElementById('sDocCount').textContent = documents.length;
    document.getElementById('sVocabCount').textContent = vocabulary.size;
    document.getElementById('indexTermCount').textContent = vocabulary.size + ' terms';
}

function updateIndexView() {
    const body = document.getElementById('indexBody');
    const entries = Object.entries(invertedIndex).slice(0, 20);
    body.innerHTML = entries.map(([w, docs]) => `
    <div class="idx-row">
      <span class="idx-key">"${w}"</span>
      ${Object.entries(docs).map(([id, f]) => `<span class="idx-ref">doc:${id}×${f}</span>`).join('')}
    </div>`).join('');
}

// ── DOC CHIPS ──
function updateDocChips() {
    document.getElementById('docChips').innerHTML = documents.map(d => `
    <div class="doc-chip">
      <span class="dot"></span>${escHtml(d.name)}
      <span class="rm" onclick="removeDoc(${d.id})">×</span>
    </div>`).join('');
}

function removeDoc(id) {
    documents = documents.filter(d => d.id !== id);
    buildIndex();
    if (lastQuery) goToResults(lastQuery);
}

// ── FILE UPLOAD ──
function handleFileInput(files) {
    Array.from(files).forEach(f => {
        const r = new FileReader();
        r.onload = ev => {
            documents.push({ id: Date.now() + Math.random(), name: f.name, text: ev.target.result });
            buildIndex();
        };
        r.readAsText(f);
    });
}

function setupDrop(zoneId) {
    const z = document.getElementById(zoneId);
    z.addEventListener('dragover', e => { e.preventDefault(); z.classList.add('drag-over'); });
    z.addEventListener('dragleave', () => z.classList.remove('drag-over'));
    z.addEventListener('drop', e => {
        e.preventDefault(); z.classList.remove('drag-over');
        handleFileInput(e.dataTransfer.files);
    });
    z.addEventListener('click', () => document.getElementById('fileInput').click());
}

// ── DOWNLOAD REPORT ──
function downloadReport() {
    if (!lastQuery) { alert('Run a search first.'); return; }
    const lines = [
        `NexSearch Report`,
        `Query: "${lastQuery}"`,
        `Date: ${new Date().toLocaleString()}`,
        `Results: ${lastResults.length}`,
        `Documents indexed: ${documents.length}`,
        `Vocabulary size: ${vocabulary.size}`,
        ``,
        `───── RESULTS ─────`,
        ...lastResults.map((r, i) => `
[${i + 1}] ${r.doc.name}
  Relevance: ${r.pct}% | TF-IDF: ${r.score.toFixed(6)}
  Match type: ${r.isFuzzy ? 'Fuzzy' : 'Exact'}
  Preview: ${r.doc.text.slice(0, 120).replace(/\n/g, ' ')}…
`)
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `nexsearch-${lastQuery.replace(/\s+/g, '-')}.txt`;
    a.click();
}

// ── SAMPLE DATA ──
function loadSampleData() {
    documents = [
        { id: 0, name: 'javascript-fundamentals.txt', text: `JavaScript is a prototype-based, multi-paradigm, single-threaded, dynamic language, supporting object-oriented, imperative, and declarative programming styles. Closures are one of the most powerful features of JavaScript. A closure gives you access to an outer function's scope from an inner function. In JavaScript, closures are created every time a function is created, at function creation time. The event loop is the secret behind JavaScript's asynchronous programming. JavaScript executes code, collects and processes events, and executes queued sub-tasks using the event loop. Prototype chains form the backbone of inheritance in JavaScript. Every JavaScript object has a prototype, and objects inherit properties from their prototypes. Functions in JavaScript are first-class objects — they can be stored in variables, passed as arguments, and returned from other functions.` },
        { id: 1, name: 'react-handbook.txt', text: `React is a free and open-source front-end JavaScript library for building user interfaces based on components. React was created by Jordan Walke, a software engineer at Meta. Components are the building blocks of any React application. A component is a self-contained module that renders some output. The useEffect hook lets you synchronize a component with an external system. React's virtual DOM efficiently updates only the components that changed rather than rerendering the entire page. State in React components determines how the component renders and behaves. The useState hook is the primary way to manage state in functional components. React's reconciliation algorithm compares the virtual DOM with the real DOM to make efficient updates.` },
        { id: 2, name: 'nodejs-internals.txt', text: `Node.js is a cross-platform, open-source JavaScript runtime environment that can run on Windows, Linux, Unix, macOS, and more. Node.js runs on the V8 JavaScript engine and executes JavaScript code outside a web browser. Libuv is a multi-platform support library with a focus on asynchronous I/O. Node.js uses libuv to handle its event loop, file system operations, DNS, network, child processes, pipes, signal handling, polling and streaming. The thread pool in Node.js is maintained by libuv and defaults to four threads. Worker threads in Node.js allow for parallel execution of JavaScript code. The event loop in Node.js has multiple phases: timers, pending callbacks, idle and prepare, poll, check, and close callbacks. Streams in Node.js are objects that allow reading or writing data in a continuous fashion.` },
        { id: 3, name: 'system-design-primer.txt', text: `System design is the process of defining the architecture, components, modules, interfaces, and data flow of a system to satisfy specified requirements. A load balancer distributes incoming network traffic across multiple servers to ensure no single server becomes overwhelmed. Horizontal scaling adds more machines to a system, while vertical scaling adds more resources to an existing machine. Caching stores frequently accessed data in fast storage to reduce latency and load on backend systems. A CDN or content delivery network delivers content to users from servers geographically closest to them. Database sharding divides a database into smaller chunks called shards, each stored on a separate server. Message queues allow asynchronous communication between services in a distributed system. Microservices architecture structures an application as a collection of small, independent services.` }
    ];
    buildIndex();
    document.getElementById('homeInput').focus();
}

// ── INIT ──
setupInput('homeInput', 'homeBar', 'homeSuggestions');
setupInput('resultsInput', 'resultsBar', 'resultsSuggestions');
setupDrop('sideDropZone');

document.getElementById('applyFix')?.addEventListener('click', () => {
    // already showing fuzzy results, click clears the banner
    document.getElementById('correctionBanner').style.display = 'none';
});

// Keyboard shortcut
document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        isResultsPage()
            ? document.getElementById('resultsInput').focus()
            : document.getElementById('homeInput').focus();
    }
});

renderHistory();
updateStats();
