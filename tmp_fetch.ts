import https from "https";
import axios from "axios";

export async function fetchYoutubeTranscript(videoId: string) {
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    // Fetch the raw HTML using axios
    const response = await axios.get(videoUrl, {
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept-Language": "en-US,en;q=0.9",
        }
    });
    const html = response.data;

    // Safe regex to extract the ytInitialPlayerResponse JSON
    const match = html.match(/ytInitialPlayerResponse\s*=\s*({.+?})\s*;\s*(?:var\s+meta|<\/script|\n)/);
    if (!match || !match[1]) {
        throw new Error("Could not find ytInitialPlayerResponse in the page source.");
    }

    let playerData;
    try {
        playerData = JSON.parse(match[1]);
    } catch (err) {
        throw new Error("Failed to parse ytInitialPlayerResponse JSON.");
    }

    const captionsData = playerData?.captions;
    if (!captionsData) {
        throw new Error("No captions found (captions object missing).");
    }

    const captionTracks = captionsData?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!captionTracks || !captionTracks.length) {
        throw new Error("No caption tracks available.");
    }

    // Prefer English, but fallback to whatever the first track is
    const preferredTrack =
        captionTracks.find((t: any) => t.languageCode.includes("en")) ||
        captionTracks.find((t: any) => t.languageCode.includes("hi")) ||
        captionTracks[0];

    const transcriptUrl = preferredTrack.baseUrl + "&fmt=json3";
    console.log("Fetching URL:", transcriptUrl);

    // Fetch the transcript JSON text using axios
    const transcriptTextRaw = await axios.get(transcriptUrl, {
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept-Language": "en-US,en;q=0.9",
        }
    }).then(res => res.data);
    // Since axios parses JSON automatically if the response is JSON, check if it's already an object
    const transcriptRes = typeof transcriptTextRaw === "string" ? JSON.parse(transcriptTextRaw) : transcriptTextRaw;

    console.log("Raw Response Snippet:", JSON.stringify(transcriptTextRaw).substring(0, 200));


    const pieces = [];
    if (transcriptRes.events) {
        for (const event of transcriptRes.events) {
            if (event.segs) {
                const text = event.segs.map((seg: any) => seg.utf8).join("");
                if (text.trim() || text === "\n") {
                    pieces.push({
                        start: event.tMs / 1000,
                        duration: (event.dDurationMs || 0) / 1000,
                        text: text.replace(/\n/g, " "),
                    });
                }
            }
        }
    }

    return pieces;
}

// Quick manual test
fetchYoutubeTranscript("2ZSBsWZIeQI")
    .then(res => console.log("Success! Fetched", res.length, "segments. First segment:", res[0]?.text))
    .catch(err => console.error("Failed:", err.message));
