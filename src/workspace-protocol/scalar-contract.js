import { z } from 'zod';

const MAX_SOURCE_URI_LENGTH = 2_048;
const HTTP_SOURCE_URI_SCHEMES = new Set(['https', 'http']);
const CUSTOM_SOURCE_URI_SCHEMES = new Set([
  'prd',
  'git',
  'github',
  'gitlab',
  'jira',
  'linear',
  'notion',
]);
const ALLOWED_SOURCE_URI_SCHEMES = new Set([
  ...HTTP_SOURCE_URI_SCHEMES,
  ...CUSTOM_SOURCE_URI_SCHEMES,
]);

function parseRawHierarchicalUri(value) {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/]+)(\/.*)?$/u.exec(value);

  if (match === null) {
    return null;
  }

  return {
    scheme: match[1].toLowerCase(),
    authority: match[2],
    path: match[3] ?? '',
  };
}

function isUnsafeRawSourceUri(value, { authority }) {
  return (
    /\p{C}/u.test(value)
    || /\s/u.test(value)
    || value.includes('\\')
    || value.includes('?')
    || value.includes('#')
    || authority.includes('@')
  );
}

function isSafeCustomSourceUri({ authority, path }) {
  return (
    /^[\x21-\x7e]+$/u.test(authority)
    && /^[\x21-\x7e]*$/u.test(path)
    && !authority.includes('%')
    && !path.includes('%')
    && !/^[A-Za-z]:$/u.test(authority)
    && !/^\/[A-Za-z]:(?:\/|$)/u.test(path)
  );
}

function isSafeHttpPath(url) {
  if (/%25/iu.test(url.pathname)) {
    return false;
  }

  let decodedPathname;

  try {
    decodedPathname = decodeURIComponent(url.pathname);
  } catch {
    return false;
  }

  const pathWithoutLeadingSlash = decodedPathname.startsWith('/')
    ? decodedPathname.slice(1)
    : decodedPathname;

  return (
    !/\p{C}/u.test(decodedPathname)
    && !decodedPathname.includes('\\')
    && !/^[A-Za-z]:(?:[\\/]|$)/u.test(pathWithoutLeadingSlash)
  );
}

export const idSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => !/(?:\s|\p{C})/u.test(value));

export const cursorSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !/(?:\s|\p{C})/u.test(value));

export const revisionSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,19})$/);

export const timestampSchema = z
  .string()
  .min(20)
  .max(35)
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/,
  )
  .pipe(z.iso.datetime({ offset: true }));

export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const sourceUriSchema = z
  .string()
  .min(1)
  .max(MAX_SOURCE_URI_LENGTH)
  .transform((value, context) => {
    const rawUri = parseRawHierarchicalUri(value);

    if (
      rawUri === null
      || !ALLOWED_SOURCE_URI_SCHEMES.has(rawUri.scheme)
      || isUnsafeRawSourceUri(value, rawUri)
      || (
        CUSTOM_SOURCE_URI_SCHEMES.has(rawUri.scheme)
        && !isSafeCustomSourceUri(rawUri)
      )
      || (
        HTTP_SOURCE_URI_SCHEMES.has(rawUri.scheme)
        && /%(?![0-9A-Fa-f]{2})/u.test(value)
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Expected an allowed absolute source URI',
      });
      return z.NEVER;
    }

    let uri;

    try {
      uri = new URL(value);
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'Expected a valid absolute URI',
      });
      return z.NEVER;
    }

    if (
      uri.username !== ''
      || uri.password !== ''
      || uri.search !== ''
      || uri.hash !== ''
      || uri.host === ''
      || (
        HTTP_SOURCE_URI_SCHEMES.has(rawUri.scheme)
        && !isSafeHttpPath(uri)
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Expected a non-local URI without credentials, query, or fragment',
      });
      return z.NEVER;
    }

    const canonicalUri = uri.href;
    const canonicalRawUri = parseRawHierarchicalUri(canonicalUri);

    if (
      canonicalUri.length > MAX_SOURCE_URI_LENGTH
      || canonicalRawUri === null
      || (
        CUSTOM_SOURCE_URI_SCHEMES.has(rawUri.scheme)
        && !isSafeCustomSourceUri(canonicalRawUri)
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Canonical source URI exceeds the maximum length',
      });
      return z.NEVER;
    }

    try {
      new URL(canonicalUri);
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'Canonical source URI must remain parseable',
      });
      return z.NEVER;
    }

    return canonicalUri;
  });
