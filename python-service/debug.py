import youtube_transcript_api
import sys

print("Methods on YouTubeTranscriptApi:", [n for n in dir(youtube_transcript_api.YouTubeTranscriptApi) if not n.startswith("_")])

try:
    print('Testing list_transcripts...')
    res = youtube_transcript_api.YouTubeTranscriptApi.list_transcripts('dQw4w9WgXcQ')
    print('Success:', res.__class__.__name__)
except Exception as e:
    print('Failed list_transcripts:', str(e))

try:
    print('Testing list...')
    res = youtube_transcript_api.YouTubeTranscriptApi.list('dQw4w9WgXcQ')
    print('Success:', res.__class__.__name__)
except Exception as e:
    print('Failed list:', str(e))

try:
    print('Testing get_transcript...')
    res = youtube_transcript_api.YouTubeTranscriptApi.get_transcript('dQw4w9WgXcQ')
    print('Success get_transcript:', len(res))
except Exception as e:
    print('Failed get_transcript:', str(e))
