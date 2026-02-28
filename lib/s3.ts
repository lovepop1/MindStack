import {
    S3Client,
    PutObjectCommand,
    DeleteObjectCommand,
    GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "stream";

// ---------------------------------------------------------------------------
// Shared S3 client instance
// ---------------------------------------------------------------------------
const s3 = new S3Client({
    region: process.env.NEXT_PUBLIC_AWS_REGION!,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
});

const BUCKET = process.env.NEXT_PUBLIC_AWS_S3_BUCKET_NAME!;

// ---------------------------------------------------------------------------
// Generate a 15-minute PUT presigned URL.
// Returns { uploadUrl, s3Url } so the client can both upload and store the ref.
// ---------------------------------------------------------------------------
export async function getPutPresignedUrl(
    fileName: string,
    fileType: string
): Promise<{ uploadUrl: string; s3Url: string }> {
    // Namespace uploads under a timestamped prefix to avoid collisions
    const key = `uploads/${Date.now()}-${fileName}`;

    const command = new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        ContentType: fileType,
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 900 });
    const s3Url = `https://${BUCKET}.s3.${process.env.NEXT_PUBLIC_AWS_REGION}.amazonaws.com/${key}`;

    return { uploadUrl, s3Url };
}

// ---------------------------------------------------------------------------
// Delete an S3 object given its full HTTPS URL.
// Parses the key from the URL to avoid storing separate key values.
// ---------------------------------------------------------------------------
export async function deleteS3Object(s3Url: string): Promise<void> {
    try {
        const url = new URL(s3Url);
        // For path-style: host is s3.region.amazonaws.com, pathname starts with /bucket/key
        // For virtual-hosted style: host is bucket.s3.region.amazonaws.com, pathname is /key
        let key: string;
        if (url.hostname.startsWith(`${BUCKET}.`)) {
            // Virtual-hosted style
            key = url.pathname.slice(1); // strip leading /
        } else {
            // Path-style: /bucket-name/key
            const parts = url.pathname.split("/");
            key = parts.slice(2).join("/");
        }

        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
    } catch (err) {
        console.error("[S3] Failed to delete object:", s3Url, err);
        // Non-fatal — caller decides whether to continue
        throw err;
    }
}

// ---------------------------------------------------------------------------
// Fetch an S3 object and return it as a Base64 string with its MIME type.
// Used to inject images into the Claude multimodal payload.
// ---------------------------------------------------------------------------
export async function fetchImageAsBase64(
    s3Url: string
): Promise<{ base64: string; mimeType: string }> {
    const url = new URL(s3Url);
    let key: string;
    if (url.hostname.startsWith(`${BUCKET}.`)) {
        key = url.pathname.slice(1);
    } else {
        const parts = url.pathname.split("/");
        key = parts.slice(2).join("/");
    }

    const response = await s3.send(
        new GetObjectCommand({ Bucket: BUCKET, Key: key })
    );

    if (!response.Body) {
        throw new Error(`[S3] Empty body for key: ${key}`);
    }

    // Collect stream chunks into a Buffer
    const chunks: Uint8Array[] = [];
    const stream = response.Body as Readable;
    for await (const chunk of stream) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const buffer = Buffer.concat(chunks);
    const base64 = buffer.toString("base64");

    // Infer MIME type from Content-Type header or key extension
    const contentType = response.ContentType ?? inferMimeType(key);

    return { base64, mimeType: contentType };
}

// ---------------------------------------------------------------------------
// Minimal MIME type inference by file extension as a fallback
// ---------------------------------------------------------------------------
function inferMimeType(key: string): string {
    const ext = key.split(".").pop()?.toLowerCase();
    const map: Record<string, string> = {
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        png: "image/png",
        gif: "image/gif",
        webp: "image/webp",
        pdf: "application/pdf",
    };
    return map[ext ?? ""] ?? "application/octet-stream";
}
