from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from youtube_transcript_api import YouTubeTranscriptApi

app = FastAPI(title="MindStack Transcript Service")

# Allow requests from the Next.js frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def read_root():
    return {"status": "ok", "message": "MindStack Python Microservice is running"}

@app.get("/api/transcript")
def get_transcript(v: str = None):
    if not v:
        return JSONResponse(status_code=400, content={"error": "Missing video ID"})
        
    try:
        transcript_list = YouTubeTranscriptApi.list_transcripts(v)
        transcript = transcript_list.find_transcript(['en', 'en-US', 'en-GB', 'hi'])
        data = transcript.fetch()
        full_text = " ".join([segment["text"] for segment in data])
        return {"transcript": full_text}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})
