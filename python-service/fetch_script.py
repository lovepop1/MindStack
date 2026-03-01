from youtube_transcript_api import YouTubeTranscriptApi
import sys
import json

def get_transcript(video_id):
    try:
        transcript_list = YouTubeTranscriptApi.list_transcripts(video_id)
        transcript = transcript_list.find_transcript(['en', 'en-US', 'en-GB', 'hi'])
        data = transcript.fetch()
        full_text = " ".join([segment["text"] for segment in data])
        print(json.dumps({"transcript": full_text}))
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) > 1:
        get_transcript(sys.argv[1])
    else:
        print("Provide a video ID")
        sys.exit(1)
