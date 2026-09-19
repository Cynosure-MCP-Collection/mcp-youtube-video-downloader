import { Defuddle } from 'defuddle/node';
import { parseHTML } from 'linkedom';

const PAGE_FETCH_TIMEOUT_MS = 15_000;
const MAX_PAGE_SIZE_BYTES = 5 * 1024 * 1024;
const USER_AGENT = 'Mozilla/5.0 (compatible; VideoDownloaderMCP/1.0; +https://github.com/Cynosure-MCP-Collection/mcp-youtube-video-downloader)';

export interface YoutubeTranscript {
    title: string;
    transcript: string;
    language?: string;
}

export function validateYoutubeVideoUrl(value: string): URL {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error('Invalid URL. Provide a full YouTube video URL.');
    }

    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new Error('Invalid YouTube URL. Only HTTP and HTTPS URLs are supported.');
    }

    const hostname = url.hostname.toLowerCase();
    const isYoutube = hostname === 'youtube.com' || hostname.endsWith('.youtube.com');
    const isShortUrl = hostname === 'youtu.be';
    if (!isYoutube && !isShortUrl) {
        throw new Error('Invalid YouTube URL. The URL must use youtube.com or youtu.be.');
    }

    const videoId = isShortUrl
        ? url.pathname.split('/').filter(Boolean)[0]
        : url.pathname.includes('/shorts/')
            ? url.pathname.split('/shorts/')[1]?.split('/')[0]
            : url.searchParams.get('v');

    if (!videoId) {
        throw new Error('Invalid YouTube video URL. Expected a watch, Shorts, or youtu.be link.');
    }

    return url;
}

async function fetchYoutubePage(url: URL, language?: string): Promise<string> {
    const headers: Record<string, string> = { 'User-Agent': USER_AGENT };
    if (language) headers['Accept-Language'] = language;

    const response = await fetch(url, {
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(PAGE_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
        throw new Error(`YouTube returned HTTP ${response.status}.`);
    }

    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_PAGE_SIZE_BYTES) {
        throw new Error('The YouTube page is too large to process.');
    }

    const html = await response.text();
    if (Buffer.byteLength(html, 'utf8') > MAX_PAGE_SIZE_BYTES) {
        throw new Error('The YouTube page is too large to process.');
    }
    return html;
}

export async function extractYoutubeTranscript(value: string, language?: string): Promise<YoutubeTranscript> {
    const url = validateYoutubeVideoUrl(value);
    const html = await fetchYoutubePage(url, language);
    const { document } = parseHTML(html);
    const result = await Defuddle(document, url.href, {
        language,
        useAsync: true,
        fetch,
    });
    const transcript = result.variables?.transcript?.trim();

    if (!transcript) {
        throw new Error('No transcript is available for this YouTube video.');
    }

    return {
        title: result.title?.trim() || 'YouTube video',
        transcript,
        language: result.variables?.language || result.language || undefined,
    };
}
