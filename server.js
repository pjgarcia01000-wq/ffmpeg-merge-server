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

// ─── ENDPOINT: Mezclar audios de personajes en secuencia ───────────────────
app.post('/merge-audios', async (req, res) => {
  let { audios } = req.body;

  if (typeof audios === 'string') {
    audios = audios.split('|').filter(Boolean);
  }

  if (!audios || !Array.isArray(audios) || audios.length === 0) {
    return res.status(400).json({ error: 'audios array is required' });
  }

  const tmpDir = `/tmp/audios_${Date.now()}`;
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    console.log(`Downloading ${audios.length} audio files...`);
    const audioPaths = [];
    for (let i = 0; i < audios.length; i++) {
      const p = path.join(tmpDir, `audio_${i}.mp3`);
      await downloadFile(audios[i], p);
      audioPaths.push(p);
      console.log(`Audio ${i + 1} downloaded`);
    }

    const concatFile = path.join(tmpDir, 'concat.txt');
    fs.writeFileSync(concatFile, audioPaths.map(p => `file '${p}'`).join('\n'));

    const outputPath = path.join(tmpDir, 'merged_audio.mp3');
    const cmd = `ffmpeg -y -f concat -safe 0 -i "${concatFile}" -c:a libmp3lame -q:a 2 "${outputPath}"`;

    console.log('Merging audios...');
    await new Promise((resolve, reject) => {
      exec(cmd, { timeout: 60000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr));
        resolve();
      });
    });

    console.log('Audios merged, sending response...');
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', 'attachment; filename=merged_audio.mp3');
    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on('end', () => {
      setTimeout(() => exec(`rm -rf ${tmpDir}`), 3000);
    });

  } catch (err) {
    console.error('merge-audios error:', err.message);
    exec(`rm -rf ${tmpDir}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── ENDPOINT: Merge videos + audio (async con job_id) ────────────────────
// Soporta parámetro opcional "music" para música de fondo mezclada al volumen indicado
async function processJob(jobId, videos, audio, baseUrl, music, musicVolume) {
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

    // ── Música de fondo opcional ──────────────────────────────────────────
    let finalAudioPath = audioPath;
    if (music) {
      const musicPath = path.join(tmpDir, 'music.mp3');
      await downloadFile(music, musicPath);
      console.log(`[${jobId}] Music downloaded`);
      const vol = musicVolume || 0.15;
      const mixedPath = path.join(tmpDir, 'mixed_audio.mp3');
      const mixCmd = `ffmpeg -y -i "${audioPath}" -i "${musicPath}" -filter_complex "[1:a]volume=${vol}[bg];[0:a][bg]amix=inputs=2:duration=first:dropout_transition=2[out]" -map "[out]" -c:a aac "${mixedPath}"`;
      await new Promise((res2, rej2) => {
        exec(mixCmd, { timeout: 60000 }, (err) => err ? rej2(new Error(err.message)) : res2());
      });
      finalAudioPath = mixedPath;
      console.log(`[${jobId}] Audio mixed with background music (vol: ${vol})`);
    }
    // ─────────────────────────────────────────────────────────────────────

    jobs[jobId].status = 'processing';

    const audioDuration = await getDuration(finalAudioPath);
    const clipDuration = await getDuration(videoPaths[0]);
    const totalClipsDuration = videoPaths.length * clipDuration;
    const repeatsNeeded = Math.ceil(audioDuration / totalClipsDuration) + 1;

    const concatFile = path.join(tmpDir, 'concat.txt');
    const concatLines = [];
    for (let r = 0; r < repeatsNeeded; r++) {
      for (const vp of videoPaths) {
        concatLines.push(`file '${vp}'`);
      }
    }
    fs.writeFileSync(concatFile, concatLines.join('\n'));

    const outputPath = path.join(tmpDir, 'final.mp4');
    const cmd = `ffmpeg -y -f concat -safe 0 -i "${concatFile}" -i "${finalAudioPath}" -c:v copy -c:a aac -map 0:v:0 -map 1:a:0 -shortest "${outputPath}"`;

    console.log(`[${jobId}] Running FFmpeg merge...`);
    await new Promise((resolve, reject) => {
      exec(cmd, { timeout: 120000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr));
        resolve();
      });
    });

    jobs[jobId].status = 'done';
    jobs[jobId].outputPath = outputPath;
    jobs[jobId].tmpDir = tmpDir;
    jobs[jobId].downloadUrl = `${'https://' + baseUrl}/download/${jobId}`;
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
  let { videos, audio, music, music_volume } = req.body;

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
  const host = req.get('host');
  jobs[jobId] = { status: 'queued', createdAt: Date.now() };

  processJob(jobId, videos, audio, host, music, music_volume);

  console.log(`[NEW JOB] ${jobId} - ${videos.length} videos${music ? ' + music' : ''}`);
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

// ─── ENDPOINT: /merge-sync ────────────────────────────────────────────────────
// Solo para QuePasariaSi. Ajusta velocidad del audio al video sin repetir escenas.
// NO modifica /merge ni /merge-audios — los otros canales no se ven afectados.
async function processSyncJob(jobId, videos, audio, baseUrl) {
  const tmpDir = `/tmp/sync_${jobId}`;
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    jobs[jobId].status = 'downloading';
    const videoPaths = [];
    for (let i = 0; i < videos.length; i++) {
      const p = path.join(tmpDir, `video_${i}.mp4`);
      await downloadFile(videos[i], p);
      videoPaths.push(p);
    }
    const audioPath = path.join(tmpDir, 'audio.mp3');
    await downloadFile(audio, audioPath);
    jobs[jobId].status = 'processing';
    const videoDurations = await Promise.all(videoPaths.map(getDuration));
    const totalVideoDuration = videoDurations.reduce((a, b) => a + b, 0);
    const audioDuration = await getDuration(audioPath);
    const tempo = audioDuration / totalVideoDuration;
    console.log(`[${jobId}] Video:${totalVideoDuration.toFixed(2)}s Audio:${audioDuration.toFixed(2)}s Tempo:${tempo.toFixed(4)}`);
    let atempoFilter;
    if (tempo < 0.5) { atempoFilter = `atempo=0.5,atempo=${(tempo/0.5).toFixed(4)}`; }
    else if (tempo > 2.0) { atempoFilter = `atempo=2.0,atempo=${(tempo/2.0).toFixed(4)}`; }
    else { atempoFilter = `atempo=${tempo.toFixed(4)}`; }
    const concatFile = path.join(tmpDir, 'concat.txt');
    fs.writeFileSync(concatFile, videoPaths.map(p => `file '${p}'`).join('\n'));
    const outputPath = path.join(tmpDir, 'final.mp4');
    const cmd = `ffmpeg -y -f concat -safe 0 -i "${concatFile}" -i "${audioPath}" -c:v copy -af "${atempoFilter}" -c:a aac -map 0:v:0 -map 1:a:0 -shortest "${outputPath}"`;
    await new Promise((resolve, reject) => {
      exec(cmd, { timeout: 180000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr));
        resolve();
      });
    });
    jobs[jobId].status = 'done';
    jobs[jobId].outputPath = outputPath;
    jobs[jobId].tmpDir = tmpDir;
    jobs[jobId].downloadUrl = `${'https://' + baseUrl}/download/${jobId}`;
    console.log(`[${jobId}] SyncJob done!`);
  } catch (err) {
    jobs[jobId].status = 'error';
    jobs[jobId].error = err.message;
    exec(`rm -rf ${tmpDir}`);
  }
}

app.post('/merge-sync', (req, res) => {
  let { videos, audio } = req.body;
  if (typeof videos === 'string') { videos = videos.split('|').filter(Boolean); }
  else if (Array.isArray(videos)) { videos = videos.map(v => typeof v === 'string' ? v : v.downloadUrl || v.url || Object.values(v)[0]); }
  if (!videos || !Array.isArray(videos) || videos.length === 0) return res.status(400).json({ error: 'videos required' });
  if (!audio) return res.status(400).json({ error: 'audio required' });
  const jobId = generateId();
  jobs[jobId] = { status: 'queued', createdAt: Date.now() };
  processSyncJob(jobId, videos, audio, req.get('host'));
  console.log(`[SYNC JOB] ${jobId} - ${videos.length} videos`);
  res.json({ job_id: jobId, status: 'queued' });
});

// ─── ENDPOINT: /concat ────────────────────────────────────────────────────────
// Une videos que YA tienen audio embebido. Sin audio separado.
async function processConcatJob(jobId, videos, baseUrl) {
  const tmpDir = `/tmp/concat_${jobId}`;
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    jobs[jobId].status = 'downloading';
    const videoPaths = [];
    for (let i = 0; i < videos.length; i++) {
      const p = path.join(tmpDir, `segment_${i}.mp4`);
      await downloadFile(videos[i], p);
      videoPaths.push(p);
      console.log(`[${jobId}] Segment ${i + 1} downloaded`);
    }
    jobs[jobId].status = 'processing';
    const concatFile = path.join(tmpDir, 'concat.txt');
    fs.writeFileSync(concatFile, videoPaths.map(p => `file '${p}'`).join('\n'));
    const outputPath = path.join(tmpDir, 'final.mp4');
    const cmd = `ffmpeg -y -f concat -safe 0 -i "${concatFile}" -c copy "${outputPath}"`;
    console.log(`[${jobId}] Concatenating ${videos.length} segments...`);
    await new Promise((resolve, reject) => {
      exec(cmd, { timeout: 300000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr));
        resolve();
      });
    });
    jobs[jobId].status = 'done';
    jobs[jobId].outputPath = outputPath;
    jobs[jobId].tmpDir = tmpDir;
    jobs[jobId].downloadUrl = `${'https://' + baseUrl}/download/${jobId}`;
    console.log(`[${jobId}] Concat done!`);
  } catch (err) {
    jobs[jobId].status = 'error';
    jobs[jobId].error = err.message;
    exec(`rm -rf ${tmpDir}`);
  }
}

app.post('/concat', (req, res) => {
  let { videos } = req.body;
  if (typeof videos === 'string') { videos = videos.split('|').filter(Boolean); }
  else if (Array.isArray(videos)) { videos = videos.map(v => typeof v === 'string' ? v : v.downloadUrl || v.url || Object.values(v)[0]); }
  if (!videos || !Array.isArray(videos) || videos.length === 0) return res.status(400).json({ error: 'videos required' });
  const jobId = generateId();
  jobs[jobId] = { status: 'queued', createdAt: Date.now() };
  processConcatJob(jobId, videos, req.get('host'));
  console.log(`[CONCAT JOB] ${jobId} - ${videos.length} segments`);
  res.json({ job_id: jobId, status: 'queued' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FFmpeg server running on port ${PORT}`));
