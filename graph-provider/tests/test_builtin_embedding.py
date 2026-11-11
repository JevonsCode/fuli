"""The built-in embedding model (builtin_embedding.py) against a tiny synthetic
BERT. The expected token ids and vectors were computed once with the reference
implementation (transformers BertModel and BertTokenizer) on these same files."""
import json
import os
from typing import Annotated

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from builtin_embedding_fixture import write_model
from fuli_graph.builtin_embedding import BuiltinEmbeddingError, BuiltinEmbeddingModel, BuiltinEmbeddings, WordPiece
from fuli_graph.builtin_embedding_routes import register_builtin_embedding_routes

TEXTS = ['你好 世界', 'Hello worlds, FULI!', 'Café testing 端口 2828 unknownword', '']
REFERENCE_IDS = [
    [2, 4, 5, 6, 7, 3],
    [2, 8, 9, 10, 12, 11, 13, 3],
    [2, 14, 21, 20, 17, 18, 16, 1, 3],
    [2, 3],
]
REFERENCE_CLS = [
    [0.21043, 0.2244, -0.29879, -0.3148, 0.25907, 0.07647, -0.36791, -0.03118, 0.10372, -0.20599, -0.28928, 0.22103, 0.42891, -0.22747, -0.07392, 0.28424],
    [-0.00529, 0.29944, 0.09703, -0.4627, -0.14608, 0.23882, -0.10159, -0.2235, 0.1392, 0.26126, -0.27894, -0.26349, 0.43198, 0.0415, -0.29523, 0.19442],
    [0.06176, 0.28757, -0.04185, -0.49706, -0.00925, 0.28259, -0.17526, -0.18621, 0.1447, 0.14682, -0.32619, -0.14071, 0.48324, -0.03245, -0.26468, 0.21453],
    [0.12345, 0.28098, -0.18777, -0.45712, 0.15481, 0.21764, -0.2949, -0.09109, 0.14908, -0.04117, -0.32752, 0.0678, 0.48644, -0.16455, -0.20024, 0.23541],
]
REFERENCE_MEAN = [
    [0.18897, 0.23776, -0.26548, -0.35203, 0.23577, 0.14517, -0.36849, -0.0656, 0.12834, -0.15646, -0.29632, 0.18028, 0.4426, -0.20417, -0.14027, 0.27945],
    [-0.00492, 0.29234, 0.14744, -0.42511, -0.20752, 0.22367, -0.14102, -0.22127, 0.1357, 0.26699, -0.25589, -0.28845, 0.43093, 0.04453, -0.28553, 0.20622],
    [0.05032, 0.29709, -0.00394, -0.49776, -0.052, 0.25609, -0.18925, -0.17152, 0.1435, 0.15776, -0.31855, -0.16575, 0.48502, -0.03449, -0.25886, 0.22368],
    [0.12234, 0.28063, -0.18777, -0.45764, 0.15446, 0.21778, -0.29483, -0.09086, 0.14949, -0.04027, -0.32723, 0.06808, 0.48673, -0.16453, -0.20052, 0.23507],
]


def test_tokens_and_vectors_equal_the_reference_implementation(tmp_path):
    model = BuiltinEmbeddingModel(write_model(tmp_path / 'tiny'))
    assert [model.tokenizer.encode(text, model.limit) for text in TEXTS] == REFERENCE_IDS
    vectors, tokens = model.embed(TEXTS)
    assert tokens == sum(len(ids) for ids in REFERENCE_IDS)
    assert model.dimensions == 16
    for ours, expected in zip(vectors, REFERENCE_CLS):
        assert ours == pytest.approx(expected, abs=2e-5)
    mean = BuiltinEmbeddingModel(write_model(tmp_path / 'mean', pooling='mean'))
    for ours, expected in zip(mean.embed(TEXTS)[0], REFERENCE_MEAN):
        assert ours == pytest.approx(expected, abs=2e-5)


def test_a_text_gets_the_same_vector_alone_or_in_a_batch_of_other_lengths(tmp_path):
    model = BuiltinEmbeddingModel(write_model(tmp_path / 'tiny'))
    together = model.embed(TEXTS)[0]
    for index, text in enumerate(TEXTS):
        assert model.embed([text])[0][0] == pytest.approx(together[index], abs=1e-5)


def test_the_tokenizer_follows_the_models_own_settings():
    vocabulary = ['[PAD]', '[UNK]', '[CLS]', '[SEP]', 'cafe', 'café', 'hello', '##s', '你', '!']
    ids = lambda lowercase, strip, text, limit=16: WordPiece(vocabulary, lowercase, strip).encode(text, limit)
    assert ids(True, True, 'HELLOs Café!') == [2, 6, 7, 4, 9, 3]
    # Lowercased, accents kept: the word the vocabulary holds with its accent.
    assert ids(True, False, 'Café') == [2, 5, 3]
    assert ids(False, False, 'Hello') == [2, 1, 3], 'a cased word the vocabulary lacks is unknown'
    assert ids(True, True, 'x你\u0000y') == [2, 1, 8, 1, 3], 'CJK characters stand alone; control characters are dropped'
    assert ids(True, True, 'hello ' * 40, limit=8) == [2, 6, 6, 6, 6, 6, 6, 3], 'cut to the limit, ending with [SEP]'
    assert ids(True, True, 'a' * 101) == [2, 1, 3], 'an overlong word is unknown'


def test_a_model_that_is_absent_or_not_runnable_is_refused_by_name(tmp_path):
    models = BuiltinEmbeddings(str(tmp_path))
    for model_id in ('absent', '../tiny', ''):
        with pytest.raises(BuiltinEmbeddingError) as refused:
            models.embed(model_id, ['x'])
        assert refused.value.code == 'model_missing'
    with pytest.raises(BuiltinEmbeddingError) as off:
        BuiltinEmbeddings(None).embed('tiny', ['x'])
    assert off.value.code == 'builtin_unavailable'
    broken = write_model(tmp_path / 'broken')
    (broken / 'model.safetensors').write_bytes(bytes([255]) * 64)
    with pytest.raises(BuiltinEmbeddingError) as invalid:
        models.embed('broken', ['x'])
    assert invalid.value.code == 'model_invalid'
    other = write_model(tmp_path / 'other')
    (other / 'config.json').write_text(json.dumps({'model_type': 'xlm-roberta'}), encoding='utf-8')
    with pytest.raises(BuiltinEmbeddingError) as unsupported:
        models.embed('other', ['x'])
    assert unsupported.value.code == 'model_unsupported'


def test_a_model_downloaded_again_is_read_again(tmp_path):
    models = BuiltinEmbeddings(str(tmp_path))
    write_model(tmp_path / 'tiny')
    first = models.embed('tiny', ['你好'])['vectors'][0]
    models.unload()
    write_model(tmp_path / 'tiny', pooling='mean')
    os.utime(tmp_path / 'tiny' / 'fuli-model.json', (1, 1))
    assert models.embed('tiny', ['你好'])['vectors'][0] != first


def test_the_route_answers_vectors_and_names_what_is_missing(tmp_path):
    write_model(tmp_path / 'tiny')
    application = FastAPI()
    register_builtin_embedding_routes(application, type('Settings', (), {'embedding_models_dir': str(tmp_path)})(),
                                      Annotated[dict, Depends(lambda: {})])
    client = TestClient(application)
    answer = client.post('/v1/builtin-embeddings', json={'model': 'tiny', 'texts': TEXTS})
    assert answer.status_code == 200
    body = answer.json()
    assert (body['model'], body['dimensions'], len(body['vectors']), body['tokens']) == ('tiny', 16, 4, 25)
    assert body['vectors'][0] == pytest.approx(REFERENCE_CLS[0], abs=2e-5)
    missing = client.post('/v1/builtin-embeddings', json={'model': 'absent', 'texts': ['x']})
    assert (missing.status_code, missing.json()['detail']['code']) == (404, 'model_missing')
    assert client.post('/v1/builtin-embeddings', json={'model': 'tiny', 'texts': []}).status_code == 422
    assert client.post('/v1/builtin-embeddings/unload').status_code == 204
