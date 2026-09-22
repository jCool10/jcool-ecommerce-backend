export {
  OBJECT_STORAGE,
  ObjectStorageNotConfiguredError,
  type ObjectStoragePort,
  type PresignedUpload,
  type StoredObjectHead,
} from './object-storage.port';
export { S3ObjectStorageAdapter, type S3ObjectStorageOptions } from './s3-object-storage.adapter';
export { StorageModule, createObjectStorage } from './storage.module';
