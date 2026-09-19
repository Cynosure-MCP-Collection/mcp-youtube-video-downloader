#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { YtDlp } from 'ytdlp-nodejs';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { promisify } from 'node:util';
import { extractYoutubeTranscript } from './youtube-transcript.js';

const require = createRequire(import.meta.url);
const ffmpegBin: string | null = require('ffmpeg-static');
const ffprobeBin: string = require('ffprobe-static').path;

/**
 * yt-dlp's --ffmpeg-location expects a directory containing both ffmpeg and ffprobe.
 * We create a temp dir with symlinks to the npm-bundled binaries.
 */
function setupFfmpegDir(): string | undefined {
    if (!ffmpegBin) return undefined;
    const dir = path.join(tmpdir(), 'oa-ffmpeg-bin');
    fs.mkdirSync(dir, { recursive: true });
    const ffmpegLink = path.join(dir, 'ffmpeg');
    const ffprobeLink = path.join(dir, 'ffprobe');
    try { fs.unlinkSync(ffmpegLink); } catch { }
    try { fs.unlinkSync(ffprobeLink); } catch { }
    fs.symlinkSync(ffmpegBin, ffmpegLink);
    if (ffprobeBin) fs.symlinkSync(ffprobeBin, ffprobeLink);
    return dir;
}

const ffmpegDir = setupFfmpegDir();

// ── Types ──────────────────────────────────────────────────────────────────────

const AUDIO_FORMATS = ['mp3', 'flac', 'wav', 'aac', 'm4a', 'opus', 'vorbis', 'alac'] as const;
const VIDEO_FORMATS = ['mp4', 'webm', 'mkv', 'ogg', 'flv'] as const;
const ALL_FORMATS = [...VIDEO_FORMATS, ...AUDIO_FORMATS] as const;

type AudioFormat = (typeof AUDIO_FORMATS)[number];

interface DownloadState {
    id: string;
    url: string;
    format: string;
    quality: string;
    status: 'queued' | 'downloading' | 'complete' | 'error';
    progress: string;
    filePaths: string[];
    error?: string;
    startedAt: number;
    completedAt?: number;
}

// ── Download tracker ───────────────────────────────────────────────────────────

const downloads = new Map<string, DownloadState>();
const ytdlp = new YtDlp(ffmpegDir ? { ffmpegPath: ffmpegDir } : undefined);
const execFileAsync = promisify(execFile);
let updateInProgress: Promise<void> | undefined;

function shouldRefreshYtDlp(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return /\b403\b|forbidden|unable to extract|signature extraction|nsig/i.test(message);
}

async function refreshYtDlp(): Promise<void> {
    if (!updateInProgress) {
        updateInProgress = execFileAsync(ytdlp.binaryPath, ['--update'], {
            timeout: 120_000,
            maxBuffer: 2 * 1024 * 1024,
        }).then(() => undefined).finally(() => {
            updateInProgress = undefined;
        });
    }
    return updateInProgress;
}

async function withYtDlpRefresh<T>(operation: () => Promise<T>): Promise<T> {
    try {
        return await operation();
    } catch (err) {
        if (!shouldRefreshYtDlp(err)) throw err;
        console.error(`yt-dlp failed with a likely stale-extractor error; updating and retrying once: ${(err as Error).message}`);
        await refreshYtDlp();
        return operation();
    }
}

function isAudioFormat(fmt: string): fmt is AudioFormat {
    return (AUDIO_FORMATS as readonly string[]).includes(fmt);
}

function generateId(): string {
    // Simple short ID — 8 chars
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let id = '';
    for (let i = 0; i < 8; i++) {
        id += chars[Math.floor(Math.random() * chars.length)];
    }
    return id;
}

// ── MCP Server ─────────────────────────────────────────────────────────────────

const server = new McpServer({
    name: 'Video Downloader',
    version: '1.0.0',
    title: 'Video Downloader',
    description: 'Download videos with yt-dlp and extract YouTube transcripts with Defuddle.',
    icons: [{ src: 'https://unpkg.com/@cynosure-mcp/youtube-video-downloader@1.0.4/icon.png', mimeType: 'image/png' }],
});

// Tool: get_video_info
server.registerTool(
    'get_video_info',
    {
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        description: 'Get metadata about a video (title, duration, available formats, thumbnail) without downloading it. Supports YouTube, Vimeo, and many other sites via yt-dlp.',
        inputSchema: z.object({
            url: z.string().describe('Video URL (YouTube, Vimeo, or any yt-dlp supported site)'),
        }),
    },
    async ({ url }) => {
        try {
            const info = await withYtDlpRefresh(() => ytdlp.getInfoAsync(url)) as Record<string, any>;
            const desc = info.description as string | undefined;
            const summary = [
                `Title: ${info.title}`,
                `Channel: ${info.channel || info.uploader || 'Unknown'}`,
                `Duration: ${info.duration_string || `${info.duration}s`}`,
                `View count: ${info.view_count?.toLocaleString() ?? 'N/A'}`,
                `Upload date: ${info.upload_date || 'N/A'}`,
                `Description: ${desc ? desc.slice(0, 300) + (desc.length > 300 ? '...' : '') : 'N/A'}`,
            ];

            return {
                content: [{ type: 'text', text: summary.join('\n') }],
            };
        } catch (err) {
            return {
                content: [{ type: 'text', text: `Error fetching video info: ${(err as Error).message}` }],
                isError: true,
            };
        }
    }
);

// Tool: youtube_to_text
server.registerTool(
    'youtube_to_text',
    {
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        description: 'Extract the timestamped transcript from a YouTube video using Defuddle. Returns chapter headings when available.',
        inputSchema: z.object({
            url: z.string().describe('YouTube watch, Shorts, or youtu.be video URL'),
            language: z
                .string()
                .optional()
                .describe('Preferred transcript language as a BCP 47 tag, such as en, de, or pt-BR'),
        }),
    },
    async ({ url, language }) => {
        try {
            const result = await extractYoutubeTranscript(url, language);
            const languageLine = result.language ? `\nLanguage: ${result.language}` : '';
            return {
                content: [{
                    type: 'text',
                    text: `Title: ${result.title}${languageLine}\n\n${result.transcript}`,
                }],
            };
        } catch (err) {
            return {
                content: [{ type: 'text', text: `Error extracting YouTube transcript: ${(err as Error).message}` }],
                isError: true,
            };
        }
    }
);

// Tool: download_video
server.registerTool(
    'download_video',
    {
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        description: 'Download a video or extract its audio. Supports YouTube, Vimeo, and many other sites via yt-dlp. Returns a download ID for progress tracking. Video formats: mp4, webm, mkv. Audio formats: mp3, flac, wav, aac, m4a, opus.',
        inputSchema: z.object({
            url: z.string().describe('Video URL (YouTube, Vimeo, or any yt-dlp supported site)'),
            format: z
                .enum(ALL_FORMATS)
                .default('mp4')
                .describe('Output format (video: mp4, webm, mkv; audio: mp3, flac, wav, aac, m4a, opus)'),
            quality: z
                .enum(['best', '2160p', '1440p', '1080p', '720p', '480p', '360p', '240p', '144p'])
                .default('best')
                .describe('Video quality (ignored for audio-only formats). Default: best'),
            outputDir: z
                .string()
                .optional()
                .describe('Output directory (default: ~/Downloads)'),
        }),
    },
    async ({ url, format, quality, outputDir }) => {
        const id = generateId();
        const outDir = outputDir || path.join(homedir(), 'Downloads');

        // Fetch video info to determine expected filename
        let expectedFilename = '';
        try {
            const info = await withYtDlpRefresh(() => ytdlp.getInfoAsync(url)) as Record<string, any>;
            const title = info.title || '';
            expectedFilename = title ? `${title}.${format}` : '';

        } catch { }

        const state: DownloadState = {
            id,
            url,
            format,
            quality,
            status: 'queued',
            progress: '0%',
            filePaths: [],
            startedAt: Date.now(),
        };
        downloads.set(id, state);

        // Start download in background (non-blocking)
        (async () => {
            try {
                state.status = 'downloading';

                if (isAudioFormat(format)) {
                    // Audio download
                    const result = await withYtDlpRefresh(() => ytdlp
                        .download(url)
                        .extractAudio()
                        .audioFormat(format)
                        .output(outDir)
                        .on('progress', (p) => {
                            state.progress = p.percentage_str || `${p.percentage ?? 0}%`;
                        })
                        .run());

                    state.filePaths = result.filePaths || [];
                } else {
                    // Video download
                    const height = quality === 'best' ? undefined : Number.parseInt(quality, 10);
                    const formatSelector = height
                        ? `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]`
                        : 'bestvideo+bestaudio/best';
                    const result = await withYtDlpRefresh(() => ytdlp
                        .download(url)
                        .format(formatSelector)
                        .addOption('mergeOutputFormat', format)
                        .output(outDir)
                        .on('progress', (p) => {
                            state.progress = p.percentage_str || `${p.percentage ?? 0}%`;
                        })
                        .run());

                    state.filePaths = result.filePaths || [];
                }

                state.status = 'complete';
                state.progress = '100%';
                state.completedAt = Date.now();
            } catch (err) {
                state.status = 'error';
                state.error = (err as Error).message;
                state.completedAt = Date.now();
            }
        })();

        const filenameLines = expectedFilename ? `\nExpected Filename: ${expectedFilename}` : '';

        return {
            content: [
                {
                    type: 'text',
                    text: `Download started!\n\nDownload ID: ${id}\nFormat: ${format}\nQuality: ${quality}\nOutput: ${outDir}${filenameLines}\n\nUse check_download_progress with ID "${id}" to monitor progress.`,
                },
            ],
        };
    }
);

// Tool: check_download_progress
server.registerTool(
    'check_download_progress',
    {
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description: 'Check the progress of an ongoing or completed download.',
        inputSchema: z.object({
            downloadId: z.string().describe('The download ID returned by download_video'),
        }),
    },
    async ({ downloadId }) => {
        const state = downloads.get(downloadId);
        if (!state) {
            // List active downloads if ID not found
            if (downloads.size === 0) {
                return {
                    content: [{ type: 'text', text: 'No downloads found. Start one with download_video.' }],
                    isError: true,
                };
            }
            const ids = Array.from(downloads.keys()).join(', ');
            return {
                content: [
                    {
                        type: 'text',
                        text: `Download "${downloadId}" not found. Active download IDs: ${ids}`,
                    },
                ],
                isError: true,
            };
        }

        const elapsed = ((state.completedAt || Date.now()) - state.startedAt) / 1000;
        const lines = [
            `Download ID: ${state.id}`,
            `URL: ${state.url}`,
            `Format: ${state.format} | Quality: ${state.quality}`,
            `Status: ${state.status}`,
            `Progress: ${state.progress}`,
            `Elapsed: ${elapsed.toFixed(1)}s`,
        ];

        if (state.status === 'complete') {
            lines.push(`Files: ${state.filePaths.join(', ') || '(unknown)'}`);
        }
        if (state.status === 'error') {
            lines.push(`Error: ${state.error}`);
        }

        return {
            content: [{ type: 'text', text: lines.join('\n') }],
        };
    }
);

// Tool: list_downloads
server.registerTool(
    'list_downloads',
    {
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description: 'List all current and recent downloads with their status.',
    },
    async () => {
        if (downloads.size === 0) {
            return {
                content: [{ type: 'text', text: 'No downloads yet. Start one with download_video.' }],
            };
        }

        const lines = Array.from(downloads.values()).map((d) => {
            const elapsed = ((d.completedAt || Date.now()) - d.startedAt) / 1000;
            return `• [${d.id}] ${d.status} — ${d.format} ${d.quality} — ${d.progress} (${elapsed.toFixed(1)}s)\n  ${d.url}`;
        });

        return {
            content: [{ type: 'text', text: `Downloads (${downloads.size}):\n\n${lines.join('\n\n')}` }],
        };
    }
);

// ── Start ──────────────────────────────────────────────────────────────────────

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Video Downloader MCP server running on stdio');
}

main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
