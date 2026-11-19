// The two outside systems the simulator touches, behind small interfaces so the
// actions can be tested with fakes and so dry-run can strip every write:
//
//   aws  stackOutputs(stackName) · secret(id) · list(bucket, prefix, {maxPages}) · get(bucket, key)
//        getObject(bucket, key) -> { body, etag } | null (a whole state document, read before a merge)
//        put(bucket, key, body, contentType, { ifMatch, ifNoneMatch }) · deleteMany(bucket, keys)
//   git  branch() · status() · diffNames(paths) · add(paths) · stagedChanged(paths)
//        commit(message) · push() · head()
//
// The real AWS layer uses the operator's own credentials (default chain). Every call
// carries a timeout, every listing a page cap: nothing here can wait or loop without end.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { readStackOutputs } from '../stack.js';

const run = promisify(execFile);
export const AWS_CALL_TIMEOUT_MS = 60_000;
export const GIT_CALL_TIMEOUT_MS = 120_000;
export const MAX_LIST_PAGES = 100; // 100,000 keys per prefix
export const MAX_GET_BYTES = 4 * 1024 * 1024;
export const MAX_STATE_BYTES = 64 * 1024 * 1024;

export async function createAwsLayer({ region = process.env.AWS_REGION ?? 'us-east-1' } = {}) {
  const s3mod = await import('@aws-sdk/client-s3');
  const smmod = await import('@aws-sdk/client-secrets-manager');
  const s3 = new s3mod.S3Client({ region });
  const sm = new smmod.SecretsManagerClient({ region });
  const opts = () => ({ abortSignal: AbortSignal.timeout(AWS_CALL_TIMEOUT_MS) });
  return {
    writes: true,
    stackOutputs: (stackName) => readStackOutputs(stackName, { region }),
    async secret(id) {
      return (await sm.send(new smmod.GetSecretValueCommand({ SecretId: id }), opts())).SecretString;
    },
    async list(bucket, prefix, { maxPages = MAX_LIST_PAGES } = {}) {
      const keys = [];
      let token;
      let pages = 0;
      do {
        const out = await s3.send(new s3mod.ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }), opts());
        for (const o of out.Contents ?? []) keys.push({ key: o.Key, size: o.Size ?? 0 });
        token = out.IsTruncated ? out.NextContinuationToken : undefined;
        pages += 1;
      } while (token && pages < maxPages);
      return { keys, truncated: !!token };
    },
    async get(bucket, key) {
      const out = await s3.send(new s3mod.GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=0-${MAX_GET_BYTES - 1}` }), opts());
      const body = Buffer.from(await out.Body.transformToByteArray());
      return key.endsWith('.gz') ? gunzipSync(body) : body;
    },
    async getObject(bucket, key) {
      try {
        const out = await s3.send(new s3mod.GetObjectCommand({ Bucket: bucket, Key: key }), opts());
        if ((out.ContentLength ?? 0) > MAX_STATE_BYTES) throw new Error(`s3://${bucket}/${key} is larger than ${MAX_STATE_BYTES} bytes`);
        return { body: Buffer.from(await out.Body.transformToByteArray()), etag: out.ETag ?? null };
      } catch (error) {
        if (error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) return null;
        throw error;
      }
    },
    async put(bucket, key, body, contentType, { ifMatch, ifNoneMatch } = {}) {
      await s3.send(new s3mod.PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType, IfMatch: ifMatch, IfNoneMatch: ifNoneMatch }), opts());
    },
    async deleteMany(bucket, keys) {
      if (keys.length > 1000) throw new Error('deleteMany takes at most 1000 keys');
      const out = await s3.send(new s3mod.DeleteObjectsCommand({
        Bucket: bucket, Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
      }), opts());
      if (out.Errors?.length) throw new Error(`S3 refused to delete ${out.Errors.length} object(s), first: ${out.Errors[0].Key}: ${out.Errors[0].Message}`);
      return keys.length;
    },
  };
}

export function createGitLayer(repo) {
  const git = async (...args) => (await run('git', ['-C', repo, ...args], { timeout: GIT_CALL_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 })).stdout;
  return {
    writes: true,
    repo,
    branch: async () => (await git('rev-parse', '--abbrev-ref', 'HEAD')).trim(),
    status: async () => (await git('status', '--porcelain=v1', '--untracked-files=all')).split('\n').filter(Boolean),
    add: async (paths) => { await git('add', '--', ...paths); },
    stagedChanged: async (paths) => (await git('diff', '--cached', '--name-only', '--', ...paths)).split('\n').filter(Boolean),
    commit: async (message) => { await git('commit', '-m', message); },
    push: async () => { await git('push', 'origin', 'main'); },
    head: async () => (await git('rev-parse', '--short', 'HEAD')).trim(),
  };
}

/** The cloud simulator's git layer: it never publishes, so every call says so instead of running git. */
export function noGitLayer() {
  const refuse = async () => { throw new Error("git is not available in the simulator deployed in AWS: publish from the local simulator"); };
  return { writes: false, repo: null, branch: refuse, status: refuse, add: refuse, stagedChanged: refuse, commit: refuse, push: refuse, head: refuse };
}
