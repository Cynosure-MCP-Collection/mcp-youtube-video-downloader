# @cynosure-mcp/youtube-video-downloader

MCP server for downloading videos from YouTube, Vimeo, and other sites using yt-dlp with progress tracking, plus Defuddle-based YouTube transcript extraction.

## Installation

```bash
npx @cynosure-mcp/youtube-video-downloader
```

Or install globally:

```bash
npm install -g @cynosure-mcp/youtube-video-downloader
youtube-video-downloader
```

### Prerequisites

Requires [yt-dlp](https://github.com/yt-dlp/yt-dlp) installed and available on your PATH.

## Tools

| Tool                    | Description                                                                      |
| ----------------------- | -------------------------------------------------------------------------------- |
| `get_video_info`        | Get video metadata (title, duration, formats, thumbnail) without downloading     |
| `youtube_to_text`       | Extract a timestamped YouTube transcript, optionally in a preferred language     |
| `download_video`        | Download a video or extract audio with progress tracking (returns a download ID) |
| `get_download_progress` | Track download progress by ID                                                    |

### Supported Formats

| Type  | Formats                                      |
| ----- | -------------------------------------------- |
| Video | mp4, webm, mkv, ogg, flv                     |
| Audio | mp3, flac, wav, aac, m4a, opus, vorbis, alac |

## Configuration

No configuration required.

## MCP Config

```json
{
  "mcpServers": {
    "youtube-video-downloader": {
      "command": "npx",
      "args": ["@cynosure-mcp/youtube-video-downloader"]
    }
  }
}
```

## License

MIT
