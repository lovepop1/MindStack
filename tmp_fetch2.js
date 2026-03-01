async function test() {
    const yta = await import("youtube-transcript-api");
    const TranscriptClient = yta.default;
    const client = new TranscriptClient();
    try {
        await client.ready;
        const res = await client.getTranscript("2ZSBsWZIeQI");
        console.log("Fetched pieces:", res.transcript.length);
        console.log("First piece:", res.transcript[0]);
    } catch (e) {
        console.log(e);
    }
}
test();
