export interface ObjectStorage {
  name: string;
  put(key: string, body: Buffer, mime: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  presignPut(key: string, mime: string, maxBytes: number, ttlSec?: number): Promise<string>;
  presignGet(key: string, ttlSec: number): Promise<string>;
  remove(key: string): Promise<void>;
  publicUrl(key: string): string;
}
