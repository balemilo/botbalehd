
const {
  default: makeWASocket,
  useMultiFileAuthState,
  downloadMediaMessage,
  DisconnectReason
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');

const logger = pino({ level: 'silent' });

const PHONE = process.env.PHONE_NUMBER;
const ALLOWED = (process.env.ALLOWED_NUMBERS || '')
  .split(',')
  .map(n => n.trim())
  .filter(Boolean);

const SESSION_DIR =
  process.env.SESSION_DIR || './session';

const MAX_MB = Number(process.env.MAX_VIDEO_MB || 50);
const MAX_BYTES = MAX_MB * 1024 * 1024;

let busy = false;
let pairingRequested = false;
let reconnectTimer;

if (!PHONE || !ALLOWED.length) {
  console.error(
    'Sila tetapkan PHONE_NUMBER dan ALLOWED_NUMBERS di Render.'
  );
  process.exit(1);
}

fs.mkdirSync(SESSION_DIR, { recursive: true });

// PROSES VIDEO MENGGUNAKAN FFMPEG
function optimizeVideo(input, output) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner',
      '-nostdin',
      '-y',
      '-i', input,
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-vf',
      "scale=w=1920:h=1080:force_original_aspect_ratio=decrease:force_divisible_by=2",
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '20',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '160k',
      '-movflags', '+faststart',
      output
    ];

    const ffmpeg = spawn('ffmpeg', args);

    let errorLog = '';
    let finished = false;

    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };

    const timeout = setTimeout(() => {
      ffmpeg.kill('SIGKILL');
      finish(new Error('Processing timeout'));
    }, 600000);

    ffmpeg.stderr.on('data', data => {
      errorLog = (errorLog + data.toString()).slice(-3000);
    });

    ffmpeg.on('error', finish);

    ffmpeg.on('close', code => {
      if (code === 0) finish();
      else finish(new Error(errorLog || `FFmpeg exit ${code}`));
    });
  });
}

// BACA MESEJ WHATSAPP
function unwrapMessage(message) {
  let content = message;

  for (let i = 0; i < 4; i++) {
    const nested =
      content?.ephemeralMessage?.message ||
      content?.viewOnceMessage?.message ||
      content?.viewOnceMessageV2?.message ||
      content?.documentWithCaptionMessage?.message;

    if (!nested) break;
    content = nested;
  }

  return content;
}

// MULAKAN BOT
async function startBot() {
  const { state, saveCreds } =
    await useMultiFileAuthState(SESSION_DIR);

  const sock = makeWASocket({
    auth: state,
    logger,
    printQRInTerminal: false,
    markOnlineOnConnect: false
  });

  sock.ev.on('creds.update', saveCreds);

  // WHATSAPP CONNECTION
  sock.ev.on('connection.update', async update => {
    const { connection, lastDisconnect, qr } = update;

    if (
      !sock.authState.creds.registered &&
      !pairingRequested &&
      (connection === 'connecting' || qr)
    ) {
      pairingRequested = true;

      try {
        await new Promise(r => setTimeout(r, 3000));

        const code = await sock.requestPairingCode(PHONE);

        console.log('========================');
        console.log('PAIRING CODE:', code);
        console.log('========================');
      } catch (error) {
        pairingRequested = false;
        console.error('Pairing error:', error.message);
      }
    }

    if (connection === 'open') {
      pairingRequested = false;
      console.log('WA HD VIDEO BOT CONNECTED');
    }

    if (connection === 'close') {
      const status =
        lastDisconnect?.error?.output?.statusCode;

      if (status === DisconnectReason.loggedOut) {
        console.log('WhatsApp logged out. Pair semula.');
        return;
      }

      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        pairingRequested = false;
        startBot().catch(console.error);
      }, 5000);
    }
  });

  // TERIMA VIDEO
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const jid = msg.key.remoteJid || '';

      // HANYA CHAT INDIVIDU
      if (!jid.endsWith('@s.whatsapp.net')) continue;

      const sender = jid.split('@')[0];

      // HANYA NOMBOR DIBENARKAN
      if (!ALLOWED.includes(sender)) continue;

      const content = unwrapMessage(msg.message);

      const video = content?.videoMessage;
      const document = content?.documentMessage;

      const media =
        video ||
        (document?.mimetype?.startsWith('video/')
          ? document
          : null);

      if (!media || media.viewOnce) continue;

      if (busy) {
        await sock.sendMessage(jid, {
          text: '⏳ Bot sedang proses video lain. Cuba lagi selepas selesai.'
        });
        continue;
      }

      if (Number(media.fileLength || 0) > MAX_BYTES) {
        await sock.sendMessage(jid, {
          text: `❌ Fail terlalu besar. Had ialah ${MAX_MB}MB.`
        });
        continue;
      }

      busy = true;

      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'wa-hd-')
      );

      const input = path.join(tempDir, 'input.mp4');
      const output = path.join(tempDir, 'HD-Video.mp4');

      try {
        await sock.sendMessage(jid, {
          text: '🎬 Video diterima!\n\n⚙️ Sedang proses HD menggunakan FFmpeg...'
        });

        // DOWNLOAD VIDEO
        const mediaStream = await downloadMediaMessage(
          msg,
          'stream',
          {},
          {
            logger,
            reuploadRequest: sock.updateMediaMessage
          }
        );

        let downloadedBytes = 0;

        const limiter = new Transform({
          transform(chunk, encoding, callback) {
            downloadedBytes += chunk.length;

            if (downloadedBytes > MAX_BYTES) {
              callback(new Error('File exceeds limit'));
            } else {
              callback(null, chunk);
            }
          }
        });

        await pipeline(
          mediaStream,
          limiter,
          fs.createWriteStream(input)
        );

        // OPTIMIZE VIDEO
        await optimizeVideo(input, output);

        // HANTAR BALIK SEBAGAI DOCUMENT
        await sock.sendMessage(jid, {
          document: { url: output },
          mimetype: 'video/mp4',
          fileName: 'WA-HD-Video.mp4',
          caption:
            '✅ VIDEO SIAP DIPROSES!\n\n' +
            '🎥 Format: MP4\n' +
            '📱 Sesuai untuk dicuba di WhatsApp Status\n\n' +
            '📥 Download fail ini dan simpan ke telefon.\n' +
            'Kemudian upload sendiri ke Status.'
        });

        console.log('Video berjaya diproses dan dihantar.');

      } catch (error) {
        console.error('Video error:', error.message);

        await sock.sendMessage(jid, {
          text:
            '❌ Video gagal diproses.\n' +
            'Cuba video MP4 yang lebih pendek atau kecil.'
        }).catch(() => {});

      } finally {
        fs.rmSync(tempDir, {
          recursive: true,
          force: true
        });

        busy = false;
      }
    }
  });
}

startBot().catch(console.error);
