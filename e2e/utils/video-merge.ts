import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { promises as fs } from 'fs';

export interface MergeOptions {
  videoA: string;
  videoB: string;
  output: string;
  layout?: 'horizontal' | 'vertical';
  scale?: { width: number; height: number };
}

/**
 * Merge two videos side-by-side using FFmpeg.
 * Returns the path to the merged video.
 */
export async function mergeVideos(opts: MergeOptions): Promise<string> {
  const { videoA, videoB, output, layout = 'horizontal', scale } = opts;
  
  // Ensure output directory exists
  await fs.mkdir(dirname(output), { recursive: true });
  
  // Build FFmpeg filter
  const stackFilter = layout === 'horizontal' ? 'hstack=inputs=2' : 'vstack=inputs=2';
  const scaleFilter = scale ? `,scale=${scale.width}:${scale.height}:force_original_aspect_ratio=decrease,pad=${scale.width}:${scale.height}:(ow-iw)/2:(oh-ih)/2` : '';
  const filterComplex = `[0:v][1:v]${stackFilter}${scaleFilter}[out]`;
  
  const args = [
    '-i', videoA,
    '-i', videoB,
    '-filter_complex', filterComplex,
    '-map', '[out]',
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '23',
    '-movflags', '+faststart',
    '-y', output,
  ];
  
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    
    let stderr = '';
    ffmpeg.stderr?.on('data', (data) => {
      stderr += data.toString();
    });
    
    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`FFmpeg exited with code ${code}: ${stderr}`));
      }
    });
    
    ffmpeg.on('error', (err) => {
      reject(new Error(`FFmpeg spawn failed: ${err.message}`));
    });
  });
}

/**
 * Check if FFmpeg is available.
 */
export async function checkFFmpeg(): Promise<boolean> {
  return new Promise((resolve) => {
    const ffmpeg = spawn('ffmpeg', ['-version']);
    ffmpeg.on('close', (code) => resolve(code === 0));
    ffmpeg.on('error', () => resolve(false));
  });
}

/**
 * Get video duration using ffprobe.
 */
export async function getVideoDuration(videoPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath
    ]);
    
    let stdout = '';
    ffprobe.stdout?.on('data', (data) => {
      stdout += data.toString();
    });
    
    ffprobe.on('close', (code) => {
      if (code === 0) {
        resolve(parseFloat(stdout.trim()));
      } else {
        reject(new Error(`ffprobe failed with code ${code}`));
      }
    });
    
    ffprobe.on('error', reject);
  });
}

/**
 * Get video dimensions using ffprobe.
 */
export async function getVideoDimensions(videoPath: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=s=x:p=0',
      videoPath
    ]);
    
    let stdout = '';
    ffprobe.stdout?.on('data', (data) => {
      stdout += data.toString();
    });
    
    ffprobe.on('close', (code) => {
      if (code === 0) {
        const [width, height] = stdout.trim().split('x').map(Number);
        if (
          width !== undefined && height !== undefined &&
          Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
        ) {
          resolve({ width, height });
        } else {
          reject(new Error(`ffprobe returned invalid dimensions: ${stdout.trim()}`));
        }
      } else {
        reject(new Error(`ffprobe failed with code ${code}`));
      }
    });
    
    ffprobe.on('error', reject);
  });
}