"""A tiny synthetic BERT for the built-in embedding tests: a vocabulary of a
few words and weights from a formula, written in the same files a downloaded
model has. No real model, no download."""
import json
import math
import struct
from pathlib import Path

VOCABULARY = ['[PAD]', '[UNK]', '[CLS]', '[SEP]', '你', '好', '世', '界', 'hello', 'world', '##s', 'fuli',
              ',', '!', 'cafe', 'café', '2828', '端', '口', 'port', '##ing', 'test']
CONFIG = {
    'model_type': 'bert', 'hidden_size': 16, 'num_hidden_layers': 2, 'num_attention_heads': 2,
    'intermediate_size': 32, 'max_position_embeddings': 24, 'type_vocab_size': 2, 'vocab_size': len(VOCABULARY),
    'hidden_act': 'gelu', 'layer_norm_eps': 1e-12, 'position_embedding_type': 'absolute',
}


def _values(count: int, seed: int) -> list[float]:
    # Plain arithmetic, so every platform writes the same weights.
    return [round(0.35 * math.sin(0.7310 * index + 1.37 * seed) + 0.15 * math.cos(0.113 * index * seed + 0.5), 6)
            for index in range(count)]


def tensors() -> dict[str, tuple[tuple[int, ...], list[float]]]:
    hidden, inner = CONFIG['hidden_size'], CONFIG['intermediate_size']
    shapes = {
        'embeddings.word_embeddings.weight': (CONFIG['vocab_size'], hidden),
        'embeddings.position_embeddings.weight': (CONFIG['max_position_embeddings'], hidden),
        'embeddings.token_type_embeddings.weight': (CONFIG['type_vocab_size'], hidden),
        'embeddings.LayerNorm.weight': (hidden,), 'embeddings.LayerNorm.bias': (hidden,),
    }
    for layer in range(CONFIG['num_hidden_layers']):
        base = f'encoder.layer.{layer}'
        for part in ('attention.self.query', 'attention.self.key', 'attention.self.value', 'attention.output.dense'):
            shapes[f'{base}.{part}.weight'] = (hidden, hidden)
            shapes[f'{base}.{part}.bias'] = (hidden,)
        shapes[f'{base}.attention.output.LayerNorm.weight'] = (hidden,)
        shapes[f'{base}.attention.output.LayerNorm.bias'] = (hidden,)
        shapes[f'{base}.intermediate.dense.weight'] = (inner, hidden)
        shapes[f'{base}.intermediate.dense.bias'] = (inner,)
        shapes[f'{base}.output.dense.weight'] = (hidden, inner)
        shapes[f'{base}.output.dense.bias'] = (hidden,)
        shapes[f'{base}.output.LayerNorm.weight'] = (hidden,)
        shapes[f'{base}.output.LayerNorm.bias'] = (hidden,)
    result = {}
    for seed, (name, shape) in enumerate(shapes.items(), 1):
        count = math.prod(shape)
        values = _values(count, seed)
        if name.endswith('LayerNorm.weight'):
            values = [1.0 + value for value in values]
        result[name] = (shape, values)
    return result


def write_safetensors(path: Path, arrays: dict[str, tuple[tuple[int, ...], list[float]]]) -> None:
    header, body, offset = {}, [], 0
    for name, (shape, values) in arrays.items():
        data = struct.pack(f'<{len(values)}f', *values)
        header[name] = {'dtype': 'F32', 'shape': list(shape), 'data_offsets': [offset, offset + len(data)]}
        body.append(data)
        offset += len(data)
    encoded = json.dumps(header).encode('utf-8')
    path.write_bytes(struct.pack('<Q', len(encoded)) + encoded + b''.join(body))


def write_model(directory: Path, *, pooling: str = 'cls', lowercase: bool = True, strip_accents: bool = True,
                max_tokens: int = 24) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    (directory / 'config.json').write_text(json.dumps(CONFIG), encoding='utf-8')
    (directory / 'vocab.txt').write_text('\n'.join(VOCABULARY) + '\n', encoding='utf-8')
    write_safetensors(directory / 'model.safetensors', tensors())
    (directory / 'fuli-model.json').write_text(json.dumps({
        'pooling': pooling, 'lowercase': lowercase, 'stripAccents': strip_accents, 'maxTokens': max_tokens}), encoding='utf-8')
    return directory
