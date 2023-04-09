const pgConnString = process.env.PG_CONN_STRING
const accessKeyId = process.env.AWS_ACCESS_KEY_ID
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
const s3bucket = process.env.S3_BUCKET
const port = process.env.PORT
const express = require('express')
const bodyParser = require('body-parser')
const multer  = require('multer')
const storage = multer.diskStorage(
    {
        destination: function (req, file, cb) {
            cb(null, 'covers/')
        },
        filename: function (req, file, cb) {
            cb(null, Date.now() + '_' + file.originalname)
        }
    }
)
const upload = multer({storage})
const fs = require('fs')
const ColorThief = require('colorthief')
const cors = require('cors')
const pgp = require('pg-promise')()
const db = pgp(pgConnString)
const app = express()
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const region = 'us-east-1'
const credentials = {
    accessKeyId:accessKeyId,
    secretAccessKey:secretAccessKey
}
const s3Client = new S3Client({ region: region, credentials: credentials })
app.use(cors())
app.use(bodyParser.urlencoded({ extended: 'true' }))
app.use(bodyParser.json())
app.use(express.static('covers'))


app.get('/null', (req, res) => res.sendStatus(200))
app.get('/', (req, res) => res.sendStatus(200))

app.get(
    '/getlogin/:passcode',
    (req, res) => {
        const passcode = req.params.passcode
        db.any('select * from people where passcode = $1', passcode)
            .then(
                data => {
                    res.send(data)
                    if (data.personid !== -1) {
                        db.none('delete from albums where addedbypersonid = -1')
                    }
                }
            )
            .catch(error => res.send(error))
    }
)

app.get(
    '/getalbums/:personid/:sortfield/:sortdirection',
    (req, res) => {
        const personid = req.params.personid
        const sortField = req.params.sortfield
        const sortDirection = req.params.sortdirection
        let whereClause = ''
        if (sortField === 'rating') {whereClause = 'where s.rating is not null'}
        if (sortField === 'averagescore') {whereClause = 'where avg.averagescore is not null'}
        db.any(
            'select a.*, s.rating, avg.averagescore, personname as addedbypersonname from albums a left join (select albumid, rating from scores where personid = $1) s using(albumid) left join (select albumid, round(avg(rating),2) as averagescore from scores group by albumid) avg using(albumid) left join people on addedbypersonid = personid ' + whereClause + ' order by ' + sortField + ' ' + sortDirection,
            personid
        )
            .then(
                albumsData => {
                    let promises = []
                        for (let i = 0; i < albumsData.length; i++) {
                            const promise = db.any('select personname, rating from scores join people using(personid) where albumid = $1', albumsData[i].albumid)
                                .then(data => albumsData[i].ratings = data)
                                .catch(() => res.sendStatus(500))
                            promises.push(promise)
                        }
                    Promise.all(promises)
                        .then(() => res.send(albumsData))
                        .catch(() => res.sendStatus(500))
                }
            )
            .catch(() => res.sendStatus(500))
    }
)

app.get(
    '/getalbum/:id',
    (req, res) => {
        const id = req.params.id
        db.any('SELECT * FROM albums WHERE albumid = $1', id)
            .then(data => res.send(data))
            .catch(() => res.sendStatus(500))
    }
)

app.put(
    '/updatescore/:personid/:albumid/:newRating',
    (req, res) => {
        const personid = req.params.personid
        const albumid = req.params.albumid
        let newRating = req.params.newRating
        if (newRating == 'null') {
            newRating = null
        }
        db.none('DELETE FROM scores WHERE personid = $1 AND albumid = $2', [personid, albumid])
            .then(
                () => {
                    db.none('INSERT INTO scores (rating, albumid, personid) VALUES ($1, $2, $3)', [newRating, albumid, personid])
                        .then(() => res.json({message: 'Score updated'}))
                        .catch(() => res.sendStatus(500))
                }
            )
            .catch(() => res.sendStatus(500))
    }
)

app.post(
    '/editalbum',
    upload.single('coverImage'),
    (req, res) => {
        let { albumid, artist, title, genre, recordLabel, releaseDate } = req.body
        if (releaseDate === '' || releaseDate === null || releaseDate === 'null') {releaseDate = undefined}
        if (genre === '' || genre === null || genre === 'null') {genre = undefined}
        if (recordLabel === '' || recordLabel === null || recordLabel === 'null') {recordLabel = undefined}
        if (req.file) {
            const updFilename = req.file.filename
            const params = {
                Bucket: s3bucket,
                Key: updFilename,
                Body: fs.createReadStream(req.file.path)
            }
            s3Client.send(new PutObjectCommand(params))
            ColorThief.getPalette(req.file.path)
                .then(
                    result => {
                        const coverImageColor1 = 'rgb(' + result[0][0] + ',' + result[0][1] + ',' + result[0][2] + ')'
                        const coverImageColor2 = 'rgb(' + result[1][0] + ',' + result[1][1] + ',' + result[1][2] + ')'
                        const coverImageColor3 = 'rgb(' + result[2][0] + ',' + result[2][1] + ',' + result[2][2] + ')'
                        db.one('select albumcoverimg from albums where albumid=$1', albumid)
                            .then(
                                data => {
                                    const deleteparams = {
                                        Bucket: s3bucket,
                                        Key: data.albumcoverimg
                                    }
                                    s3Client.send(new DeleteObjectCommand(deleteparams))
                                    db.none(
                                        'UPDATE albums SET artist=$1, title=$2, genre=$3, recordLabel=$4, releaseDate=$5, albumcoverimg=$6, albumcoverimg_color1=$7, albumcoverimg_color2=$8, albumcoverimg_color3=$9 WHERE albumid=$10',
                                        [artist, title, genre, recordLabel, releaseDate, updFilename, coverImageColor1, coverImageColor2, coverImageColor3, albumid]
                                    )
                                        .then(() => res.json({message: 'Album updated'}))
                                        .catch(() => res.sendStatus(500))
                                }
                            )
                    }
                )
                .catch(() => res.status(500).json({message: 'Possible corrupted or invalid image; please try another'}))
        } else {
            db.none(
                'UPDATE albums SET artist=$1, title=$2, genre=$3, recordLabel=$4, releaseDate=$5 WHERE albumid=$6',
                [artist, title, genre, recordLabel, releaseDate, albumid]
            )
                .then(() => res.json({message: 'Album updated'}))
                .catch(() => res.sendStatus(500))
        }
    }
)

app.post(
    '/addalbum',
    upload.single('coverImage'),
    (req, res) => {
        let { artist, title, genre, recordLabel, releaseDate, addedby } = req.body
        if (releaseDate === '' || releaseDate === null || releaseDate === 'null') {releaseDate = undefined}
        if (genre === '' || genre === null || genre === 'null') {genre = undefined}
        if (recordLabel === '' || recordLabel === null || recordLabel === 'null') {recordLabel = undefined}
        if (req.file) {
            const filename = req.file.filename
            const params = {
                Bucket: s3bucket,
                Key: filename,
                Body: fs.createReadStream(req.file.path)
            }
            s3Client.send(new PutObjectCommand(params))
            ColorThief.getPalette(req.file.path)
                .then(
                    result => {
                        const coverImageColor1 = 'rgb(' + result[0][0] + ',' + result[0][1] + ',' + result[0][2] + ')'
                        const coverImageColor2 = 'rgb(' + result[1][0] + ',' + result[1][1] + ',' + result[1][2] + ')'
                        const coverImageColor3 = 'rgb(' + result[2][0] + ',' + result[2][1] + ',' + result[2][2] + ')'
                        db.none(
                            "INSERT INTO albums (artist, title, genre, recordLabel, releaseDate, addedDate, albumcoverimg, albumcoverimg_color1, albumcoverimg_color2, albumcoverimg_color3, addedbypersonid) VALUES ($1, $2, $3, $4, $5, now(), $6, $7, $8, $9, $10)",
                            [artist, title, genre, recordLabel, releaseDate, filename, coverImageColor1, coverImageColor2, coverImageColor3, addedby]
                        )
                            .then(() => res.json({message: 'added'}))
                            .catch(() => res.sendStatus(500))
                    }
                )
                .catch(() => res.status(500).json({message: 'Possible corrupted or invalid image; please try another'}))
        } else {
            db.none(
                "INSERT INTO albums (artist, title, genre, recordLabel, releaseDate, addedDate, addedbypersonid) VALUES ($1, $2, $3, $4, $5, now(), $6)",
                [artist, title, genre, recordLabel, releaseDate, addedby]
            )
                .then(() => res.json({message: 'added'}))
                .catch(() => res.sendStatus(500))
        }    
    }
)

app.delete(
    '/deletealbum/:id',
    (req, res) => {
        const id = req.params.id
        db.one('select albumcoverimg from albums where albumid=$1', id)
            .then(
                data => {
                    deleteparams = {
                        Bucket: s3bucket,
                        Key: data.albumcoverimg
                    }
                    s3Client.send(new DeleteObjectCommand(deleteparams))
                    db.none('DELETE FROM albums WHERE albumid=$1', id)
                        .then(() => res.json({message: 'Album deleted'}))
                        .catch(() => res.sendStatus(500))
                }
            )
            .catch(() => res.sendStatus(500))
    }
)

app.listen(
    port,
    () => console.log('server on')
)