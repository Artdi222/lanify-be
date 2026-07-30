import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
const s3 = new S3Client({
  endpoint: 'https://s3.us-east-005.backblazeb2.com',
  region: 'us-east-005',
  credentials: {
    accessKeyId: '0055ed20e2fc4fa0000000001',
    secretAccessKey: 'K00542sx3DP7AKw/qo6LcOkTqrKKfmE',
  },
});
s3.send(new GetObjectCommand({ Bucket: 'lanify', Key: 'uploads/53bc8a9424d9-2551391_Sad_Keyboard_Guy___Myntian_-_Void__Shader__feat._xia_.osz' }))
  .then(res => console.log("OK", res.ContentLength))
  .catch(err => console.error("Error", err));
