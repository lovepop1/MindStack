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
def get_transcript(v: str = None, start: float = None, end: float = None):
    if not v:
        return JSONResponse(status_code=400, content={"error": "Missing video ID"})
        
    try:
        # Some versions/environments of youtube-transcript-api use different base methods
        full_text = ""
        
        try:
            # Try newer functional approach if available (common in pip 3.11+)
            from youtube_transcript_api import YouTubeTranscriptApi as yta
            if hasattr(yta, 'get_transcript'):
                data = yta.get_transcript(v, languages=['en', 'en-US', 'en-GB', 'hi'])
                filtered_segments = [s['text'] for s in data]
                if start is not None and end is not None:
                    buffered_start = max(0, start - 15)
                    buffered_end = end + 15
                    filtered_segments = [s['text'] for s in data if (s['start'] + s['duration']) >= buffered_start and s['start'] <= buffered_end]
                    if not filtered_segments:
                        filtered_segments = [s['text'] for s in data]
                return {"transcript": " ".join(filtered_segments)}
        except Exception as dynamic_err:
            pass # Fallback to Object-Oriented extraction
            
        # Object-Oriented extraction for versions like 0.6.x - 1.2.x
        ytt_api = YouTubeTranscriptApi()
        
        if hasattr(ytt_api, 'list'):
            transcript_list = ytt_api.list(v)
        elif hasattr(ytt_api, 'list_transcripts'):
            transcript_list = ytt_api.list_transcripts(v)
        else:
             return JSONResponse(status_code=500, content={"error": "Vercel environment installed an incompatible youtube-transcript-api version. Neither list() nor get_transcript() found."})
        
        try:
            # First try to find manual transcripts
            transcript = transcript_list.find_manually_created_transcript(['en', 'en-US', 'en-GB', 'hi'])
        except Exception:
            # Fallback to generated
            try:
                transcript = transcript_list.find_generated_transcript(['en', 'en-US', 'en-GB', 'hi'])
            except Exception:
                # Absolute fallback
                transcript = next(iter(transcript_list))
            
        data = transcript.fetch()
        
        # Slice transcript by start and end times if provided
        if start is not None and end is not None:
            # Add a 15-second buffer before and after for optimal context
            buffered_start = max(0, start - 15)
            buffered_end = end + 15
            
            filtered_segments = [
                segment.text for segment in data
                # Include segment if it overlaps with our buffered window
                if (segment.start + segment.duration) >= buffered_start and segment.start <= buffered_end
            ]
            full_text = " ".join(filtered_segments)
            if not full_text.strip():
                full_text = " ".join([segment.text for segment in data]) # Fallback to full if slice is empty
        else:
            full_text = " ".join([segment.text for segment in data])
            
        return {"transcript": full_text}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})
