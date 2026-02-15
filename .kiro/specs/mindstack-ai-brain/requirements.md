# Requirements Document

## Introduction

MindStack is a passive knowledge retrieval system designed to solve "Developer Amnesia" and "Learner Decay" by acting as an AI-powered second brain. The system captures code snippets, documentation, and learning content, indexes them using vector embeddings, and provides intelligent retrieval through a conversational interface. The core philosophy is "Capture once, Recall instantly" targeting software developers as the primary audience and students/researchers as secondary users.

## Glossary

- **MindStack**: The complete AI-powered second brain application system
- **Neural Vault**: The ingestion engine component responsible for capturing and processing unstructured data
- **Oracle**: The RAG (Retrieval Augmented Generation) search and chat component
- **Memory**: A stored knowledge item containing content, metadata, and vector embeddings
- **Vector Database**: The storage system for semantic embeddings enabling similarity search
- **RAG Pipeline**: The process of retrieving relevant memories and generating contextual responses
- **Ingest Simulator**: A development interface for testing data ingestion functionality
- **Memory Feed**: The dashboard display showing recent captured memories

## Requirements

### Requirement 1

**User Story:** As a software developer, I want to capture code snippets with contextual information, so that I can retrieve solutions to similar problems later.

#### Acceptance Criteria

1. WHEN a user submits a code snippet through the ingestion interface, THE MindStack SHALL store the code with file path, programming language, and timestamp metadata
2. WHEN a user includes error logs with code snippets, THE MindStack SHALL associate the error information with the code memory for contextual retrieval
3. WHEN code is ingested, THE MindStack SHALL generate vector embeddings for semantic search capabilities
4. WHEN storing code memories, THE MindStack SHALL validate the programming language and assign appropriate tags
5. WHEN code ingestion completes, THE MindStack SHALL confirm successful storage and display the memory in the feed

### Requirement 2

**User Story:** As a learner, I want to capture web content and video summaries, so that I can build a searchable knowledge base of my learning materials.

#### Acceptance Criteria

1. WHEN a user submits a URL for web content ingestion, THE MindStack SHALL extract the page title and generate an AI summary of the content
2. WHEN processing video URLs, THE MindStack SHALL create transcript summaries and store them as searchable memories
3. WHEN web content is processed, THE MindStack SHALL preserve the source URL and timestamp for reference
4. WHEN content ingestion fails, THE MindStack SHALL provide clear error messages and maintain system stability
5. WHEN web memories are created, THE MindStack SHALL automatically generate relevant tags based on content analysis

### Requirement 3

**User Story:** As a user, I want to manually add quick notes and thoughts, so that I can capture spontaneous insights and clipboard content.

#### Acceptance Criteria

1. WHEN a user accesses the quick note interface, THE MindStack SHALL provide a text input field for manual entry
2. WHEN a user submits manual content, THE MindStack SHALL process it as a note-type memory with appropriate metadata
3. WHEN clipboard content is pasted, THE MindStack SHALL detect and preserve formatting where applicable
4. WHEN manual entries are saved, THE MindStack SHALL generate embeddings for semantic search integration
5. WHEN quick notes are created, THE MindStack SHALL allow users to add custom tags for organization

### Requirement 4

**User Story:** As a user, I want to ask natural language questions about my stored knowledge, so that I can retrieve relevant information without remembering exact keywords.

#### Acceptance Criteria

1. WHEN a user submits a natural language query, THE MindStack SHALL convert the query to vector representation for semantic matching
2. WHEN processing queries, THE MindStack SHALL retrieve the top 3 most semantically similar memories from the vector database
3. WHEN relevant memories are found, THE MindStack SHALL feed them as context to the LLM for response generation
4. WHEN generating responses, THE MindStack SHALL cite specific dates, sources, and file paths from the retrieved memories
5. WHEN no relevant memories are found, THE MindStack SHALL inform the user and suggest alternative search approaches

### Requirement 5

**User Story:** As a user, I want to see my recent memories in a visual dashboard, so that I can browse and rediscover my captured knowledge.

#### Acceptance Criteria

1. WHEN a user accesses the dashboard, THE MindStack SHALL display memories in a masonry-style grid layout
2. WHEN displaying memory cards, THE MindStack SHALL show content snippets, source information, and timestamps
3. WHEN memories are rendered, THE MindStack SHALL apply the cyberpunk aesthetic with dark mode and neon accents
4. WHEN users interact with memory cards, THE MindStack SHALL provide smooth animations and visual feedback
5. WHEN the memory feed loads, THE MindStack SHALL prioritize recent memories while maintaining responsive performance

### Requirement 6

**User Story:** As a user, I want a persistent chat interface, so that I can continuously interact with my knowledge base while browsing memories.

#### Acceptance Criteria

1. WHEN the application loads, THE MindStack SHALL display a chat sidebar on the right side of the interface
2. WHEN users type in the chat interface, THE MindStack SHALL process queries through the RAG pipeline
3. WHEN chat responses are generated, THE MindStack SHALL maintain conversation history for context
4. WHEN multiple queries are made, THE MindStack SHALL preserve chat state across user sessions
5. WHEN chat interactions occur, THE MindStack SHALL provide typing indicators and loading states for user feedback

### Requirement 7

**User Story:** As a developer testing the system, I want an ingestion simulator interface, so that I can test the data capture functionality without building external integrations.

#### Acceptance Criteria

1. WHEN accessing the dev tools simulator at route `/devtools` or via sidebar toggle, THE MindStack SHALL provide input fields for URLs and code snippets
2. WHEN test data is submitted through the simulator, THE MindStack SHALL process it through the same ingestion pipeline as production data
3. WHEN using the simulator, THE MindStack SHALL display real-time feedback on ingestion status and results
4. WHEN testing different content types, THE MindStack SHALL handle code snippets, URLs, and manual text appropriately
5. WHEN ingestion completes via simulator, THE MindStack SHALL show the processed memory in the main dashboard

### Requirement 8

**User Story:** As a user, I want the system to work reliably even without cloud AI services, so that I can use the application in various environments.

#### Acceptance Criteria

1. WHEN AWS credentials are not available, THE MindStack SHALL detect the absence and switch to mock mode
2. WHEN operating in mock mode, THE MindStack SHALL return realistic dummy responses that demonstrate system functionality
3. WHEN fallback mode is active, THE MindStack SHALL clearly indicate to users that responses are simulated
4. WHEN cloud services are restored, THE MindStack SHALL automatically resume normal AI-powered operations
5. WHEN switching between modes, THE MindStack SHALL maintain data integrity and user experience continuity

### Requirement 9

**User Story:** As a user, I want my memories to be stored with consistent structure, so that the system can reliably process and retrieve my knowledge.

#### Acceptance Criteria

1. WHEN storing any memory type, THE MindStack SHALL validate data against the defined JSON schema with required fields
2. WHEN generating memory IDs, THE MindStack SHALL use UUID-v4 format for unique identification
3. WHEN processing content, THE MindStack SHALL correctly categorize memories as code, video, or article types
4. WHEN creating embeddings, THE MindStack SHALL store vector arrays with consistent dimensionality
5. WHEN saving metadata, THE MindStack SHALL include ISO-8601 timestamps and appropriate source URLs

### Requirement 10

**User Story:** As a user, I want fast and accurate semantic search, so that I can quickly find relevant information from my knowledge base.

#### Acceptance Criteria

1. WHEN performing vector similarity search, THE MindStack SHALL use cosine similarity or equivalent semantic matching
2. WHEN processing search queries, THE MindStack SHALL return results ranked by relevance score
3. WHEN the vector database grows large, THE MindStack SHALL maintain sub-second query response times
4. WHEN similar memories exist, THE MindStack SHALL prioritize more recent entries when relevance scores are equal
5. WHEN search operations complete, THE MindStack SHALL provide confidence scores for retrieved memories

### Requirement 11

**User Story:** As a presenter, I want the system to initialize with pre-loaded data, so that I can demonstrate the search and chat features immediately without manual entry.

#### Acceptance Criteria

1. WHEN the backend starts, THE MindStack SHALL check for a seed_data.json file in the data directory
2. IF the database is empty, THE MindStack SHALL automatically ingest 5 specific memories: Python web scraping code, React useEffect explanation, System Design video summary, CORS error bug fix, and hackathon submission guidelines note
3. WHEN seed data is loaded, THE MindStack SHALL generate appropriate embeddings and metadata for each memory
4. WHEN the Memory Feed loads for the first time, THE MindStack SHALL display these 5 seeded items immediately
5. WHEN demo data exists, THE MindStack SHALL allow normal ingestion operations to add additional memories

### Requirement 12

**User Story:** As a developer, I need specific technologies used to ensure rapid development and compatibility.

#### Acceptance Criteria

1. WHEN building the frontend, THE MindStack SHALL use Next.js 14 with App Router architecture and Tailwind CSS for styling
2. WHEN implementing the backend, THE MindStack SHALL use Python FastAPI framework with appropriate routing structure
3. WHEN storing vector data, THE MindStack SHALL use local JSON file or in-memory array as mock vector database to remove cloud dependencies
4. WHEN rendering UI components, THE MindStack SHALL use Lucide React for icons and Framer Motion for cyberpunk entrance animations
5. WHEN the application starts, THE MindStack SHALL initialize all specified technologies and provide fallback modes for missing dependencies