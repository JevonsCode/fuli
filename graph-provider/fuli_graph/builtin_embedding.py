"""A small embedding model run on this computer (search by meaning without a
model service).

The person picks a model from FULI's catalog; Node downloads its three data
files (config.json, vocab.txt, model.safetensors), checks their digests and
writes `fuli-model.json` beside them. This module turns texts into vectors
with them. It needs nothing but numpy: a safetensors file is a JSON header
and raw arrays (it cannot carry code), the tokenizer is BERT's WordPiece, and
the network is a plain BERT encoder. Nothing is loaded until the first text
arrives, and one model is kept at a time.
"""
import json
import math
import mmap
import re
import threading
import unicodedata
from pathlib import Path

import numpy as np

MODEL_ID = re.compile(r'[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?')
SPEC_FILE = 'fuli-model.json'
MAX_HEADER_BYTES = 8 * 1024 * 1024
MAX_WORD_CHARS = 100
# No array of a small encoder has more axes or a longer axis than this.
MAX_DIMENSIONS = 4
MAX_AXIS = 1_000_000
# What the catalog's models stay well inside; a config beyond it is not one FULI runs.
MAX_LAYERS = 48
MAX_HEADS = 64
MAX_POSITIONS = 8192
BATCH = 16
_DTYPES = {'F32': np.float32, 'F16': np.float16, 'F64': np.float64, 'I64': np.int64, 'I32': np.int32}


class BuiltinEmbeddingError(Exception):
    """The model is not on this computer, or its files are not ones this module runs."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def read_safetensors(path: Path) -> dict[str, np.ndarray]:
    """Every array of a safetensors file as float32 (integers as they are),
    read through a memory map, so pages the model never touches stay on disk."""
    try:
        with open(path, 'rb') as handle:
            mapped = mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ)
    except (OSError, ValueError) as error:
        # An empty file cannot be mapped.
        raise BuiltinEmbeddingError('model_invalid', 'The model file is empty or cannot be read') from error
    arrays: dict[str, np.ndarray] = {}
    try:
        if len(mapped) < 8:
            raise BuiltinEmbeddingError('model_invalid', 'The model file is too short')
        header_bytes = int.from_bytes(mapped[:8], 'little')
        if not 2 <= header_bytes <= min(MAX_HEADER_BYTES, len(mapped) - 8):
            raise BuiltinEmbeddingError('model_invalid', 'The model file has no readable header')
        try:
            header = json.loads(mapped[8:8 + header_bytes].decode('utf-8'))
        except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as error:
            raise BuiltinEmbeddingError('model_invalid', 'The model file has no readable header') from error
        if not isinstance(header, dict):
            raise BuiltinEmbeddingError('model_invalid', 'The model file has no readable header')
        start = 8 + header_bytes
        for name, entry in header.items():
            if name == '__metadata__':
                continue
            if not isinstance(entry, dict):
                raise BuiltinEmbeddingError('model_invalid', f'The model file describes an array wrongly: {name}')
            dtype = _DTYPES.get(entry.get('dtype'))
            offsets = entry.get('data_offsets')
            shape = entry.get('shape')
            if not (isinstance(offsets, list) and len(offsets) == 2 and all(type(value) is int for value in offsets)
                    and isinstance(shape, list) and len(shape) <= MAX_DIMENSIONS
                    and all(type(size) is int and 0 < size <= MAX_AXIS for size in shape)):
                raise BuiltinEmbeddingError('model_invalid', f'The model file describes an array wrongly: {name}')
            begin, end = offsets
            shape = tuple(shape)
            if dtype is None or not 0 <= begin <= end <= len(mapped) - start:
                raise BuiltinEmbeddingError('model_invalid', f'The model file holds an array this version cannot read: {name}')
            count = int(np.prod(shape)) if shape else 1
            if count * np.dtype(dtype).itemsize != end - begin:
                raise BuiltinEmbeddingError('model_invalid', f'The model file holds an array of the wrong size: {name}')
            array = np.frombuffer(mapped, dtype=dtype, count=count, offset=start + begin).reshape(shape)
            arrays[name] = array.astype(np.float32) if dtype in (np.float16, np.float64) else array
        return arrays
    except BaseException:
        # A file that is refused is let go at once: Windows keeps a mapped file from being replaced.
        arrays.clear()
        try:
            mapped.close()
        except BufferError:
            pass
        raise


class WordPiece:
    """BERT's tokenizer: clean the text, put spaces around CJK characters and
    punctuation, optionally lowercase and strip accents, then split each word
    into the longest pieces the vocabulary holds. Some models lowercase the
    text but keep its accents, so the two are set apart."""

    def __init__(self, vocabulary: list[str], lowercase: bool, strip_accents: bool):
        self.ids = {token: index for index, token in enumerate(vocabulary)}
        self.lowercase = lowercase
        self.strip_accents = strip_accents
        for token in ('[UNK]', '[CLS]', '[SEP]', '[PAD]'):
            if token not in self.ids:
                raise BuiltinEmbeddingError('model_invalid', f'The vocabulary has no {token}')
        self.unknown, self.cls, self.sep, self.pad = (self.ids[token] for token in ('[UNK]', '[CLS]', '[SEP]', '[PAD]'))

    def encode(self, text: str, limit: int) -> list[int]:
        pieces = []
        for word in self._words(text):
            pieces.extend(self._pieces(word))
            if len(pieces) >= limit - 2:
                break
        return [self.cls, *pieces[:limit - 2], self.sep]

    def _words(self, text: str) -> list[str]:
        spaced = []
        for char in text:
            code = ord(char)
            if code in (0, 0xFFFD) or _is_control(char):
                continue
            if _is_cjk(code):
                spaced.extend((' ', char, ' '))
            else:
                spaced.append(' ' if _is_space(char) else char)
        words = []
        for word in ''.join(spaced).split():
            if self.lowercase:
                word = word.lower()
            if self.strip_accents:
                word = ''.join(char for char in unicodedata.normalize('NFD', word) if unicodedata.category(char) != 'Mn')
            current = []
            for char in word:
                if _is_punctuation(char):
                    if current:
                        words.append(''.join(current))
                        current = []
                    words.append(char)
                else:
                    current.append(char)
            if current:
                words.append(''.join(current))
        return words

    def _pieces(self, word: str) -> list[int]:
        if len(word) > MAX_WORD_CHARS:
            return [self.unknown]
        pieces, start = [], 0
        while start < len(word):
            end, found = len(word), None
            while start < end:
                found = self.ids.get(('##' if start else '') + word[start:end])
                if found is not None:
                    break
                end -= 1
            if found is None:
                return [self.unknown]
            pieces.append(found)
            start = end
        return pieces


def _is_space(char: str) -> bool:
    return char in ' \t\n\r' or unicodedata.category(char) == 'Zs'


def _is_control(char: str) -> bool:
    return char not in '\t\n\r' and unicodedata.category(char).startswith('C')


def _is_punctuation(char: str) -> bool:
    code = ord(char)
    return (33 <= code <= 47 or 58 <= code <= 64 or 91 <= code <= 96 or 123 <= code <= 126
            or unicodedata.category(char).startswith('P'))


def _is_cjk(code: int) -> bool:
    return (0x4E00 <= code <= 0x9FFF or 0x3400 <= code <= 0x4DBF or 0x20000 <= code <= 0x2A6DF
            or 0x2A700 <= code <= 0x2B73F or 0x2B740 <= code <= 0x2B81F or 0x2B820 <= code <= 0x2CEAF
            or 0xF900 <= code <= 0xFAFF or 0x2F800 <= code <= 0x2FA1F)


def _erf(values: np.ndarray) -> np.ndarray:
    """Abramowitz and Stegun 7.1.26 (error under 1.5e-7): numpy has no erf."""
    sign = np.sign(values)
    x = np.abs(values)
    t = 1.0 / (1.0 + 0.3275911 * x)
    poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t
    return sign * (1.0 - poly * np.exp(-x * x))


def _gelu(values: np.ndarray) -> np.ndarray:
    return (0.5 * values * (1.0 + _erf(values / math.sqrt(2.0)))).astype(np.float32)


class BertEncoder:
    """A BERT encoder's forward pass over its stored weights."""

    def __init__(self, weights: dict[str, np.ndarray], config: dict):
        prefix = next((name[:-len('embeddings.word_embeddings.weight')] for name in weights
                       if name.endswith('embeddings.word_embeddings.weight')), None)
        if prefix is None or config.get('model_type', 'bert') != 'bert' \
                or config.get('position_embedding_type', 'absolute') != 'absolute' \
                or config.get('hidden_act', 'gelu') != 'gelu':
            raise BuiltinEmbeddingError('model_unsupported', 'Only BERT encoders with absolute positions and GELU are supported')
        self.weights = {name[len(prefix):]: array for name, array in weights.items() if name.startswith(prefix)}
        try:
            self.layers = int(config['num_hidden_layers'])
            self.heads = int(config['num_attention_heads'])
            self.epsilon = float(config.get('layer_norm_eps', 1e-12))
            self.positions = int(config.get('max_position_embeddings', 512))
        except (KeyError, TypeError, ValueError) as error:
            raise BuiltinEmbeddingError('model_invalid', 'The model config lacks its sizes') from error
        # A layer norm divides by sqrt(variance + epsilon): zero, negative or not a number gives no vectors.
        if not 0 < self.epsilon < 1:
            raise BuiltinEmbeddingError('model_invalid', 'The model config has an epsilon no encoder has')
        if not (0 < self.layers <= MAX_LAYERS and 0 < self.heads <= MAX_HEADS and 0 < self.positions <= MAX_POSITIONS):
            raise BuiltinEmbeddingError('model_invalid', 'The model config has sizes no encoder has')
        try:
            words = self._get('embeddings.word_embeddings.weight')
            positions = self._get('embeddings.position_embeddings.weight')
            for layer in range(self.layers):
                self._get(f'encoder.layer.{layer}.output.dense.weight')
        except KeyError as error:
            raise BuiltinEmbeddingError('model_unsupported', f'The model file lacks {error.args[0]}') from error
        if words.ndim != 2 or positions.ndim != 2 or positions.shape[1] != words.shape[1]:
            raise BuiltinEmbeddingError('model_invalid', 'The model file has embeddings of the wrong shape')
        self.hidden = words.shape[1]
        self.vocabulary = words.shape[0]
        # A text is never longer than the positions the file really holds.
        self.positions = min(self.positions, positions.shape[0])
        if self.hidden % self.heads:
            raise BuiltinEmbeddingError('model_invalid', 'The model config does not fit its weights')

    def _get(self, name: str) -> np.ndarray:
        return self.weights[name]

    def _norm(self, values: np.ndarray, name: str) -> np.ndarray:
        gain = self.weights.get(f'{name}.weight', self.weights.get(f'{name}.gamma'))
        bias = self.weights.get(f'{name}.bias', self.weights.get(f'{name}.beta'))
        mean = values.mean(axis=-1, keepdims=True)
        variance = ((values - mean) ** 2).mean(axis=-1, keepdims=True)
        return (values - mean) / np.sqrt(variance + self.epsilon) * gain + bias

    def _dense(self, values: np.ndarray, name: str) -> np.ndarray:
        return values @ self._get(f'{name}.weight').T + self._get(f'{name}.bias')

    def forward(self, token_ids: np.ndarray, mask: np.ndarray) -> np.ndarray:
        """token_ids, mask: (batch, length). Answers (batch, length, hidden)."""
        batch, length = token_ids.shape
        hidden = (self._get('embeddings.word_embeddings.weight')[token_ids]
                  + self._get('embeddings.position_embeddings.weight')[:length]
                  + self._get('embeddings.token_type_embeddings.weight')[0])
        hidden = self._norm(hidden, 'embeddings.LayerNorm')
        width = self.hidden // self.heads
        # Padding never receives attention.
        blocked = ((1.0 - mask)[:, None, None, :] * -1e9).astype(np.float32)

        def split(values):
            return values.reshape(batch, length, self.heads, width).transpose(0, 2, 1, 3)

        for layer in range(self.layers):
            base = f'encoder.layer.{layer}'
            query = split(self._dense(hidden, f'{base}.attention.self.query'))
            key = split(self._dense(hidden, f'{base}.attention.self.key'))
            value = split(self._dense(hidden, f'{base}.attention.self.value'))
            scores = query @ key.transpose(0, 1, 3, 2) / math.sqrt(width) + blocked
            scores = np.exp(scores - scores.max(axis=-1, keepdims=True))
            attention = scores / scores.sum(axis=-1, keepdims=True)
            context = (attention @ value).transpose(0, 2, 1, 3).reshape(batch, length, self.hidden)
            hidden = self._norm(self._dense(context, f'{base}.attention.output.dense') + hidden,
                                f'{base}.attention.output.LayerNorm')
            inner = _gelu(self._dense(hidden, f'{base}.intermediate.dense'))
            hidden = self._norm(self._dense(inner, f'{base}.output.dense') + hidden, f'{base}.output.LayerNorm')
        return hidden


class BuiltinEmbeddingModel:
    """One downloaded model: texts in, unit vectors out."""

    def __init__(self, directory: Path):
        try:
            spec = json.loads((directory / SPEC_FILE).read_text(encoding='utf-8'))
            config = json.loads((directory / 'config.json').read_text(encoding='utf-8'))
            vocabulary = (directory / 'vocab.txt').read_text(encoding='utf-8').split('\n')
        except RecursionError as error:
            raise BuiltinEmbeddingError('model_invalid', 'The model description is nested too deep') from error
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise BuiltinEmbeddingError('model_missing', 'This model is not downloaded on this computer') from error
        if vocabulary and vocabulary[-1] == '':
            vocabulary.pop()
        if not isinstance(spec, dict) or not isinstance(config, dict):
            raise BuiltinEmbeddingError('model_invalid', 'The model description is not an object')
        self.revision = spec.get('revision') if isinstance(spec.get('revision'), str) else ''
        self.pooling = spec.get('pooling')
        if self.pooling not in ('cls', 'mean'):
            raise BuiltinEmbeddingError('model_unsupported', 'Only cls and mean pooling are supported')
        self.tokenizer = WordPiece([token.rstrip('\r') for token in vocabulary], bool(spec.get('lowercase')),
                                   bool(spec.get('stripAccents')))
        if not (directory / 'model.safetensors').is_file():
            raise BuiltinEmbeddingError('model_missing', 'This model is not downloaded on this computer')
        self.encoder = BertEncoder(read_safetensors(directory / 'model.safetensors'), config)
        if len(self.tokenizer.ids) > self.encoder.vocabulary:
            raise BuiltinEmbeddingError('model_invalid', 'The vocabulary is longer than the model knows')
        limit = spec.get('maxTokens')
        self.limit = max(2, min(limit if type(limit) is int and limit > 0 else 512, self.encoder.positions))
        self.dimensions = self.encoder.hidden

    def embed(self, texts: list[str]) -> tuple[list[list[float]], int]:
        """The texts' vectors in order, and how many tokens they were."""
        encoded = [self.tokenizer.encode(text, self.limit) for text in texts]
        vectors: list[list[float] | None] = [None] * len(texts)
        # Similar lengths share a batch, so a short text is not padded to a long one.
        order = sorted(range(len(texts)), key=lambda index: len(encoded[index]))
        for start in range(0, len(order), BATCH):
            chosen = order[start:start + BATCH]
            length = max(len(encoded[index]) for index in chosen)
            ids = np.full((len(chosen), length), self.tokenizer.pad, dtype=np.int64)
            mask = np.zeros((len(chosen), length), dtype=np.float32)
            for row, index in enumerate(chosen):
                ids[row, :len(encoded[index])] = encoded[index]
                mask[row, :len(encoded[index])] = 1.0
            hidden = self.encoder.forward(ids, mask)
            pooled = hidden[:, 0] if self.pooling == 'cls' \
                else (hidden * mask[:, :, None]).sum(axis=1) / mask.sum(axis=1, keepdims=True)
            pooled = pooled / np.maximum(np.linalg.norm(pooled, axis=1, keepdims=True), 1e-12)
            for row, index in enumerate(chosen):
                vectors[index] = [round(float(value), 6) for value in pooled[row]]
        return vectors, sum(len(item) for item in encoded)


def _load(folder: Path) -> BuiltinEmbeddingModel:
    """The model in a folder; files that are not what they claim are one refusal, never a stray error."""
    try:
        return BuiltinEmbeddingModel(folder)
    except BuiltinEmbeddingError:
        raise
    except (ValueError, IndexError, KeyError, TypeError, AttributeError, ZeroDivisionError, OverflowError,
            RecursionError, MemoryError) as error:
        raise BuiltinEmbeddingError('model_invalid', 'The model files are not ones FULI can read') from error


class BuiltinEmbeddings:
    """The models directory; the model last asked for stays loaded."""

    def __init__(self, directory: str | None):
        self.directory = Path(directory) if directory else None
        self._lock = threading.Lock()
        self._loaded: tuple[str, float, BuiltinEmbeddingModel] | None = None

    def embed(self, model_id: str, texts: list[str], revision: str | None = None) -> dict:
        if self.directory is None:
            raise BuiltinEmbeddingError('builtin_unavailable', 'Built-in models are not available in this installation')
        if not MODEL_ID.fullmatch(model_id or ''):
            raise BuiltinEmbeddingError('model_missing', 'This model is not downloaded on this computer')
        folder = self.directory / model_id
        with self._lock:
            try:
                stamp = (folder / SPEC_FILE).stat().st_mtime
            except OSError as error:
                self._loaded = None
                raise BuiltinEmbeddingError('model_missing', 'This model is not downloaded on this computer') from error
            # A model downloaded again (or removed) is read again.
            if not self._loaded or self._loaded[:2] != (model_id, stamp):
                self._loaded = None
                self._loaded = (model_id, stamp, _load(folder))
            model = self._loaded[2]
            # The caller names the revision its index was built with; other files under the id are not that model.
            if revision and not model.revision.startswith(revision):
                raise BuiltinEmbeddingError('model_missing', 'The model on this computer is another revision')
            try:
                vectors, tokens = model.embed(texts)
            except (ValueError, IndexError, KeyError, TypeError, ZeroDivisionError, FloatingPointError, MemoryError) as error:
                # Weights whose shapes do not fit each other only show when they are multiplied.
                self._loaded = None
                raise BuiltinEmbeddingError('model_invalid', 'The model files do not fit together') from error
        return {'model': model_id, 'dimensions': model.dimensions, 'vectors': vectors, 'tokens': tokens}

    def unload(self) -> None:
        with self._lock:
            self._loaded = None
