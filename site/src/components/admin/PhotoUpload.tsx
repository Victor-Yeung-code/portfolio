import { useMemo, useState } from 'react';
import { adminApi, putSignedObject } from './api';

interface PhotoUploadProps {
  onUploaded: (ids: string[]) => void;
  onError: (message: string) => void;
}

export function PhotoUpload({ onUploaded, onError }: PhotoUploadProps) {
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileNames = useMemo(() => files.map((file) => file.name).join(', '), [files]);

  const upload = async () => {
    if (files.length === 0) {
      return;
    }

    setUploading(true);
    onError('');

    try {
      const ids: string[] = [];

      for (const file of files) {
        const contentType = file.type || contentTypeFor(file.name);
        const uploadUrl = await adminApi.createUploadUrl({
          filename: file.name,
          contentType,
          kind: 'photo'
        });

        await putSignedObject(uploadUrl.url, file, uploadUrl.headers);
        if (uploadUrl.id) {
          ids.push(uploadUrl.id);
        }
      }

      setFiles([]);
      onUploaded(ids);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : 'Upload failed.');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="upload-band">
      <label className="file-picker">
        <span>{fileNames || 'Select photos'}</span>
        <input
          accept="image/avif,image/jpeg,image/png,image/tiff,image/webp"
          multiple
          onChange={(event) => setFiles(Array.from(event.currentTarget.files ?? []))}
          type="file"
        />
      </label>

      <button disabled={uploading || files.length === 0} onClick={() => void upload()} type="button">
        {uploading ? 'Uploading' : 'Upload'}
      </button>
    </div>
  );
}

function contentTypeFor(filename: string): string {
  const extension = filename.slice(filename.lastIndexOf('.')).toLowerCase();

  switch (extension) {
    case '.avif':
      return 'image/avif';
    case '.png':
      return 'image/png';
    case '.tif':
    case '.tiff':
      return 'image/tiff';
    case '.webp':
      return 'image/webp';
    default:
      return 'image/jpeg';
  }
}
