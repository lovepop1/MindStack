from api.index import get_transcript

# Test start and end bounding functionality
res = get_transcript('dQw4w9WgXcQ', 45, 50)
print("Transcript Slice test:", res)
