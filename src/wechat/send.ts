import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { WeChatApi } from './api.js';
import {
  MessageItemType,
  MessageType,
  MessageState,
  type MessageItem,
  type OutboundMessage,
} from './types.js';
import { encryptAesEcb } from './crypto.js';
import { logger } from '../logger.js';

export function createSender(api: WeChatApi, botAccountId: string) {
  let clientCounter = 0;

  function generateClientId(): string {
    return `wcc-${Date.now()}-${++clientCounter}`;
  }

  async function sendText(toUserId: string, contextToken: string, text: string): Promise<void> {
    const clientId = generateClientId();

    const items: MessageItem[] = [
      {
        type: MessageItemType.TEXT,
        text_item: { text },
      },
    ];

    const msg: OutboundMessage = {
      from_user_id: botAccountId,
      to_user_id: toUserId,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      context_token: contextToken,
      item_list: items,
    };

    logger.info('Sending text message', { toUserId, clientId, textLength: text.length });
    await api.sendMessage({ msg });
    logger.info('Text message sent', { toUserId, clientId });
  }

  /**
   * Send a real WeChat file attachment (clickable / downloadable in chat) by:
   *   1. Asking ilink bot for an upload URL + AES key (`getuploadurl`)
   *   2. AES-ECB encrypting the file bytes with the returned key
   *   3. PUT-uploading the encrypted bytes to the presigned URL
   *   4. sendmessage with a FILE item carrying the cdn_media handle
   *
   * Throws on any step's failure — caller should catch and fall back to a
   * text-only announcement (e.g. "file saved to <path>") so a CDN outage
   * doesn't drop the message entirely.
   */
  async function sendFile(
    toUserId: string,
    contextToken: string,
    filePath: string,
    displayName?: string,
  ): Promise<void> {
    const fileBuffer = readFileSync(filePath);
    const fileName = displayName ?? basename(filePath);
    const fileSize = fileBuffer.length;
    const clientId = generateClientId();

    logger.info('Sending file', { toUserId, clientId, fileName, fileSize });

    // 1. presigned upload URL + AES key
    const uploadInfo = await api.getUploadUrl('file', fileSize, fileName);
    if (uploadInfo.errcode && uploadInfo.errcode !== 0) {
      throw new Error(`getUploadUrl errcode=${uploadInfo.errcode}`);
    }
    if (!uploadInfo.url || !uploadInfo.aes_key || !uploadInfo.encrypt_query_param) {
      throw new Error('getUploadUrl response missing required fields');
    }

    // 2. encrypt with AES-ECB. The aes_key from server may be either:
    //    - base64-of-raw-16-bytes  → use as-is
    //    - base64-of-hex-string    → decode the inner string as hex to 16 bytes
    // (mirrors the dual-format handling in cdn.ts:downloadAndDecrypt).
    const aesKey = decodeAesKey(uploadInfo.aes_key);
    const encrypted = encryptAesEcb(aesKey, fileBuffer);

    // 3. PUT to the presigned URL.
    // Copy into a fresh Uint8Array backed by a clean ArrayBuffer — Node's
    // Buffer type is declared with ArrayBufferLike (which could be
    // SharedArrayBuffer), and fetch's BodyInit demands a plain ArrayBuffer.
    const bodyBytes = new Uint8Array(encrypted.byteLength);
    bodyBytes.set(encrypted);
    const putRes = await fetch(uploadInfo.url, {
      method: 'PUT',
      body: bodyBytes,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    if (!putRes.ok) {
      throw new Error(`upload PUT failed: ${putRes.status} ${putRes.statusText}`);
    }
    logger.info('File uploaded to CDN', { clientId, fileName, encryptedSize: encrypted.length });

    // 4. sendmessage with FILE item
    const items: MessageItem[] = [
      {
        type: MessageItemType.FILE,
        file_item: {
          cdn_media: {
            aes_key: uploadInfo.aes_key,
            encrypt_query_param: uploadInfo.encrypt_query_param,
          },
          file_name: fileName,
        },
      },
    ];
    const msg: OutboundMessage = {
      from_user_id: botAccountId,
      to_user_id: toUserId,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      context_token: contextToken,
      item_list: items,
    };
    await api.sendMessage({ msg });
    logger.info('File message sent', { toUserId, clientId, fileName });
  }

  return { sendText, sendFile };
}

/**
 * Decode the server-issued AES key into a 16-byte Buffer.
 * Mirrors cdn.ts download-side logic so upload and download use the same
 * convention regardless of which encoding the bot returns.
 */
function decodeAesKey(serverKey: string): Buffer {
  const raw = Buffer.from(serverKey, 'base64');
  if (raw.length === 16) return raw;
  // base64-of-hex-string → decode the inner ascii as hex to 16 bytes
  const hexStr = raw.toString('utf-8');
  return Buffer.from(hexStr, 'hex');
}
