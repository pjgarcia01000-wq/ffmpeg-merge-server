const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
app.use(express.json({ limit: '10mb' }));

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

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/merge', async (req, res) => {
  const { videos, audio } = req.body;

  if (!videos || !Array.isArray(videos) || videos.length === 0) {
    return res.status(400).json({ error: 'videos array is required' });
  }
  if (!audio) {
    return res.status(400).json({ error: 'audio URL is required' });
  }

  const tmpDir = `/tmp/merge_${Date.now()}`;
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    console.log(`Downloading ${videos.length} videos...`);
    const videoPaths = [];
    for (let i = 0; i < videos.length; i++) {
      const p = path.join(tmpDir, `video_${i}.mp4`);
      await downloadFile(videos[i], p);
      videoPaths.push(p);
      console.log(`Video ${i + 1} downloaded`);
    }

    console.log('Downloading audio...');
    const audioPath = path.join(tmpDir, 'audio.mp3');
    await downloadFile(audio, audioPath);
    console.log('Audio downloaded');

    // Concat file for ffmpeg
    const concatFile = path.join(tmpDir, 'concat.txt');
    const concatContent = videoPaths.map(p => `file '${p}'`).join('\n');
    fs.writeFileSync(concatFile, concatContent);

    const outputPath = path.join(tmpDir, 'final.mp4');

    // FFmpeg: concat videos + overlay audio, shortest wins
    const cmd = `ffmpeg -y -f concat -safe 0 -i "${concatFile}" -stream_loop -1 -i "${audioPath}" -c:v copy -c:a aac -map 0:v:0 -map 1:a:0 -shortest "${outputPath}"`;

    console.log('Running FFmpeg...');
    await new Promise((resolve, reject) => {
      exec(cmd, { timeout: 300000 }, (err, stdout, stderr) => {
        if (err) {
          console.error('FFmpeg error:', stderr);
          return reject(new Error(stderr));
        }
        resolve();
      });
    });

    console.log('FFmpeg done, sending response...');
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename=final.mp4');
    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on('end', () => {
      setTimeout(() => exec(`rm -rf ${tmpDir}`), 3000);
    });

  } catch (err) {
    console.error('Error:', err.message);
    exec(`rm -rf ${tmpDir}`);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FFmpeg server running on port ${PORT}`));
