import AWS from 'aws-sdk'
import { S3Handler } from 'aws-lambda'
import { v4 as uuid } from 'uuid'
import wrap from '@dazn/lambda-powertools-pattern-basic'

import 'source-map-support/register'

import { getVideoProbeData } from '../utils/getVideoProbeData'
import { extname } from 'path'

const s3 = new AWS.S3()
const DDB = new AWS.DynamoDB.DocumentClient()

export const handle = wrap<S3Handler>(async event => {
  if (!event.Records) {
    return
  }

  for (const record of event.Records) {
    if (!record.s3) {
      continue
    }

    const { key } = record.s3.object

    const inputObjectURL = await s3.getSignedUrlPromise('getObject', {
      Bucket: 'nivo-uploads',
      Key: key,
      Expires: 60 * 5
    })

    const probeData = await getVideoProbeData(inputObjectURL)

    const keyframeTimes = [
      ...probeData.packets.filter(p => p.flags === 'K_'),
      probeData.packets[probeData.packets.length - 1]
    ].map(kfPacket => kfPacket.pts_time)

    const segments: Array<[number, number]> = keyframeTimes.reduce(
      (segments: any, cur, idx) => {
        return idx < keyframeTimes.length - 1
          ? [...segments, [cur, keyframeTimes[idx + 1]]]
          : segments
      },
      []
    )

    const { width, height } = probeData.streams[0]
    const { duration, size } = probeData.format
    const resolution = `${width}x${height}`

    const videoId = uuid()
    const resolutions = ['1920x1080', '1280x720', '640x480']

    await DDB.put({
      TableName: 'nivoVideos',
      Item: {
        id: videoId,
        format: extname(key),
        resolution,
        duration: Number(duration),
        size: Number(size)
      }
    }).promise()

    const jobIds: string[] = []

    for (const resolution of resolutions) {
      const jobId = uuid()

      jobIds.push(jobId)

      await DDB.put({
        TableName: 'nivoJobs',
        Item: {
          id: jobId,
          videoId,
          resolution,
          totalSegments: segments.length,
          processedSegments: 0,
          status: 'pending',
          createdAt: Date.now(),
          completedAt: null
        }
      }).promise()
    }

    const segmentsPromises = jobIds.map(async jobId => {
      let segmentNum = 0

      for (segmentNum; segmentNum < segments.length; segmentNum += 1) {
        const id = String(segmentNum).padStart(5, '0')

        await DDB.put({
          TableName: 'nivoSegments',
          Item: {
            id,
            jobId,
            startTime: segments[segmentNum][0],
            endTime: segments[segmentNum][1],
            status: 'pending',
            createdAt: Date.now(),
            completedAt: null
          }
        }).promise()
      }
    })

    await Promise.all(segmentsPromises)
  }
})
