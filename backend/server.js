// video api server
const express = require('express');
const https = require('https');
const path = require('path');
const fs = require('fs');

let app = express();

const videoFilePath = path.join(__dirname, 'public/video');

// build path setting
app.use(express.static(path.join(__dirname, '/build')));
// public path setting
app.use('/', express.static(__dirname + '/public'));

// get Videoes  api
app.use('/api/v1/videoes', async function (req, res) {
  const filenames = [];
  await fs.readdirSync(videoFilePath).forEach(file => {
    filenames.push(file);
  })
  res.send({
    filenames: filenames,
  })
});

//get Video api 
app.use('/api/v1/video/:filename', async function (req, res) {
  const videoName = req.params.filename;
  const videoPath = path.join(videoFilePath, videoName);

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
});


// api path setting
const port = 3000;

// server start 
app.listen(port, () => {
  console.log(`server is running on ${port}`);
});