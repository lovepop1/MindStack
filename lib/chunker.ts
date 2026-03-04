// ---------------------------------------------------------------------------
// Smart text chunker for MindStack ingestion pipeline.
//
// Strategy:
//  - Split on double newlines (paragraphs) first for natural boundaries.
//  - Accumulate into chunks until MAX_WORDS or MAX_CHARS is reached.
//  - If a single block is too big, split it by SINGLE newlines (lines of code).
//  - If a single line is STILL too big, forcefully slice it by character limit.
// ---------------------------------------------------------------------------

const MAX_WORDS = 500;
const MAX_CHARS = 20000; // ~5,000 tokens. Safely below AWS Titan's 8192 limit.

const IGNORE_PATTERNS = [
    /package-lock\.json$/i,
    /yarn\.lock$/i,
    /pnpm-lock\.yaml$/i,
    /composer\.lock$/i,
    /Gemfile\.lock$/i,
    /\.min\.js$/i,
    /\.min\.css$/i,
];

const IGNORE_SIZE_THRESHOLD = 50_000;

export interface ChunkOptions {
    fileName?: string;
    maxWords?: number;
    maxChars?: number;
}

export function chunkText(text: string, options: ChunkOptions = {}): string[] {
    const { fileName, maxWords = MAX_WORDS, maxChars = MAX_CHARS } = options;

    if (!text || text.trim().length === 0) return [];

    // Guard: skip massive auto-generated files
    if (fileName && text.length > IGNORE_SIZE_THRESHOLD) {
        if (IGNORE_PATTERNS.some((p) => p.test(fileName))) {
            console.log(`[Chunker] Skipping auto-generated file: ${fileName}`);
            return [];
        }
    }

    // 1. Initial split by double newlines (paragraphs/code blocks)
    const blocks = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    const chunks: string[] = [];

    let currentChunkBuf: string[] = [];
    let currentWordCount = 0;
    let currentCharCount = 0;

    function flush() {
        if (currentChunkBuf.length > 0) {
            chunks.push(currentChunkBuf.join("\n\n"));
            currentChunkBuf = [];
            currentWordCount = 0;
            currentCharCount = 0;
        }
    }

    for (const block of blocks) {
        const blockWords = countWords(block);
        const blockChars = block.length;

        // If accumulating this block pushes us over the limits, flush first.
        if (currentChunkBuf.length > 0 && 
           (currentWordCount + blockWords > maxWords || currentCharCount + blockChars > maxChars)) {
            flush();
        }

        // If the block ITSELF is still too big, we must break it down further
        if (blockWords > maxWords || blockChars > maxChars) {
            // Split by single newlines (perfect for code and git diffs)
            const lines = block.split('\n');
            
            for (const line of lines) {
                const lineWords = countWords(line);
                const lineChars = line.length;

                // If a SINGLE line is massively oversized (e.g. minified code), slice it brutally
                if (lineChars > maxChars) {
                    flush(); // Empty whatever we have
                    let remainingLine = line;
                    while (remainingLine.length > 0) {
                        const slice = remainingLine.substring(0, maxChars);
                        chunks.push(slice);
                        remainingLine = remainingLine.substring(maxChars);
                    }
                } else {
                    // Normal line accumulation
                    if (currentChunkBuf.length > 0 && 
                       (currentWordCount + lineWords > maxWords || currentCharCount + lineChars > maxChars)) {
                        flush();
                    }
                    currentChunkBuf.push(line);
                    currentWordCount += lineWords;
                    currentCharCount += lineChars;
                }
            }
            flush(); // Flush the remainder of the split block
        } else {
            // It fits perfectly, accumulate it
            currentChunkBuf.push(block);
            currentWordCount += blockWords;
            currentCharCount += blockChars;
        }
    }

    flush(); // Final flush

    return chunks.filter((c) => c.trim().length > 0);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countWords(text: string): number {
    return text.trim().split(/\s+/).filter(Boolean).length;
}