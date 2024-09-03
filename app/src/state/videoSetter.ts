import axios from 'axios';
const video = axios.create({
  baseURL: 'http://localhost:3001',
});

export const videoSetter = async (
  setter: React.Dispatch<React.SetStateAction<string[]>>,
) => {
  await video
    .get('/api/v1/videoes')
    .then((res) => {
      setter(res.data.filenames);
    })
    .catch((error) => {
      console.log(error.message);
      setter([]);
    });
};
