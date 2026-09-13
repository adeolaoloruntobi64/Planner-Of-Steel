# Plan-Of-Steel — UofT Degree Planner

Automates UofT (UTSC) degree planning: give it a transcript, a program (or two),
and optional interests, and it builds a real semester-by-semester course plan using live-scraped calendar/prerequisite data and a deterministic scheduling
algorithm.

## Architecture

- **`backend/`**: Express + TypeScript API. Scrapes live UofT calendar/timetable
  pages via a [Steel.dev](https://steel.dev) cloud browser (driven over CDP with
  Playwright, no local browser install needed), parses prerequisite text into a
  dependency graph, and runs a deterministic scheduling algorithm to build plans.
  Claude (via the Anthropic API) is used only for the natural-language parts:
  reading transcripts, interpreting requirement prose, and ranking electives
  against stated interests.
- **`frontend/`**: Vite + React + TypeScript UI. Solo planning and "with
  friends" group planning, transcript input via pasted text, uploaded image, or
  a course picker.

## Prerequisites

- Node.js 20+ (developed on Node 24)
- A [Steel.dev](https://steel.dev) API key
- An [Anthropic](https://console.anthropic.com) API key

## Setup

1. Install dependencies for both apps:

   ```bash
   cd backend && npm install
   cd ../frontend && npm install
   ```

2. Create `backend/.env` with:

   ```bash
   STEEL_API_KEY=your_steel_api_key
   ANTHROPIC_API_KEY=your_anthropic_api_key
   MODEL_NAME=claude-haiku-4-5  # optional, this is the default if unset
   PORT=3000                    # optional, defaults to 3000
   ```

## Running it

Start the backend and frontend in separate terminals:

```bash
# Terminal 1 — API server (http://localhost:3000)
cd backend
npm run dev

# Terminal 2 — web app (http://localhost:5173, proxies /api to the backend)
cd frontend
npm run dev
```

Then open the URL Vite prints (typically http://localhost:5173).