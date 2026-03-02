import youtube_transcript_api

try:
    print('Testing direct list method on initialized object...')
    api_instance = youtube_transcript_api.YouTubeTranscriptApi()
    res = api_instance.list('dQw4w9WgXcQ')
    print('Success:', res.__class__.__name__)
except Exception as e:
    print('Failed direct list:', str(e))
