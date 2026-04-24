const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
app.use(express.json({ limit: '50mb' }));

const TEMP_DIR = '/tmp/renders';
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const CLOUDINARY_CLOUD = process.env.CLOUDINARY_CLOUD;
const CLOUDINARY_UPLOAD_PRESET = process.env.CLOUDINARY_UPLOAD_PRESET || 'n8n_audio';

// Download any file from URL to local path
async function downloadFile(url, dest) {
  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream',
    timeout: 90000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FFmpegService/1.0)' }
  });
  const writer = fs.createWriteStream(dest);
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

// Run FFmpeg and return promise
function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-y', ...args]);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.stdout.on('data', () => {});
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg failed (code ${code}):\n${stderr.slice(-1500)}`));
    });
    proc.on('error', err => reject(new Error(`FFmpeg spawn error: ${err.message}`)));
  });
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'ffmpeg-render', cloudinary_cloud: CLOUDINARY_CLOUD });
});

// Main render endpoint
app.post('/render', async (req, res) => {
  const jobId = uuidv4().replace(/-/g, '').substring(0, 10);
  const jobDir = path.join(TEMP_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  try {
    const {
      audio_url,
      segments = [],
      title = '',
      width = 1080,
      height = 1920
    } = req.body;

    if (!audio_url) throw new Error('audio_url is required');
    if (!segments.length) throw new Error('segments array is required and cannot be empty');
    if (!CLOUDINARY_CLOUD) throw new Error('CLOUDINARY_CLOUD env var not set');

    console.log(`[${jobId}] Render started — ${segments.length} segments`);

    // --- STEP 1: Download audio ---
    const audioPath = path.join(jobDir, 'audio.mp3');
    await downloadFile(audio_url, audioPath);
    console.log(`[${jobId}] Audio downloaded`);

    // --- STEP 2: Download and scale each video segment ---
    const scaledPaths = [];
    for (let i = 0; i < segments.length; i++) {
      const rawPath = path.join(jobDir, `raw_${i}.mp4`);
      const scaledPath = path.join(jobDir, `scaled_${i}.mp4`);

      await downloadFile(segments[i].url, rawPath);

      const dur = segments[i].duration || 8;
      await runFFmpeg([
        '-i', rawPath,
        '-t', String(dur),
        '-vf', `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=30`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26',
        '-an',
        scaledPath
      ]);
      scaledPaths.push(scaledPath);
      console.log(`[${jobId}] Segment ${i + 1}/${segments.length} processed`);
    }

    // --- STEP 3: Concatenate video segments ---
    const concatListPath = path.join(jobDir, 'list.txt');
    fs.writeFileSync(concatListPath, scaledPaths.map(p => `file '${p}'`).join('\n'));

    const concatPath = path.join(jobDir, 'concat.mp4');
    await runFFmpeg([
      '-f', 'concat', '-safe', '0',
      '-i', concatListPath,
      '-c', 'copy',
      concatPath
    ]);
    console.log(`[${jobId}] Segments concatenated`);

    // --- STEP 4: Add audio + optional title text ---
    const outputPath = path.join(jobDir, 'output.mp4');

    let vfFilter = 'null';
    if (title) {
      const safeTitle = title
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "’")
        .replace(/:/g, "\\:")
        .substring(0, 80);

      const font = '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf';
      vfFilter = `drawtext=text='${safeTitle}':fontfile='${font}':fontsize=52:fontcolor=white:borderw=3:bordercolor=black:x=(w-text_w)/2:y=80:line_spacing=8`;
    }

    await runFFmpeg([
      '-i', concatPath,
      '-i', audioPath,
      '-vf', vfFilter,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
      '-c:a', 'aac', '-b:a', '128k',
      '-shortest',
      '-movflags', '+faststart',
      '-pix_fmt', 'yuv420p',
      outputPath
    ]);
    console.log(`[${jobId}] Final video rendered`);

    // --- STEP 5: Upload to Cloudinary ---
    const form = new FormData();
    form.append('file', fs.createReadStream(outputPath));
    form.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
    form.append('resource_type', 'video');
    form.append('folder', 'videos_virales');
    form.append('public_id', `viral_${jobId}`);

    const uploadRes = await axios.post(
      `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/video/upload`,
      form,
      {
        headers: form.getHeaders(),
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 180000
      }
    );

    const videoUrl = uploadRes.data.secure_url;
    console.log(`[${jobId}] Uploaded: ${videoUrl}`);

    res.json({ success: true, url: videoUrl, public_id: uploadRes.data.public_id, job_id: jobId });

  } catch (err) {
    console.error(`[${jobId}] ERROR:`, err.message);
    res.status(500).json({ success: false, error: err.message, job_id: jobId });
  } finally {
    try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch (_) {}
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FFmpeg Render Service running on port ${PORT}`));
