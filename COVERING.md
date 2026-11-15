# Covering note

FINN is a mobile-first brief for one NSE portfolio. Push mode ranks the day's filings. Pull mode answers questions from annual reports and earnings-call transcripts, and keeps a Promise Ledger of what management guided against what was later filed.

The app is live at `https://enam.cflowx.in`. Open that address directly. There is no sign-in.

## A short path through it

Prices and filings are real NSE data. The last trading session loaded is Friday, 13 November 2026, so Today is quiet on a Sunday. Switch the window to **7d**.

- **Today.** Four filings sit in Act: Bajaj Finance's preferential issue, Maruti's results reference, and two HDFC Bank management items. Reason chips are written for a reader ("Preferential issue"), not as classifier codes. Noise is folded away.
- **Watch.** The same week produced three alerts under the default "Material filings" rule: the two HDFC Bank items and Maruti. Rules are plain English, and a rule can be previewed against the last 30 sessions before it is saved.
- **Holdings.** All 18 positions, with Friday's close, the day's move, and volume against the previous 20 sessions.
- **Ask → PAGEIND.** Research is already built: two annual reports and eight calls. The Promise Ledger reads **3 of 4** promises delivered whose deadline has passed (one missed, three still open, six not scored). Asking "What operating margin did management guide for FY25?" returns a grounded answer citing the Q3 FY25 call, page 5, and the FY25 annual report, page 13.
- **Ask → CDSL.** Eight calls were read. Management gave no quantified target in the tracked set (revenue growth, margins, profit growth, capex, order book, volumes, net debt), and the ledger says so instead of showing an empty score.
- **Engine** (the mark at the top right). The two pipelines, today's model cost, source health, and what was deliberately not built. On the first day of the demo the meter showed 73 model calls, 97% valid JSON, 3,824 indexed passages and 49 documents, with 1,933 calls left in the daily budget.

Research for ASTRAL, PAGEIND, DEEPAKNTR, CDSL and TITAN is pre-built. Any other NSE ticker can be researched from Ask; progress streams live and survives a refresh.

## How the numbers are produced

Classification, scoring, clustering, alerts and results cards are deterministic. Results cards are parsed from exchange XBRL, not written by the model. The model is used only where language has to be read: the filings the rules cannot place, card one-liners, guidance extraction and research drafts. Every research claim must quote a passage that actually contains the quote, and every number must appear in a cited passage or in the computed figures. A claim that fails that check is shown as not grounded.

**EBITDA (computed)** = profit before exceptional items and tax + finance costs + depreciation and amortisation − other income. Exceptional items are excluded. Banks and NBFCs show net interest income, pre-provision operating profit and profit after tax instead.

The Promise Ledger reports a fraction with its denominator. It does not produce a credibility score.

## Sources, and the terms-of-service trade-off

NSE's announcement and archive endpoints are public and undocumented. FINN polls them a few times an hour through one allow-listed client, and a failing source is shown on Engine rather than hidden. Prices come from NSE's official daily bhavcopy; Yahoo is only a fallback. screener.in is used to find annual-report and transcript PDFs (the files themselves are fetched from BSE and NSE) and for its standardised multi-year history. Claims cite filing pages. The research snapshot and the ledger's "what was filed" figures use that screener history, and every such figure is labelled.

## Deliberately left out

Intraday prices, news and broker notes, a composite credibility score, OCR for scanned PDFs (they are flagged), multi-user accounts, and the BSE announcements feed. Web Push works in Chrome and, on iOS, only after the site is added to the Home Screen.

One Astral filing that screener lists as a concall is an audio-recording notice, not a transcript. It is marked failed and excluded from the ledger.

## Repository

https://github.com/Sudarshan50/enam-assignment

Architecture, the local run, the EC2 runbook and the scoring rules are in `README.md`. `git log` is the code history. The AI build history (the Cursor agent sessions and their subagents, with secrets redacted) is attached to the submission email.
