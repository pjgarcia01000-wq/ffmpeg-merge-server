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

function getDuration(filePath) {
      return new Promise((resolve, reject) => {
              exec(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${filePath}"`, (err, stdout) => {
                        if (err) return reject(err);
                        resolve(parseFloat(stdout.trim()));
              });
      });
}

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/merge', async (req, res) => {
      let { videos, audio } = req.body;

           // Normalize videos: pipe-separated string, array of strings, or array of objects
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

           const tmpDir = `/tmp/merge_${Date.now()}`;
      fs.mkdirSync(tmpDir, { recursive: true });

           try {
                   // Download all videos
        console.log(`Downloading ${videos.length} videos...`);
                   const videoPaths = [];
                   for (let i = 0; i < videos.length; i++) {
                             const p = path.join(tmpDir, `video_${i}.mp4`);
                             await downloadFile(videos[i], p);
                             videoPaths.push(p);
                             console.log(`Video ${i + 1} downloaded`);
                   }

        // Download audio
        console.log('Downloading audio...');
                   const audioPath = path.join(tmpDir, 'audio.mp3');
                   await downloadFile(audio, audioPath);
                   console.log('Audio downloaded');

        // Get audio duration
        const audioDuration = await getDuration(audioPath);
                   console.log(`Audio duration: ${audioDuration}s`);

        // Calculate target duration per video clip
        const targetPerVideo = audioDuration / videoPaths.length;
                   console.log(`Target per video: ${targetPerVideo}s`);

        // Stretch each video to match target duration
        const stretchedPaths = [];
                   for (let i = 0; i < videoPaths.length; i++) {
                             const vidDuration = await getDuration(videoPaths[i]);
                             const factor = targetPerVideo / vidDuration;
                             console.log(`Video ${i + 1}: ${vidDuration}s -> stretch x${factor.toFixed(2)}`);

                     const stretchedPath = path.join(tmpDir, `stretched_${i}.mp4`);
                             await new Promise((resolve, reject) => {
                                         exec(
                                                       `ffmpeg -y -i "${videoPaths[i]}" -filter:v "setpts=${factor}*PTS" -an "${stretchedPath}"`,
                                             { timeout: 120000 },
                                                       (err, stdout, stderr) => {
                                                                       if (err) { console.error(stderr); return reject(new Error(stderr)); }
                                                                       resolve();
                                                       }
                                                     );
                             });
                             stretchedPaths.push(stretchedPath);
                             console.log(`Video ${i + 1} stretched`);
                   }

        // Concat stretched videos
        const concatFile = path.join(tmpDir, 'concat.txt');
                   fs.writeFileSync(concatFile, stretchedPaths.map(p => `file '${p}'`).join('\n'));

        const outputPath = path.join(tmpDir, 'final.mp4');
                   const cmd = `ffmpeg -y -f concat -safe 0 -i "${concatFile}" -i "${audioPath}" -c:v libx264 -preset fast -c:a aac -map 0:v:0 -map 1:a:0 "${outputPath}"`;

        console.log('Running FFmpeg merge...');
                   await new Promise((resolve, reject) => {
                             exec(cmd, { timeout: 300000 }, (err, stdout, stderr) => {
                                         if (err) { console.error(stderr); return reject(new Error(stderr)); }
                                         resolve();
                             });
                   });

        console.log('Done! Sending response...');
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
