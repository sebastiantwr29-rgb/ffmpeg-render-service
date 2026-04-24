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

  async function downloadFile(url, dest) {
    const response = await axios({
      url, method: 'GET', responseType: 'stream', timeout: 90000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FFmpegService/1.0)' }
    });
    const writer = fs.createWriteStream(dest);
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  }

  function runFFmpeg(args) {
    return new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', ['-y', ...args]);
      let stderr = '';
      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.stdout.on('data', () => {});
      proc.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error('FFmpeg failed (code ' + code + '):\n' + stderr.slice(-1500)));
      });
      proc.on('error', err => reject(new Error('FFmpeg spawn error: ' + err.message)));
    });
  }

  function generateSRT(segments) {
    const pad = (n, len) => String(Math.floor(n)).padStart(len, '0');
    const toTC = (s) => {
      const h = pad(s / 3600, 2);
      const m = pad((s % 3600) / 60, 2);
      const sec = pad(s % 60, 2);
      const ms = pad((s % 1) * 1000, 3);
      return h + ':' + m + ':' + sec + ',' + ms;
    };
    return segments.map((seg, i) => {
      const ts = toTC(seg.start) + ' --> ' + toTC(seg.end);
      return (i + 1) + '\n' + ts + '\n' + seg.text + '\n';
    }).join('\n');
  }

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'ffmpeg-render', cloudinary_cloud: CLOUDINARY_CLOUD });
  });

  app.post('/render', async (req, res) => {
    const jobId = uuidv4().replace(/-/g, '').substring(0, 10);
    const jobDir = path.join(TEMP_DIR, jobId);
    fs.mkdirSync(jobDir, { recursive: true });

    try {
      const {
        audio_url, segments = [], title = '',
        subtitle_segments = [], width = 1080, height = 1920
      } = req.body;

      if (!audio_url) throw new Error('audio_url is required');
      if (!segments.length) throw new Error('segments array is required and cannot be empty');
      if (!CLOUDINARY_CLOUD) throw new Error('CLOUDINARY_CLOUD env var not set');

      console.log('[' + jobId + '] Render started — ' + segments.length + ' segments');

      const audioPath = path.join(jobDir, 'audio.mp3');
      await downloadFile(audio_url, audioPath);
      console.log('[' + jobId + '] Audio downloaded');

      const scaledPaths = [];
      for (let i = 0; i < segments.length; i++) {
        const rawPath = path.join(jobDir, 'raw_' + i + '.mp4');
        const scaledPath = path.join(jobDir, 'scaled_' + i + '.mp4');
        await downloadFile(segments[i].url, rawPath);
        const dur = segments[i].duration || 8;
        const scaleFilter = 'scale=' + width + ':' + height +
          ':force_original_aspect_ratio=increase,crop=' + width + ':' + height +
          ',setsar=1,fps=30';
        await runFFmpeg(['-i', rawPath, '-t', String(dur), '-vf', scaleFilter,
          '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-an', scaledPath]);
        scaledPaths.push(scaledPath);
        console.log('[' + jobId + '] Segment ' + (i + 1) + '/' + segments.length + ' processed');
      }

      const concatPath = path.join(jobDir, 'concat.mp4');
      const FADE = 0.4;

      if (scaledPaths.length === 1) {
        fs.copyFileSync(scaledPaths[0], concatPath);
      } else {
        const inputArgs = scaledPaths.flatMap(p => ['-i', p]);
        const filterParts = [];
        let cumDur = 0;
        for (let i = 1; i < scaledPaths.length; i++) {
          cumDur += segments[i - 1].duration || 8;
          const offset = Math.max(0, cumDur - i * FADE).toFixed(3);
          const srcA = i === 1 ? '[0:v]' : '[xf' + (i - 1) + ']';
          const srcB = '[' + i + ':v]';
          const dst = i === scaledPaths.length - 1 ? '[vout]' : '[xf' + i + ']';
          filterParts.push(srcA + srcB + 'xfade=transition=fade:duration=' + FADE + ':offset=' + offset + dst);
        }
        await runFFmpeg([...inputArgs, '-filter_complex', filterParts.join(';'),
          '-map', '[vout]', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-an', concatPath]);
      }
      console.log('[' + jobId + '] Segments concatenated with crossfade');

      const outputPath = path.join(jobDir, 'output.mp4');
      const vfFilters = [];

      vfFilters.push('eq=saturation=1.2:contrast=1.07:brightness=0.02');
      vfFilters.push('vignette=PI/5');

      if (subtitle_segments && subtitle_segments.length > 0) {
        const srtPath = path.join(jobDir, 'subtitles.srt');
        fs.writeFileSync(srtPath, generateSRT(subtitle_segments), 'utf8');
        const escapedSrt = srtPath.replace(/\\/g, '/');
        const subStyle = 'Fontname=DejaVu Sans Bold' +
          ',Fontsize=17,PrimaryColour=&H00FFFFFF' +
          ',OutlineColour=&H00000000,Bold=1,Outline=4' +
          ',Shadow=2,Alignment=2,MarginV=130';
        vfFilters.push("subtitles='" + escapedSrt + "':force_style='" + subStyle + "'");
        console.log('[' + jobId + '] Subtitulos: ' + subtitle_segments.length + ' segmentos');
      }

      if (title) {
        const safeTitle = title.replace(/\\/g, '\\\\').replace(/'/g, "'").replace(/:/g, '\\:').substring(0, 60);
        const font = '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf';
        const dtFilter = "drawtext=text='" + safeTitle + "':fontfile='" + font +
          "':fontsize=46:fontcolor=white:borderw=3:bordercolor=black:x=(w-text_w)/2:y=60";
        vfFilters.push(dtFilter);
      }

      await runFFmpeg(['-i', concatPath, '-i', audioPath,
        '-vf', vfFilters.join(','),
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
        '-c:a', 'aac', '-b:a', '128k',
        '-shortest', '-movflags', '+faststart', '-pix_fmt', 'yuv420p',
        outputPath]);
      console.log('[' + jobId + '] Final video rendered');

      const form = new FormData();
      form.append('file', fs.createReadStream(outputPath));
      form.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
      form.append('resource_type', 'video');
      form.append('folder', 'videos_virales');
      form.append('public_id', 'viral_' + jobId);

      const uploadRes = await axios.post(
        'https://api.cloudinary.com/v1_1/' + CLOUDINARY_CLOUD + '/video/upload',
        form,
        { headers: form.getHeaders(), maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 180000 }
      );

      const videoUrl = uploadRes.data.secure_url;
      console.log('[' + jobId + '] Uploaded: ' + videoUrl);
      res.json({ success: true, url: videoUrl, public_id: uploadRes.data.public_id, job_id: jobId });

    } catch (err) {
      console.error('[' + jobId + '] ERROR:', err.message);
      res.status(500).json({ success: false, error: err.message, job_id: jobId });
    } finally {
      try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, '0.0.0.0', () => console.log('FFmpeg Render Service running on port ' + PORT));
