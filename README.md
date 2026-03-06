# MindStack

MindStack is an advanced multi-surface AI ingestion engine and multimodal query hub built to automatically track, index, and query a developer's learning journey and project progression. It relies on a hyper-optimized Retrieval-Augmented Generation (RAG) pipeline to seamlessly digest data from browser extensions, IDE plugins, and document uploads.

---


## ⚡ Tech Stack

- **Framework:** Next.js 14 (App Router), React 18
- **Database:** Supabase (PostgreSQL with `pgvector` for vector embeddings)
- **Object Storage:** Amazon S3 (for media blobs, PDFs, and video keyframes)
- **AI / LLMs:** Amazon Bedrock
  - **Claude 3 Haiku:** Asynchronous plain-English translation of massive IDE terminal splats and code diffs.
  - **Amazon Titan Embeddings V2:** High-dimensional (1024-dim) semantic vector generation of chunked resources.
  - **Claude 3.7 Sonnet:** The multimodal, highly-intelligent chat engine capable of rendering text, images, and synthesizing context files via an active Server-Sent Events (SSE) stream.
- **Language:** TypeScript
- **Styling:** Tailwind CSS

---

## 🚀 Performance & Architecture Benchmarks

This backend is aggressively engineered around non-blocking asynchronous edge boundaries and intelligent payload chunking.

- **Ingestion Latency:** `< 200ms` for background web-text / IDE captures (completely non-blocking to the user's UI). The `/api/ingest/*` endpoints use a "fire-and-forget" Promise architecture to immediately free up the client connection while Claude Haiku and Titan process the text in the background.
- **S3 Upload Efficiency:** Direct-to-AWS Presigned URLs bypass server payload limits, allowing massive PDF and media uploads directly from the client in seconds. 
- **Query Response Time:** `< 1.5s` Time-to-First-Token (TTFT) via optimized Server-Sent Events (SSE) streaming combined with Node.js `ReadableStreams`.
- **Context Management:** Successfully filters and parses up to `50k` characters per IDE progress snapshot via automated Git tree truncating to prevent token overflow.

---


## 📦 Ingestion Workflows

MindStack supports three primary ingestion pipelines:

### 1. Browser Extension (`POST /api/ingest/browser`)
Automatically ingests web articles, YouTube video segments, and general web context. Supports `VIDEO_SEGMENT` and `WEB_TEXT` capture types. If a video keyframe is present, it is mapped securely via S3 and indexed functionally inside the vector DB.

### 2. IDE Plugin (`POST /api/ingest/ide`)
Accepts strictly scoped payloads from a local code-editor extension:
- `IDE_PROGRESS_SNAPSHOT`: Takes the exact code diff (`ide_code_diff`) and file tree (`repo_tree`), chunks them, translates the code changes to plain English via Haiku, and embeds both the code and the translation into Titan.
- `IDE_BUG_FIX`: Ingests raw terminal failures (`ide_error_log`), processes the stack traces via Haiku into a "Key Learning" explanation, and indexes it so the developer can ask the chat engine about historical errors.

### 3. Document Processing (`POST /api/ingest/process-document`)
For massive file inputs (e.g. PDFs). A client uploads the PDF securely to S3 via a presigned URL. The backend fetches the raw byte buffer from S3, parses the native text via `pdf-parse`, chunks the content aggressively, and creates embedded vectors tied strictly to an isolated `project_id`.

### 4. YouTube Transcript Microservice (`python-service/`)
Due to strict Vercel routing rules and YouTube's advanced bot-protection against Node.js HTTPS engines, MindStack delegates YouTube transcription to a standalone Python FastAPI microservice.
This service is fully isolated to prevent Next.js `app/api/` routing conflicts and guarantees reliable, bypass-capable transcript extraction.
**[Youtube Transcript Repository](https://github.com/lovepop1/MindStack-Transcripter)**

---

## 💻 Getting Started (Local Development)

### 1. Environment Variables
Create a `.env.local` file at the root of the project. You will need:
- Supabase Project URL, Anon Key, and Service Role Key (Required for database & JWT auth).
- AWS Credentials (Access Key & Secret Key) with permissions for S3 (`PutObject`, `GetObject`) and Bedrock (`InvokeModel`, `InvokeModelWithResponseStream`).
- AWS Region & S3 Bucket Name.
- `PYTHON_API_URL`: The URL of your independently deployed Python Microservice (e.g. `https://mindstack-python-scraper.vercel.app`).

*(Ensure the Supabase schema includes the `captures` and `capture_chunks` tables with the `project_id` foreign key relations fully intact).*

### 2. Install Dependencies
```bash
npm install
```

### 3. Run the Development Server
```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

### 4. Deploying the Python Microservice 
To deploy the Python extraction layer:
1. Create a **New Project** in Vercel.
2. Link the repository but explicitly set the **Root Directory** to `python-service`.
3. Deploy this project. It will automatically build as a Serverless Python app.
4. Add the resulting URL as `PYTHON_API_URL` in the environment variables of your **originating Next.js project**.

### 5. Build for Production
To ensure all dynamic APIs and static pages are optimized:
```bash
npm run build
npm run start
```

---

## 🛠️ Data Safety & Privacy
- **Project Isolation:** The backend `match_captures` PostgreSQL function strictly enforces `project_id` equality. You cannot leak vector embeddings or text chunks from Project A into Project B.
- **Payload Sanitization:** No `env` files or hardcoded secrets are permitted into the vector context window. 
- **Strict Hallucination Fallbacks:** If a RAG search returns zero associated documents for a project, the API intercepts the array and forces Claude to exit early, providing a hardcoded `### No Progress Data Available` zero-state markdown block to entirely prevent AI hallucination.
