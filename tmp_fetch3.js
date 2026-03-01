const { getSubtitles } = require('youtube-captions-scraper');

getSubtitles({
    videoID: '2ZSBsWZIeQI',
    lang: 'en'
}).then(captions => {
    console.log("Success! Fetched", captions.length, "segments. First segment:", captions[0].text);
}).catch(err => {
    console.error("Failed:", err.message);
});
