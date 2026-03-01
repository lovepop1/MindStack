from fastapi import FastAPI, HTTPException
from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api._errors import NoTranscriptFound, TranscriptsDisabled

app = FastAPI()

@app.get("/transcript")
def get_transcript(v: str):
    if not v:
        raise HTTPException(status_code=400, detail="Missing video ID 'v'")
    
    try:
        # Fetch the transcript (defaults to English)
        transcript_list = YouTubeTranscriptApi.list(v)
        transcript_data = transcript_list.find_transcript(['en', 'en-US']).fetch()
        
        # Combine all text segments into one string
        full_text = " ".join([segment["text"] for segment in transcript_data])
        
        return {"transcript": full_text}
    except NoTranscriptFound:
        raise HTTPException(status_code=404, detail="No transcript found for this video in the requested language.")
    except TranscriptsDisabled:
        raise HTTPException(status_code=403, detail="Transcripts are disabled for this video.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
