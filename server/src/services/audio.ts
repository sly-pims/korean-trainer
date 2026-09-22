import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export function mimeToExt(mime: string | undefined): string {
  switch ((mime ?? '').split(';')[0].trim()) {
    case 'audio/webm':
    case 'video/webm':
      return 'webm';
    case 'audio/ogg':
    case 'audio/opus':
      return 'ogg';
    case 'audio/mp4':
    case 'audio/x-m4a':
    case 'audio/aac':
      return 'm4a';
    case 'audio/mpeg':
      return 'mp3';
    case 'audio/wav':
    case 'audio/x-wav':
      return 'wav';
    default:
      return 'bin';
  }
}

/** Verify ffmpeg is available (exit code 0). Throws if not. */
export async function checkFfmpeg(ffmpegPath: string): Promise<void> {
  await execFileP(ffmpegPath, ['-version']);
}

/**
 * Convert an arbitrary recording buffer to 16 kHz mono 16-bit PCM WAV
 * (the format sent to the Gemini audio endpoint). Browsers record
 * WebM/Opus or MP4/AAC, so we go through ffmpeg.
 */
export async function convertToWav16k(
  input: Buffer,
  ext: string,
  ffmpegPath: string,
): Promise<Buffer> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-audio-'));
  const inPath = path.join(tmpDir, `in.${ext}`);
  const outPath = path.join(tmpDir, 'out.wav');
  try {
    fs.writeFileSync(inPath, input);
    await execFileP(ffmpegPath, [
      '-y',
      '-i',
      inPath,
      '-ac',
      '1',
      '-ar',
      '16000',
      '-sample_fmt',
      's16',
      '-f',
      'wav',
      outPath,
    ]);
    return fs.readFileSync(outPath);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}