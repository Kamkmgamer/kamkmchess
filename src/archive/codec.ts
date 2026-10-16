export class ArchiveError extends Error {
  constructor(
    readonly code: 'invalid-archive' | 'credential-echo' | 'digest-unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'ArchiveError';
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) {
    throw new ArchiveError('digest-unavailable', 'This browser cannot verify archive chunk digests.');
  }

  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await cryptoApi.subtle.digest('SHA-256', copy.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const piece = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    binary += String.fromCharCode(...piece);
  }
  return btoa(binary);
}

export function decodeBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new ArchiveError('invalid-archive', 'The archive contains invalid base64 chunk data.');
  }

  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new ArchiveError('invalid-archive', 'The archive contains invalid base64 chunk data.');
  }

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  if (encodeBase64(bytes) !== value) {
    throw new ArchiveError('invalid-archive', 'The archive contains non-canonical base64 chunk data.');
  }
  return bytes;
}
