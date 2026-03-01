import {
    TranscribeClient,
    StartTranscriptionJobCommand,
    GetTranscriptionJobCommand,
    TranscriptionJobStatus,
} from "@aws-sdk/client-transcribe";

const transcribeClient = new TranscribeClient({
    region: process.env.NEXT_PUBLIC_AWS_REGION!,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
});

/**
 * Starts an AWS Transcribe job for an audio file stored in S3.
 * Returns the transcribed text string.
 */
export async function transcribeAudio(s3Url: string): Promise<string> {
    const jobName = `MindStack-Audio-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

    // Convert https://bucket.s3.region.amazonaws.com/key to s3://bucket/key format required by Transcribe
    const bucket = process.env.NEXT_PUBLIC_AWS_S3_BUCKET_NAME!;
    const parsedUrl = new URL(s3Url);

    let key: string;
    if (parsedUrl.hostname.startsWith(`${bucket}.`)) {
        key = parsedUrl.pathname.slice(1);
    } else {
        key = parsedUrl.pathname.split("/").slice(2).join("/");
    }
    const mediaUri = `s3://${bucket}/${key}`;

    try {
        await transcribeClient.send(
            new StartTranscriptionJobCommand({
                TranscriptionJobName: jobName,
                LanguageCode: "en-US",
                MediaFormat: "webm",
                Media: { MediaFileUri: mediaUri },
                IdentifyMultipleLanguages: false,
            })
        );

        // Poll for completion (timeout after 2 mins to prevent hanging the async pipeline indefinitely)
        const startTime = Date.now();
        const timeoutMs = 120 * 1000;

        while (Date.now() - startTime < timeoutMs) {
            const { TranscriptionJob } = await transcribeClient.send(
                new GetTranscriptionJobCommand({ TranscriptionJobName: jobName })
            );

            if (TranscriptionJob?.TranscriptionJobStatus === TranscriptionJobStatus.COMPLETED) {
                // Fetch the transcript JSON from the signed URL AWS provides
                const transcriptUri = TranscriptionJob.Transcript?.TranscriptFileUri;
                if (!transcriptUri) throw new Error("Job completed but no TranscriptFileUri returned.");

                const res = await fetch(transcriptUri);
                if (!res.ok) throw new Error(`Failed to download transcript JSON: ${res.status}`);

                const data = await res.json() as { results?: { transcripts?: { transcript?: string }[] } };
                const finalTranscript = data.results?.transcripts?.[0]?.transcript ?? "";

                return finalTranscript.trim();
            } else if (TranscriptionJob?.TranscriptionJobStatus === TranscriptionJobStatus.FAILED) {
                throw new Error(`AWS Transcribe Job Failed: ${TranscriptionJob.FailureReason}`);
            }

            // Wait 2.5 seconds before polling again
            await new Promise((resolve) => setTimeout(resolve, 2500));
        }

        throw new Error("Transcription job timed out after 2 minutes.");
    } catch (err) {
        console.error(`[Transcribe] Failed to transcribe ${s3Url}:`, err);
        throw err;
    }
}
