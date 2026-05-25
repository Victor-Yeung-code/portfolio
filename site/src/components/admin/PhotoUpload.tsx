import { useMemo, useState } from 'react';
import type { DragEvent } from 'react';
import { adminApi, putSignedObject } from './api';

interface PhotoUploadProps {
  onUploaded: (ids: string[]) => void;
  onError: (message: string) => void;
}

export function PhotoUpload({ onUploaded, onError }: PhotoUploadProps) {
  const [files, setFiles] = useState<File[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileNames = useMemo(() => files.map((file) => file.name).join(', '), [files]);

  const upload = async () => {
    if (files.length === 0) {
      return;
    }

    setUploading(true);
    onError('');

    try {
      const results = await Promise.all(
        files.map(async (file) => {
          const contentType = file.type || contentTypeFor(file.name);
          const uploadUrl = await adminApi.createUploadUrl({
            filename: file.name,
            contentType,
            kind: 'photo'
          });

          await putSignedObject(uploadUrl.url, file, uploadUrl.headers);
          return uploadUrl.id;
        })
      );
      const ids = results.filter((id): id is string => Boolean(id));

      setFiles([]);
      onUploaded(ids);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : 'Upload failed.');
    } finally {
      setUploading(false);
    }
  };

  const selectFiles = (nextFiles: File[]) => {
    setFiles(nextFiles.filter((file) => file.type.startsWith('image/') || isSupportedImageName(file.name)));
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    selectFiles(Array.from(event.dataTransfer.files));
  };

  return (
    <div
      className={dragActive ? 'upload-band is-dragging' : 'upload-band'}
      onDragEnter={(event) => {
        event.preventDefault();
        setDragActive(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
          return;
        }

        setDragActive(false);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
    >
      <label className="file-picker">
        <span>{fileNames || 'Select photos'}</span>
        <input
          accept="image/avif,image/jpeg,image/png,image/tiff,image/webp"
          multiple
          onChange={(event) => selectFiles(Array.from(event.currentTarget.files ?? []))}
          type="file"
        />
      </label>

      <button disabled={uploading || files.length === 0} onClick={() => void upload()} type="button">
        {uploading ? 'Uploading' : 'Upload'}
      </button>
    </div>
  );
}

function isSupportedImageName(filename: string): boolean {
  return ['.avif', '.jpg', '.jpeg', '.png', '.tif', '.tiff', '.webp'].some((extension) =>
    filename.toLowerCase().endsWith(extension)
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
