# DavSearch

DavSearch is a lightweight, client-side search engine built with vanilla JavaScript. It lets you upload local text documents, build an inverted index in the browser, and search through them with fast exact matching and typo-tolerant fuzzy search.

## Features

- Upload local .txt or .md files directly in the browser
- Build and search an inverted index in real time
- Rank results using a simple TF-IDF-style scoring approach
- Support typo-tolerant search for small spelling mistakes
- Load sample data instantly for quick demos

## How it works

1. Upload one or more documents.
2. The app preprocesses the text and builds an index of terms.
3. Enter a query to search the indexed documents.
4. Results are ranked and highlighted based on relevance.

## How to run locally

1. Open the project folder in a browser, or serve it with a simple local server.
2. If you are using Python, run:
   ```bash
   python -m http.server 8000
   ```
3. Open http://localhost:8000 in your browser.

## Project structure

- index.html — main app layout and UI
- src/engine — indexing and search logic
- src/ui — UI rendering and upload handling
- src/styles — styling for the interface

## Notes

This project is designed as a portfolio-friendly demo, so all processing happens locally in the browser and no backend is required.
