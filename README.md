# Lunch Uncle

Lunch Uncle is a chatbot that tells you where to eat lunch near CT Hub 2, Lavender, Singapore. Uncle speaks casual Singaporean English, and he has strong opinions about where you should go.

## Architecture

Lunch Uncle runs as a single Cloudflare Worker. `src/index.js` routes requests: `GET /` serves the chat page from `src/ui.html`, and `POST /chat` goes to `src/chat.js`, which rate-limits and checks the request, then hands the turn to the agentic loop in `src/loop.js`. The loop calls an OpenAI-compatible chat completions endpoint, passing the tool definitions from `src/tools.js`. When the model asks for tool calls, the loop runs them, appends the results to the message list, and calls the model again. This repeats until the model gives a final answer with no more tool calls, for at most 8 rounds. `src/prompt.js` builds the system prompt that sets Uncle's persona and rules, and stamps each user message with the Singapore time. There are three tools: `find_lunch_places`, which queries the Google Places API (New) Text Search, restricted to the area around CT Hub 2; `get_rain_forecast`, which reads the two-hour forecast from data.gov.sg (no key needed); and `get_bus_arrivals`, which reads live arrivals from arrivelah (no key needed).

## Request flow

```mermaid
sequenceDiagram
    participant Browser
    participant Worker
    participant LLM
    participant Tools as Tools (Places / data.gov.sg / arrivelah)

    Browser->>Worker: POST /chat {message, history, session}
    Worker->>LLM: chat completion + tool definitions
    loop Until final answer
        LLM-->>Worker: tool calls
        Worker->>Tools: run requested tools
        Tools-->>Worker: tool results
        Worker->>LLM: chat completion + tool results
    end
    LLM-->>Worker: final reply
    Worker-->>Browser: {reply}
```

## Setup

1. Clone this repository.
2. Install dependencies:
   ```sh
   npm install
   ```
3. Create `.env` from `.env.example` and fill in your keys:
   ```sh
   cp .env.example .env
   ```
   ```
   OPENCODE_API_KEY=your-key-here
   GOOGLE_PLACES_API_KEY=your-key-here
   ```
   If a `.dev.vars` file also exists, wrangler reads that instead and ignores `.env`.
4. Fill in the two `TODO` constants at the top of `src/loop.js`: `LLM_BASE_URL` and `LLM_MODEL`, for the OpenCode Go endpoint and model. The Go endpoint requires an `x-opencode-session` header, which `callModel` already sends.
5. Start the dev server:
   ```sh
   npm run dev
   ```
   Open http://localhost:8787 and chat with Uncle.
6. To deploy, set the secrets on Cloudflare first, then deploy:
   ```sh
   npx wrangler secret put OPENCODE_API_KEY
   npx wrangler secret put GOOGLE_PLACES_API_KEY
   npm run deploy
   ```
   `wrangler.toml` limits each client IP to 30 chats a minute. Workers in one Cloudflare account that use the same `namespace_id` share that limiter, so give your Worker its own number in the `[[ratelimits]]` block.

Secrets never go in code or in `wrangler.toml`. Local development reads them from `.env`, which is gitignored; production reads them from Cloudflare secrets set with `wrangler secret put`.

## Running tests

```sh
npm test
```

This runs Node's built-in test runner. There are no test dependencies to install.

## Course key setup

For facilitators setting up a shared Google Places key for a course run:

1. In Google Cloud Console, create a new project for the course.
2. Enable **Places API (New)** only. Do not enable the legacy Places API.
3. Create an API key under APIs & Services → Credentials.
4. Under key restrictions, choose "Restrict key" and tick only Places API (New).
5. Go to APIs & Services → Places API (New) → Quotas, and cap requests per day to a modest number, such as 1,000.
6. In Billing → Budgets & alerts, create a budget with email alerts at 50% and 100%.

Treat the LLM key the same way: one key per course run, revoked once the course ends.

## Licence

MIT.
