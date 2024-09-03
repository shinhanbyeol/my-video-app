// video api server
const express = require('express');
const https = require('https');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();
let app = express();

// cors 설정
const corsOptions = {
  origin: '*',
}

const videoFilePath = path.join(process.env.VIDEO_PATH);

// build path setting
app.use(express.static(path.join(__dirname, '/build')));
// public path setting
app.use('/', express.static(__dirname + '/public'));

// get Videoes  api
app.get('/api/v1/videoes', cors(corsOptions), async function (req, res) {
  const fileSetArray = [];
  const readedFileNames = await fs.readdirSync(videoFilePath);

  await readedFileNames.forEach(async (filename) => {
    const stat = await fs.statSync(path.join(videoFilePath, filename));
    const fileSet = {
      name: filename,
      time: stat.mtime.getTime(),
    }
    fileSetArray.push(
      fileSet
    );
  });
  const fileNames = fileSetArray.sort((a, b) => a.name - b.name).map((f) => f.name);
  res.send({
    filenames: fileNames,
  })
});

//get Video api 
app.use('/api/v1/video/:filename', cors(corsOptions), async function (req, res) {
  const videoName = req.params.filename;
  const videoPath = path.join(videoFilePath, videoName);
  try {
    const range = req.headers.range || "bytes=0-";
    if (!range) {
      res.status(400).send("Requires Range header");
    }
    const videoSize = fs.statSync(videoPath).size;
    const CHUNK_SIZE = 10 ** 6; // 1MB
    const start = Number(range.replace(/\D/g, ""));
    const end = Math.min(start + CHUNK_SIZE, videoSize - 1);
    const contentLength = end - start + 1;
    const headers = {
      "Content-Range": `bytes ${start}-${end}/${videoSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": contentLength,
      "Content-Type": "video/mp4",
    };
    res.writeHead(206, headers);
    const videoStream = fs.createReadStream(videoPath, { start, end });
    videoStream.pipe(res);
  } catch (error) {
    res.send({
      error: "server error"
    })
  }
});

// api path setting
const port = 3001;

// server start 
app.listen(port, () => {
  console.log(`server is running on ${port}`);
});