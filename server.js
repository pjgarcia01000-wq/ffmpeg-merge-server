const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
app.use(express.json({ limit: '10mb' }));

const jobs = {};

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        file.close();
        return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
      }
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

function getDuration(filePath) {
  return new Promise((resolve, reject) => {
    exec(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${filePath}"`, (err, stdout) => {
      if (err) return reject(err);
      resolve(parseFloat(stdout.trim()));
    });
  });
}

async function processJob(jobId, videos, audio, baseUrl) {
  const tmpDir = `/tmp/merge_${jobId}`;
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    jobs[jobId].status = 'downloading';
    console.log(`[${jobId}] Downloading ${videos.length} videos...`);

    const videoPaths = [];
    for (let i = 0; i < videos.length; i++) {
      const p = path.join(tmpDir, `video_${i}.mp4`);
      await downloadFile(videos[i], p);
      videoPaths.push(p);
      console.log(`[${jobId}] Video ${i + 1} downloaded`);
    }

    const audioPath = path.join(tmpDir, 'audio.mp3');
    await downloadFile(audio, audioPath);
    console.log(`[${jobId}] Audio downloaded`);

    jobs[jobId].status = 'processing';

    // Get audio duration to know how many loops we need
    const audioDuration = await getDuration(audioPath);
    console.log(`[${jobId}] Audio duration: ${audioDuration.toFixed(2)}s`);

    // Get duration of one video clip
    const clipDuration = await getDuration(videoPaths[0]);
    console.log(`[${jobId}] Clip duration: ${clipDuration.toFixed(2)}s`);

    // Calculate how many times to repeat each clip to cover audio
    // Total video needed = audioDuration, clips available = videoPaths.length * clipDuration
    // Repeats needed per clip to fill audio
    const totalClipsDuration = videoPaths.length * clipDuration;
    const repeatsNeeded = Math.ceil(audioDuration / totalClipsDuration) + 1;
    console.log(`[${jobId}] Repeating each clip ${repeatsNeeded}x to cover ${audioDuration.toFixed(2)}s audio`);

    // Build concat list: cycle through all clips, repeat enough times
    const concatFile = path.join(tmpDir, 'concat.txt');
    const concatLines = [];
    for (let r = 0; r < repeatsNeeded; r++) {
      for (const vp of videoPaths) {
        concatLines.push(`file '${vp}'`);
      }
    }
    fs.writeFileSync(concatFile, concatLines.join('\n'));
    console.log(`[${jobId}] Concat list: ${concatLines.length} entries`);

    // Concat videos with stream copy (fast, no re-encode) then merge audio
    const outputPath = path.join(tmpDir, 'final.mp4');
    const cmd = `ffmpeg -y -f concat -safe 0 -i "${concatFile}" -i "${audioPath}" -c:v copy -c:a aac -map 0:v:0 -map 1:a:0 -shortest "${outputPath}"`;

    console.log(`[${jobId}] Running FFmpeg merge (stream copy)...`);
    await new Promise((resolve, reject) => {
      exec(cmd, { timeout: 120000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr));
        resolve();
      });
    });

    jobs[jobId].status = 'done';
    jobs[jobId].outputPath = outputPath;
    jobs[jobId].tmpDir = tmpDir;
    jobs[jobId].downloadUrl = `${baseUrl}/download/${jobId}`;
    console.log(`[${jobId}] Done!`);

  } catch (err) {
    console.error(`[${jobId}] Error:`, err.message);
    jobs[jobId].status = 'error';
    jobs[jobId].error = err.message;
    exec(`rm -rf ${tmpDir}`);
  }
}

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/merge', (req, res) => {
  let { videos, audio } = req.body;

  if (typeof videos === 'string') {
    videos = videos.split('|').filter(Boolean);
  } else if (Array.isArray(videos)) {
    videos = videos.map(v => {
      if (typeof v === 'string') return v;
      return v.downloadUrl || v.url || v.download_url || Object.values(v)[0];
    });
  }

  if (!videos || !Array.isArray(videos) || videos.length === 0) {
    return res.status(400).json({ error: 'videos array is required' });
  }
  if (!audio) {
    return res.status(400).json({ error: 'audio URL is required' });
  }

  const jobId = generateId();
  const baseUrl = 'https://' + req.get('host');
  jobs[jobId] = { status: 'queued', createdAt: Date.now() };

  processJob(jobId, videos, audio, baseUrl);

  console.log(`[NEW JOB] ${jobId} - ${videos.length} videos`);
  res.json({ job_id: jobId, status: 'queued' });
});

app.get('/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const response = { status: job.status };
  if (job.status === 'done') response.download_url = job.downloadUrl;
  if (job.status === 'error') response.error = job.error;

  res.json(response);
});

app.get('/download/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job || job.status !== 'done') {
    return res.status(404).json({ error: 'Job not ready or not found' });
  }

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', 'attachment; filename=final.mp4');
  const stream = fs.createReadStream(job.outputPath);
  stream.pipe(res);
  stream.on('end', () => {
    setTimeout(() => {
      exec(`rm -rf ${job.tmpDir}`);
      delete jobs[req.params.jobId];
    }, 5000);
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FFmpeg async server (stream copy) running on port ${PORT}`));
