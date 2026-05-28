import apiClient from "../api/client";
import { API_ROUTES } from "../api/routes";

export interface UploadInput {
  /** Original filename (used to build a safe key + extension). */
  filename: string;
  /** MIME type sent to the server and used as PUT Content-Type. */
  mimeType: string;
  /** File contents — already in a platform-neutral shape. */
  body: Blob | ArrayBuffer | Uint8Array;
  /** Pre-computed byte size; falls back to body length when omitted. */
  size?: number;
}

export interface UploadResult {
  fileUrl: string;
  bytes: number;
}

interface PresignResponse {
  mode: "spaces" | "local";
  uploadUrl: string;
  fileUrl: string;
  headers?: Record<string, string>;
}

function bodyToBlob(body: Blob | ArrayBuffer | Uint8Array, mimeType: string): Blob {
  if (typeof Blob !== "undefined" && body instanceof Blob) return body;
  if (body instanceof Uint8Array) {
    const ab = body.buffer.slice(
      body.byteOffset,
      body.byteOffset + body.byteLength,
    ) as ArrayBuffer;
    return new Blob([ab], { type: mimeType });
  }
  return new Blob([body], { type: mimeType });
}

function bodyByteLength(body: Blob | ArrayBuffer | Uint8Array): number {
  if (typeof Blob !== "undefined" && body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (body instanceof Uint8Array) return body.byteLength;
  return 0;
}

/**
 * Two-step upload:
 *   1. POST /uploads/presign with metadata.
 *   2. PUT bytes to the returned URL.
 *
 * Works against both DigitalOcean Spaces (presigned PUT) and the local-disk
 * fallback the API ships when SPACES_* env vars are absent. Returns the final
 * public URL — callers persist it on a block's `content.url`.
 */
export async function uploadFile(input: UploadInput): Promise<UploadResult> {
  const size = input.size ?? bodyByteLength(input.body);
  const presign = await apiClient.post<PresignResponse>(
    API_ROUTES.uploads.presign,
    {
      filename: input.filename,
      mimeType: input.mimeType,
      size,
    },
  );

  const { uploadUrl, fileUrl, headers } = presign.data;
  const blob = bodyToBlob(input.body, input.mimeType);

  // Use raw fetch — axios would add its default JSON Content-Type and the
  // Authorization header, which Spaces / S3 reject.
  const putResponse = await fetch(uploadUrl, {
    method: "PUT",
    body: blob,
    headers: headers ?? { "Content-Type": input.mimeType },
  });
  if (!putResponse.ok) {
    throw new Error(
      `Upload failed (${putResponse.status} ${putResponse.statusText})`,
    );
  }

  return { fileUrl, bytes: size };
}

interface EmbedPreviewResponse {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  favicon?: string;
  source?: string;
}

/**
 * Fetch OpenGraph-ish metadata for a URL. Backend caches; client may call this
 * eagerly when a user pastes a URL into a bookmark / embed block.
 */
export async function fetchEmbedPreview(
  url: string,
): Promise<EmbedPreviewResponse> {
  const res = await apiClient.post<EmbedPreviewResponse>(
    API_ROUTES.embed.preview,
    { url },
  );
  return res.data;
}
