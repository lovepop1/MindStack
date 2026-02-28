// ---------------------------------------------------------------------------
// Smart text chunker for MindStack ingestion pipeline.
//
// Strategy:
//  - Split on double newlines (paragraphs) first for natural boundaries.
//  - Accumulate paragraphs into chunks until MAX_WORDS is reached.
//  - If a single paragraph exceeds MAX_WORDS, split it by sentence.
//  - Auto-generated / lock files are detected by size + name pattern and
//    returned as an empty array so they are never embedded.
// ---------------------------------------------------------------------------

const MAX_WORDS = 500;

// File patterns that are auto-generated and should never be embedded
const IGNORE_PATTERNS = [
    /package-lock\.json$/i,
    /yarn\.lock$/i,
    /pnpm-lock\.yaml$/i,
    /composer\.lock$/i,
    /Gemfile\.lock$/i,
    /\.min\.js$/i,
    /\.min\.css$/i,
];

// If text exceeds this byte length AND matches an ignore pattern, skip it
const IGNORE_SIZE_THRESHOLD = 50_000;

export interface ChunkOptions {
    /** Filename hint used to detect auto-generated files */
    fileName?: string;
    /** Override words-per-chunk limit */
    maxWords?: number;
}

/**
 * Split `text` into semantically coherent chunks of ~maxWords words each.
 * Returns an empty array if the text is identified as an auto-generated file.
 */
export function chunkText(text: string, options: ChunkOptions = {}): string[] {
    const { fileName, maxWords = MAX_WORDS } = options;

    if (!text || text.trim().length === 0) return [];

    // Guard: skip massive auto-generated files
    if (fileName && text.length > IGNORE_SIZE_THRESHOLD) {
        if (IGNORE_PATTERNS.some((p) => p.test(fileName))) {
            console.log(`[Chunker] Skipping auto-generated file: ${fileName}`);
            return [];
        }
    }

    const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

    const chunks: string[] = [];
    let current: string[] = [];
    let wordCount = 0;

    for (const paragraph of paragraphs) {
        const paraWords = countWords(paragraph);

        if (paraWords > maxWords) {
            // Flush whatever we have accumulated first
            if (current.length > 0) {
                chunks.push(current.join("\n\n"));
                current = [];
                wordCount = 0;
            }
            // Then split the oversized paragraph by sentence
            const sentences = splitBySentence(paragraph);
            let sentenceBuf: string[] = [];
            let sentenceWordCount = 0;

            for (const sentence of sentences) {
                const sw = countWords(sentence);
                if (sentenceWordCount + sw > maxWords && sentenceBuf.length > 0) {
                    chunks.push(sentenceBuf.join(" "));
                    sentenceBuf = [];
                    sentenceWordCount = 0;
                }
                sentenceBuf.push(sentence);
                sentenceWordCount += sw;
            }
            if (sentenceBuf.length > 0) {
                chunks.push(sentenceBuf.join(" "));
            }
        } else if (wordCount + paraWords > maxWords) {
            // Current chunk is full — flush and start a new one
            chunks.push(current.join("\n\n"));
            current = [paragraph];
            wordCount = paraWords;
        } else {
            current.push(paragraph);
            wordCount += paraWords;
        }
    }

    if (current.length > 0) {
        chunks.push(current.join("\n\n"));
    }

    return chunks.filter((c) => c.trim().length > 0);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countWords(text: string): number {
    return text.trim().split(/\s+/).filter(Boolean).length;
}

function splitBySentence(text: string): string[] {
    // Split on period/exclamation/question followed by whitespace or end-of-string
    return text
        .split(/(?<=[.!?])\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
}
