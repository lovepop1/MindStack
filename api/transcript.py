from http.server import BaseHTTPRequestHandler
import json
from youtube_transcript_api import YouTubeTranscriptApi
from urllib.parse import urlparse, parse_qs

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        query_components = parse_qs(urlparse(self.path).query)
        v = query_components.get("v", [None])[0]
        
        self.send_response(200)
        self.send_header('Content-type', 'application/json')
        self.end_headers()
        
        if not v:
            self.wfile.write(json.dumps({"error": "Missing video ID"}).encode('utf-8'))
            return
            
        try:
            transcript_list = YouTubeTranscriptApi.list_transcripts(v)
            transcript = transcript_list.find_transcript(['en', 'en-US', 'en-GB', 'hi'])
            data = transcript.fetch()
            full_text = " ".join([segment["text"] for segment in data])
            self.wfile.write(json.dumps({"transcript": full_text}).encode('utf-8'))
        except Exception as e:
            self.wfile.write(json.dumps({"error": str(e)}).encode('utf-8'))
        return
