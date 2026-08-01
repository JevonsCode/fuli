import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, relative, resolve, sep } from 'node:path';

const DEFAULT_EXTENSIONS = ['.md', '.mdx', '.txt'];
const DEFAULT_MAX_FILES = 5_000;
const DEFAULT_MAX_FILE_BYTES = 1_000_000;

export default {
  async check({ source }) {
    const roots = configuredRoots(source);
    for (const root of roots) {
      const details = await stat(root.path);
      if (!details.isDirectory()) {
        throw new TypeError(`Markdown root is not a directory: ${root.id}`);
      }
    }
    return {
      status: 'ready',
      capabilities: ['discover', 'sync', 'retrieve'],
      roots: roots.map(({ id }) => id)
    };
  },

  async discover({ source, query, cursor, limit }) {
    const documents = await readDocuments(source, { includeContent: false });
    const normalizedQuery = String(query ?? '').trim().toLocaleLowerCase();
    const matches = normalizedQuery
      ? documents.filter((item) =>
          `${item.title}\n${item.metadata.relativePath}`
            .toLocaleLowerCase()
            .includes(normalizedQuery)
        )
      : documents;
    const offset = cursorOffset(cursor);
    const pageSize = boundedLimit(limit);
    const items = matches.slice(offset, offset + pageSize);
    const nextOffset = offset + items.length;
    return {
      items: items.map(({ content: _content, ...item }) => ({ ...item, type: 'document' })),
      nextCursor: nextOffset < matches.length ? String(nextOffset) : null,
      hasMore: nextOffset < matches.length
    };
  },

  async sync({ source, cursor, limit }) {
    const documents = await readDocuments(source, { includeContent: true });
    const offset = cursorOffset(cursor);
    const pageSize = boundedLimit(limit);
    const items = documents.slice(offset, offset + pageSize);
    const nextOffset = offset + items.length;
    return {
      items,
      deleted: [],
      nextCursor: nextOffset < documents.length ? String(nextOffset) : null,
      hasMore: nextOffset < documents.length
    };
  },

  async retrieve({ source, query, limit }) {
    const terms = searchTerms(query);
    const documents = await readDocuments(source, { includeContent: true });
    const items = documents
      .map((document) => ({ document, score: documentScore(document, terms) }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score ||
        left.document.id.localeCompare(right.document.id))
      .slice(0, boundedLimit(limit))
      .map(({ document, score }) => ({
        ...document,
        metadata: { ...document.metadata, retrievalScore: score }
      }));
    return { items };
  }
};

async function readDocuments(source, { includeContent }) {
  const roots = configuredRoots(source);
  const extensions = configuredExtensions(source?.extensions);
  const maximumFiles = boundedInteger(
    source?.maxFiles,
    DEFAULT_MAX_FILES,
    1,
    20_000,
    'maxFiles'
  );
  const maximumBytes = boundedInteger(
    source?.maxFileBytes,
    DEFAULT_MAX_FILE_BYTES,
    1_024,
    DEFAULT_MAX_FILE_BYTES,
    'maxFileBytes'
  );
  const files = [];
  for (const root of roots) {
    await walk(root.path, files, maximumFiles, extensions, root);
    if (files.length >= maximumFiles) break;
  }
  files.sort((left, right) => left.path.localeCompare(right.path));

  const documents = [];
  for (const file of files.slice(0, maximumFiles)) {
    const details = await stat(file.path);
    if (!details.isFile() || details.size > maximumBytes) continue;
    const content = includeContent ? await readFile(file.path, 'utf8') : '';
    if (includeContent && !content.trim()) continue;
    const relativePath = portablePath(relative(file.root.path, file.path));
    documents.push({
      id: `${file.root.id}:${relativePath}`,
      title: markdownTitle(content) ?? basename(relativePath, extname(relativePath)),
      content,
      url: onlineDocumentUrl(file.root.webBaseUrl, relativePath),
      updatedAt: details.mtime.toISOString(),
      metadata: {
        sourceId: file.root.id,
        relativePath,
        extension: extname(relativePath).toLocaleLowerCase(),
        bytes: details.size
      }
    });
  }
  return documents;
}

async function walk(directory, files, maximumFiles, extensions, root = null) {
  const activeRoot = root ?? { path: directory };
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (files.length >= maximumFiles) return;
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(path, files, maximumFiles, extensions, activeRoot);
    } else if (entry.isFile() && extensions.has(extname(entry.name).toLocaleLowerCase())) {
      files.push({ path, root: activeRoot });
    }
  }
}

function configuredRoots(source) {
  if (!Array.isArray(source?.roots) || source.roots.length === 0 || source.roots.length > 16) {
    throw new TypeError('Markdown source requires between 1 and 16 roots');
  }
  const ids = new Set();
  return source.roots.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('Each Markdown root must be an object');
    }
    const id = requiredString(value.id, 'Markdown root id');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(id) || ids.has(id)) {
      throw new TypeError('Markdown root ids must be unique stable identifiers');
    }
    ids.add(id);
    const path = resolve(requiredString(value.path, `Markdown root ${id} path`));
    return {
      id,
      path,
      webBaseUrl: optionalOnlineUrl(value.webBaseUrl)
    };
  });
}

function configuredExtensions(value) {
  const values = value ?? DEFAULT_EXTENSIONS;
  if (!Array.isArray(values) || values.length === 0 ||
      values.some((item) => typeof item !== 'string' || !/^\.[a-z0-9]+$/iu.test(item))) {
    throw new TypeError('Markdown extensions must be a nonempty array such as [".md", ".mdx"]');
  }
  return new Set(values.map((item) => item.toLocaleLowerCase()));
}

function markdownTitle(content) {
  if (!content) return null;
  const match = content.match(/^#\s+(.+)$/mu);
  return match?.[1]?.replace(/\s+#+\s*$/u, '').trim() || null;
}

function searchTerms(value) {
  const terms = String(value ?? '').toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  if (!terms.length) throw new TypeError('Markdown retrieval query is required');
  return [...new Set(terms)].slice(0, 20);
}

function documentScore(document, terms) {
  const title = document.title.toLocaleLowerCase();
  const path = document.metadata.relativePath.toLocaleLowerCase();
  const content = document.content.toLocaleLowerCase();
  return terms.reduce((score, term) => score +
    (title.includes(term) ? 8 : 0) +
    (path.includes(term) ? 4 : 0) +
    Math.min(content.split(term).length - 1, 8), 0);
}

function onlineDocumentUrl(base, relativePath) {
  if (!base) return null;
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/$/u, '')}/${relativePath}`;
  return url.toString();
}

function optionalOnlineUrl(value) {
  if (value === undefined || value === null || value === '') return null;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new TypeError('Markdown root webBaseUrl must be an HTTP(S) URL without credentials');
  }
  return url.toString();
}

function cursorOffset(value) {
  if (value === undefined || value === null || value === '') return 0;
  if (!/^\d+$/u.test(value)) throw new TypeError('Markdown cursor is invalid');
  return Number(value);
}

function boundedLimit(value) {
  return boundedInteger(value, 50, 1, 100, 'limit');
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new TypeError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return resolved;
}

function portablePath(value) {
  return sep === '/' ? value : value.split(sep).join('/');
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required`);
  return value.trim();
}
