import { createClient } from '@supabase/supabase-js';

const supabaseUrl        = process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const bucketName         = process.env.SUPABASE_BUCKET_NAME || 'beatmaps';

export const supabase = createClient(supabaseUrl, supabaseServiceKey);

/**
 * Upload a file to the Supabase Storage bucket.
 * @param path   – Destination path inside the bucket (e.g. "maps/123.osz")
 * @param buffer – Raw file contents
 * @returns        The full storage path
 */
export async function uploadFile(
  path: string,
  buffer: Buffer,
  contentType = 'application/octet-stream',
): Promise<string> {
  const { error } = await supabase.storage
    .from(bucketName)
    .upload(path, buffer, {
      contentType,
      upsert: true,
    });

  if (error) throw new Error(`Storage upload failed: ${error.message}`);
  return path;
}

/**
 * Generate a time-limited signed download URL for a file in the bucket.
 * @param path      – File path inside the bucket
 * @param expiresIn – Seconds until the URL expires (default 3600 = 1 hour)
 */
export async function getSignedUrl(
  path: string,
  expiresIn = 3600,
): Promise<string> {
  const { data, error } = await supabase.storage
    .from(bucketName)
    .createSignedUrl(path, expiresIn);

  if (error || !data?.signedUrl) {
    throw new Error(`Failed to create signed URL: ${error?.message ?? 'unknown'}`);
  }

  return data.signedUrl;
}

/**
 * Delete a file from the Supabase Storage bucket.
 */
export async function deleteFile(path: string): Promise<void> {
  const { error } = await supabase.storage
    .from(bucketName)
    .remove([path]);

  if (error) throw new Error(`Storage delete failed: ${error.message}`);
}
